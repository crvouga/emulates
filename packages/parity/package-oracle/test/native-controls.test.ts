import { expect, test } from "bun:test"
import { createClock } from "@crvouga/mockingbird-service"
import { scenarios } from "./scenarios.js"
import { nativeProviders, target } from "./targets.js"

for (const name of nativeProviders) {
  test(`${name}: namespace snapshots restore provider state and derived caches`, async () => {
    const clock = createClock(() => 1700000000000)
    clock.freeze()
    const runtime = await target(name, "http://mock.local", { clock })
    const initial = runtime.snapshot()
    const request = (path: string, init?: RequestInit) =>
      runtime.fetch(new Request(`http://mock.local${path}`, { ...init, redirect: "manual" }))
    const first = await scenarios[name](request)
    clock.advance(86400000)
    runtime.restore(initial)
    expect(await scenarios[name](request)).toEqual(first)
    const other = (path: string, init?: RequestInit) =>
      runtime.fetch(
        new Request(`http://mock.local${path}`, {
          ...init,
          headers: {
            ...Object.fromEntries(new Headers(init?.headers)),
            "x-mockingbird-namespace": "isolated",
          },
          redirect: "manual",
        }),
      )
    expect(await scenarios[name](other)).toEqual(first)
    await runtime.reset("isolated")
    expect(await scenarios[name](other)).toEqual(first)
  }, 30000)
}

test("Vercel: branch mutations and historical reads isolate provider state", async () => {
  const runtime = await target("vercel", "http://mock.local")
  const headers = { authorization: "Bearer test_token_admin", "content-type": "application/json" }
  const initial = runtime.checkpoint()
  runtime.branch("experiment", { at: initial.id })
  const created = await runtime.fetch(
    new Request("http://mock.local/v11/projects", {
      method: "POST",
      headers: { ...headers, "x-mockingbird-branch": "experiment" },
      body: JSON.stringify({ name: "branch-project" }),
    }),
  )
  expect(created.status).toBe(200)
  const list = (extra: Record<string, string>) =>
    runtime
      .fetch(new Request("http://mock.local/v10/projects", { headers: { ...headers, ...extra } }))
      .then((response) => response.json())
  expect(JSON.stringify(await list({}))).not.toContain("branch-project")
  expect(JSON.stringify(await list({ "x-mockingbird-branch": "experiment" }))).toContain(
    "branch-project",
  )
  expect(JSON.stringify(await list({ "x-mockingbird-at": initial.id }))).not.toContain(
    "branch-project",
  )
})

test("Vercel: native clock controls creation timestamps", async () => {
  const clock = createClock(() => 1700000000000)
  clock.freeze()
  const runtime = await target("vercel", "http://mock.local", { clock })
  const create = (name: string) =>
    runtime
      .fetch(
        new Request("http://mock.local/v11/projects", {
          method: "POST",
          headers: { authorization: "Bearer test_token_admin", "content-type": "application/json" },
          body: JSON.stringify({ name }),
        }),
      )
      .then((response) => response.json())
  expect((await create("clock-one")).createdAt).toBe(1700000000000)
  clock.advance(60000)
  expect((await create("clock-two")).createdAt).toBe(1700000060000)
})

test("Vercel: configured fixtures survive resets without duplicating restored state", async () => {
  const runtime = await target("vercel", "http://mock.local", {
    fixtures: { projects: [{ name: "fixture-project" }] },
  })
  const list = () =>
    runtime
      .fetch(
        new Request("http://mock.local/v10/projects", {
          headers: { authorization: "Bearer oracle-probe" },
        }),
      )
      .then((response) => response.json())
  const before = await list()
  expect(JSON.stringify(before)).toContain("fixture-project")
  const snapshot = runtime.snapshot()
  await runtime.reset()
  expect(JSON.stringify(await list())).toContain("fixture-project")
  runtime.restore(snapshot)
  expect(await list()).toEqual(before)
})
