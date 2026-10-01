import { expect, test } from "bun:test"
import { Redis } from "ioredis"
import { Client } from "pg"
import { type Fleet, type ProtocolTarget, startFleet } from "./src/fleet.js"

const config = {
  services: {
    postgres: {
      protocol: "postgres" as const,
      port: 0,
      namespaces: { "worker-7": "fixture", other: "other" },
    },
    redis: { protocol: "redis" as const, port: 0, namespaces: { "worker-7": 0, other: 0 } },
  },
}
const start = () =>
  startFleet(config, {
    async load(name) {
      // Load source at runtime without checking each service under the adapter's tsconfig.
      const path = `../../service/${name}/src/server.ts`
      const module = (await import(path)) as { serveTarget: ProtocolTarget }
      return module.serveTarget
    },
  })
const endpoint = (fleet: Fleet, service: string, ns = "default"): string => {
  const value = fleet.manifest.services[service]
  if (!value) throw new Error(`missing service ${service}`)
  return (value.namespaces.endpoints as Record<string, string>)[ns] as string
}
const control = (fleet: Fleet, path: string, body: unknown = {}) =>
  fleet.fetch(
    new Request(`http://fleet/__fleet/${path}`, {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    }),
  )
async function sql(url: string, statements: string) {
  const client = new Client({ connectionString: url })
  await client.connect()
  try {
    return await client.query(statements)
  } finally {
    await client.end()
  }
}
async function kv(url: string, run: (client: Redis) => Promise<unknown>) {
  const client = new Redis(url, { retryStrategy: () => null })
  try {
    return await run(client)
  } finally {
    await client.quit()
  }
}

test("Postgres and Redis bind actual protocol endpoints and close all connections", async () => {
  const fleet = await start()
  const pg = new Client({ connectionString: endpoint(fleet, "postgres") })
  const resp = new Redis(endpoint(fleet, "redis"), { retryStrategy: () => null })
  const pgErrors: Error[] = []
  pg.on("error", (error) => pgErrors.push(error))
  resp.on("error", () => {})
  const pgClosed = new Promise<void>((resolve) => pg.once("end", resolve))
  try {
    await pg.connect()
    expect((await pg.query("SELECT 7 AS value")).rows).toEqual([{ value: 7 }])
    expect(await resp.ping()).toBe("PONG")
    expect((await fetch(fleet.manifest.healthUrl)).ok).toBe(true)
    const blocked = resp.blpop("empty", 0).then(
      () => false,
      () => true,
    )

    await fleet.close()
    expect(await blocked).toBe(true)
    await pgClosed
    expect(pgErrors.map((error) => error.message)).toEqual(["Connection terminated unexpectedly"])
    expect(
      await fetch(fleet.manifest.healthUrl).then(
        () => false,
        () => true,
      ),
    ).toBe(true)
  } finally {
    await fleet.close()
    resp.disconnect()
    await pg.end()
  }
})

test("protocol namespace snapshot/reset/restore and clocks leave the other namespace untouched", async () => {
  const fleet = await start()
  const pg = endpoint(fleet, "postgres", "worker-7")
  const resp = endpoint(fleet, "redis", "worker-7")
  try {
    await sql(pg, "CREATE TABLE things (value int); INSERT INTO things VALUES (7)")
    await sql(
      endpoint(fleet, "postgres", "other"),
      "CREATE TABLE things (value int); INSERT INTO things VALUES (9)",
    )
    await kv(resp, (client) => client.set("fixture", "seven", "PX", 1000))
    await kv(endpoint(fleet, "redis", "other"), (client) => client.set("fixture", "nine"))
    const frozen = await control(fleet, "clock?namespace=worker-7", {
      set: Date.now(),
      freeze: true,
    })
    expect(frozen.ok).toBe(true)
    const snapshotResponse = await control(fleet, "namespaces/worker-7/snapshots")
    expect(snapshotResponse.status).toBe(201)
    const point = (await snapshotResponse.json()) as { id: string }
    await sql(pg, "INSERT INTO things VALUES (8)")
    await control(fleet, "clock?namespace=worker-7", { advance: "1h" })
    expect(await kv(resp, (client) => client.get("fixture"))).toBeNull()
    expect((await control(fleet, `namespaces/worker-7/snapshots/${point.id}/restore`)).ok).toBe(
      true,
    )
    expect((await sql(pg, "SELECT * FROM things")).rows).toEqual([{ value: 7 }])
    expect(await kv(resp, (client) => client.get("fixture"))).toBe("seven")
    expect((await control(fleet, "namespaces/worker-7/reset")).ok).toBe(true)
    expect(await kv(resp, (client) => client.get("fixture"))).toBeNull()
    expect(
      (
        await sql(
          pg,
          "SELECT count(*) AS count FROM information_schema.tables WHERE table_name = 'things'",
        )
      ).rows[0]?.count,
    ).toBe("0")
    expect((await sql(endpoint(fleet, "postgres", "other"), "SELECT * FROM things")).rows).toEqual([
      { value: 9 },
    ])
    expect(await kv(endpoint(fleet, "redis", "other"), (client) => client.get("fixture"))).toBe(
      "nine",
    )
  } finally {
    await fleet.close()
  }
})

test("protocol controls report precise conflicts for live Postgres sessions and blocked Redis clients", async () => {
  const fleet = await start()
  const pg = new Client({ connectionString: endpoint(fleet, "postgres") })
  const resp = new Redis(endpoint(fleet, "redis"), { retryStrategy: () => null })
  try {
    await pg.connect()
    const blocked = resp.blpop("empty", 0).then(
      () => false,
      () => true,
    )
    // A second connection proves that the blocking command has reached the server.
    await kv(endpoint(fleet, "redis"), (client) => client.ping())
    const response = await control(fleet, "namespaces/default/reset")
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({
      services: {
        postgres: { activeConnections: 1 },
        redis: { blockedCommands: 1 },
      },
    })

    resp.disconnect()
    expect(await blocked).toBe(true)
    await pg.end()
    expect((await control(fleet, "namespaces/default/reset")).ok).toBe(true)
  } finally {
    resp.disconnect()
    await pg.end()
    await fleet.close()
  }
})
