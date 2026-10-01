import { expect, test } from "bun:test"
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Collection, createRuntime } from "@crvouga/mockingbird-service"
import type { ServeTarget } from "./src/cli.js"
import { type FleetTarget, startFleet } from "./src/fleet.js"

function target(name = "fixture"): ServeTarget {
  return {
    name,
    defaultPort: 0,
    create(_values, common) {
      return createRuntime({
        name,
        ...(common.adminKey !== undefined ? { adminKey: common.adminKey } : {}),
        ...(common.seed !== undefined ? { seed: common.seed } : {}),
        ...(common.onLog !== undefined ? { onLog: common.onLog } : {}),
        create(ctx) {
          const records = new Collection<{ value: number; random: number; now: number }>(
            ctx.sqlite,
            ctx.namespace,
            "things",
          )
          return {
            async reset() {
              for (const record of records.list()) records.delete(String(record.value.value))
            },
            async fetch(request) {
              if (request.method === "POST") {
                const value = {
                  value: records.list().length + 1,
                  random: ctx.rng.next(),
                  now: ctx.clock.now(),
                }
                records.insert(String(value.value), value)
                return Response.json(value)
              }
              return Response.json(records.list().map((record) => record.value))
            },
          }
        },
      })
    },
  }
}

const request = (
  fleet: { fetch(request: Request): Promise<Response> },
  path: string,
  body?: unknown,
  key?: string,
) =>
  fleet.fetch(
    new Request(`http://fleet${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        "content-type": "application/json",
        ...(key ? { "x-mockingbird-admin-key": key } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }),
  )

test("ephemeral fleets publish one complete manifest by rename and remove only their own artifacts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mockingbird-ready-"))
  const readyFile = join(dir, "ready.json")
  const connectionsFile = join(dir, "private.json")
  const emitted: unknown[] = []
  const fleet = await startFleet(
    { services: { first: { port: 0 }, second: { port: 0 } } },
    {
      load: async (name) => target(name),
      readyFile,
      connectionsFile,
      onReady: (manifest) => emitted.push(manifest),
    },
  )
  try {
    expect(emitted).toHaveLength(1)
    expect(JSON.parse(await readFile(readyFile, "utf8"))).toEqual(fleet.manifest)
    expect((await stat(connectionsFile)).mode & 0o777).toBe(0o600)
    const endpoints = Object.values(fleet.manifest.services)
    expect(new Set(endpoints.map((endpoint) => endpoint.url)).size).toBe(2)
    for (const endpoint of endpoints) expect((await fetch(endpoint.healthUrl)).ok).toBe(true)
    expect((await fetch(fleet.manifest.healthUrl)).ok).toBe(true)
  } finally {
    await fleet.close()
  }
  expect(await Bun.file(readyFile).exists()).toBe(false)
  expect(await Bun.file(connectionsFile).exists()).toBe(false)
  await rm(dir, { recursive: true })
})

test("failed boot closes earlier listeners, identifies the child and invalidates stale readiness", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mockingbird-failed-"))
  const readyFile = join(dir, "ready.json")
  await writeFile(readyFile, '{"state":"ready","pid":1}')
  const real = target("first")
  const load = async (name: string): Promise<FleetTarget> =>
    name === "bad"
      ? {
          name,
          protocol: "redis",
          defaultPort: 0,
          async start() {
            throw new Error("boot failure")
          },
        }
      : real
  await expect(
    startFleet({ services: { first: { port: 0 }, bad: { port: 0 } } }, { load, readyFile }),
  ).rejects.toThrow("service bad")
  expect(await Bun.file(readyFile).exists()).toBe(false)
  // Rebind the explicitly chosen port after failure to prove that it was released.
  const { listen } = await import("./src/listen.js")
  const occupied = await listen({ fetch: async () => new Response() })
  const port = occupied.port
  await occupied.close()
  await expect(
    startFleet({ services: { first: { port }, bad: { port: 0 } } }, { load }),
  ).rejects.toThrow("service bad")
  const rebound = await listen({ fetch: async () => new Response() }, { port })
  await rebound.close()
  await rm(dir, { recursive: true })
})

test("fleet namespaces replay records, random choices and time; reset clears only the selected namespace", async () => {
  const fleet = await startFleet(
    { services: { fixture: { port: 0 } }, adminKey: "fixture-admin" },
    { load: async () => target() },
  )
  const origin = fleet.manifest.services.fixture?.url as string
  const mutate = async (ns: string) =>
    (await fetch(`${origin}/ns/${ns}/things`, { method: "POST" })).json()
  try {
    expect((await request(fleet, "/__fleet/namespaces/worker-7/reset", {})).status).toBe(401)
    const time = 1_700_000_000_000
    expect(
      (
        await request(
          fleet,
          "/__fleet/clock?namespace=worker-7",
          { set: time, freeze: true },
          "fixture-admin",
        )
      ).ok,
    ).toBe(true)
    await mutate("worker-7")
    await mutate("other")
    const snapshot = (await (
      await request(fleet, "/__fleet/namespaces/worker-7/snapshots", {}, "fixture-admin")
    ).json()) as { id: string }
    const expected = await mutate("worker-7")
    await request(fleet, "/__fleet/clock?namespace=worker-7", { advance: "1h" }, "fixture-admin")
    expect(
      (
        await request(
          fleet,
          `/__fleet/namespaces/worker-7/snapshots/${snapshot.id}/restore`,
          {},
          "fixture-admin",
        )
      ).ok,
    ).toBe(true)
    expect(await mutate("worker-7")).toEqual(expected)
    expect(await (await fetch(`${origin}/ns/other/things`)).json()).toHaveLength(1)
    expect(
      (await request(fleet, "/__fleet/namespaces/worker-7/reset", {}, "fixture-admin")).ok,
    ).toBe(true)
    expect(await (await fetch(`${origin}/ns/worker-7/things`)).json()).toEqual([])
    expect(await (await fetch(`${origin}/ns/other/things`)).json()).toHaveLength(1)
  } finally {
    await fleet.close()
  }
})

test("a rejecting child rolls back earlier mutations and reports the failed service", async () => {
  const good = target("good")
  const bad = {
    ...target("bad"),
    create: async (
      values: Parameters<ServeTarget["create"]>[0],
      common: Parameters<ServeTarget["create"]>[1],
    ) => {
      const runtime = await target("bad").create(values, common)
      runtime.reset = async () => {
        throw new Error("fixture rejection")
      }
      return runtime
    },
  }
  const fleet = await startFleet(
    { services: { good: { port: 0 }, bad: { port: 0 } } },
    { load: async (name) => (name === "good" ? good : bad) },
  )
  try {
    const url = fleet.manifest.services.good?.url as string
    await fetch(`${url}/things`, { method: "POST" })
    const response = await request(fleet, "/__fleet/namespaces/default/reset", {})
    expect(response.status).toBe(500)
    expect(await response.json()).toMatchObject({
      failedService: "bad",
      rolledBack: true,
      rollback: { good: "restored", bad: "restored" },
    })
    expect(await (await fetch(`${url}/things`)).json()).toHaveLength(1)
  } finally {
    await fleet.close()
  }
})

test("two independent fleets have distinct ports and cannot remove a newer process's ready file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mockingbird-concurrent-"))
  const readyFile = join(dir, "ready.json")
  const config = { services: { fixture: { port: 0 } } }
  const first = await startFleet(config, { load: async () => target(), readyFile })
  const second = await startFleet(config, { load: async () => target(), readyFile })
  try {
    expect(first.manifest.services.fixture?.url).not.toBe(second.manifest.services.fixture?.url)
    await first.close()
    expect(JSON.parse(await readFile(readyFile, "utf8")).id).toBe(second.manifest.id)
  } finally {
    await first.close()
    await second.close()
    await rm(dir, { recursive: true })
  }
})
