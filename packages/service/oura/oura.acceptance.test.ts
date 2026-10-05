import { expect, test } from "bun:test"
import { createRuntime, type DataRecord, OuraAPI } from "./src/index.js"
import { createServer } from "./src/server.js"
import { refresh, synchronize } from "./test/consumer.js"

const base = "http://oura.test"
const records: DataRecord[] = ["2026-01-01", "2026-01-02", "2026-01-03", "2026-01-04"].map(
  (day, i) => ({
    key: `row-${i}`,
    userId: "synthetic-user",
    collection: "workout",
    data: {
      id: `synthetic-workout-${i}`,
      day,
      activity: "walking",
      calories: null,
      distance: null,
      intensity: "moderate",
      source: "manual",
      label: null,
      start_datetime: `${day}T09:00:00Z`,
      end_datetime: `${day}T10:00:00Z`,
    },
  }),
)
test("bounded day windows paginate once and preserve null metrics and ids", async () => {
  const api = new OuraAPI({ records, pageSize: 1 })
  const result = await synchronize((r) => api.fetch(r), base, "workout", "mock_oura_token", {
    start_date: "2026-01-02",
    end_date: "2026-01-03",
  })
  expect(result.records).toEqual(records.slice(1, 3).map((r) => r.data))
  expect(result.records[0]?.calories).toBeNull()
  const empty = await synchronize((r) => api.fetch(r), base, "sleep", "mock_oura_token", {})
  expect(empty.records).toEqual([])
})
test("heart rate uses timestamps without invented ids; all daily collections filter day", async () => {
  const api = new OuraAPI({
    records: [
      {
        key: "heart-1",
        userId: "synthetic-user",
        collection: "heartrate",
        data: { timestamp: "2026-01-02T10:00:00Z", bpm: 60, source: "rest" },
      },
      ...["daily_activity", "daily_spo2", "daily_readiness", "daily_sleep", "sleep"].map(
        (collection) =>
          ({
            key: collection,
            collection,
            userId: "synthetic-user",
            data: { id: `synthetic-${collection}`, day: "2026-01-02", score: null },
          }) as DataRecord,
      ),
    ],
  })
  const heart = await synchronize((r) => api.fetch(r), base, "heartrate", "mock_oura_token", {
    start_datetime: "2026-01-02T09:00:00Z",
    end_datetime: "2026-01-02T11:00:00Z",
  })
  expect(heart.records).toEqual([{ timestamp: "2026-01-02T10:00:00Z", bpm: 60, source: "rest" }])
  for (const collection of [
    "daily_activity",
    "daily_spo2",
    "daily_readiness",
    "daily_sleep",
    "sleep",
  ])
    expect(
      (
        await synchronize((r) => api.fetch(r), base, collection, "mock_oura_token", {
          start_date: "2026-01-02",
          end_date: "2026-01-02",
        })
      ).records,
    ).toHaveLength(1)
})
test("expired access refreshes for same user and refresh is single use", async () => {
  let now = 1000
  const api = new OuraAPI({ now: () => now, records, tokenTtlSeconds: 1 })
  const first = await refresh((r) => api.fetch(r), base, "mock_oura_refresh")
  const token = (await first.json()) as { access_token: string; refresh_token: string }
  now += 1000
  expect(
    (await synchronize((r) => api.fetch(r), base, "workout", token.access_token, {})).status,
  ).toBe(401)
  const renewed = (await (
    await refresh((r) => api.fetch(r), base, token.refresh_token)
  ).json()) as { access_token: string }
  expect(
    (await synchronize((r) => api.fetch(r), base, "workout", renewed.access_token, {})).records,
  ).toHaveLength(4)
  expect(
    await (await refresh((r) => api.fetch(r), base, token.refresh_token)).json(),
  ).toMatchObject({ error: "invalid_grant" })
})
test("authorization code is client and redirect bound; Basic credentials work", async () => {
  const api = new OuraAPI({
    now: () => 1000,
    codes: [
      {
        code: "mock_code",
        clientId: "mock_client",
        userId: "synthetic-user",
        scopes: ["daily"],
        expiresAt: 2000,
        redirectUri: "https://example.invalid/callback",
      },
    ],
  })
  const exchange = (redirect: string) =>
    api.fetch(
      new Request(`${base}/oauth/token`, {
        method: "POST",
        headers: { authorization: `Basic ${btoa("mock_client:mock_client_secret")}` },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: "mock_code",
          redirect_uri: redirect,
        }),
      }),
    )
  expect((await exchange("https://example.invalid/wrong")).status).toBe(400)
  const token = (await (await exchange("https://example.invalid/callback")).json()) as {
    access_token: string
  }
  expect(
    (await synchronize((r) => api.fetch(r), base, "workout", token.access_token, {})).status,
  ).toBe(403)
  expect((await exchange("https://example.invalid/callback")).status).toBe(400)
})
test("namespace reset, admin seeding, clock and journal redact credentials", async () => {
  const runtime = createRuntime({ records, pageSize: 1 })
  const request = (path: string, namespace: string, init: RequestInit = {}) =>
    runtime.fetch(
      new Request(`${base}${path}`, {
        ...init,
        headers: { "x-mockingbird-namespace": namespace, ...init.headers },
      }),
    )
  await request("/__admin/state/records", "a", {
    method: "POST",
    body: JSON.stringify({
      id: "extra",
      value: { ...records[0], key: "extra", data: { id: "extra", day: "2026-01-02" } },
    }),
    headers: { "content-type": "application/json" },
  })
  await request("/__admin/reset", "b", { method: "POST" })
  expect(
    (
      await synchronize(
        (r) => runtime.fetch(r),
        `${base}/__admin/ns/a`,
        "workout",
        "mock_oura_token",
        {},
      )
    ).records,
  ).toHaveLength(5)
  expect(
    (
      await synchronize(
        (r) => runtime.fetch(r),
        `${base}/__admin/ns/b`,
        "workout",
        "mock_oura_token",
        {},
      )
    ).records,
  ).toHaveLength(4)
  await refresh((r) => runtime.fetch(r), `${base}/__admin/ns/a`, "mock_oura_refresh")
  const journal = JSON.stringify(await (await request("/__admin/requests", "a")).json())
  expect(journal).not.toContain("mock_client_secret")
  expect(journal).not.toContain("mock_oura_refresh")
})
test("served HTTP retains failures, malformed cursors and all presets", async () => {
  const server = await createServer({ records })
  try {
    for (const [preset, status] of [
      ["unauthorized", 401],
      ["rate_limited", 429],
      ["server_error", 500],
    ] as const) {
      await fetch(`${server.url}/__admin/faults`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ preset, count: 1 }),
      })
      expect((await synchronize(fetch, server.url, "workout", "mock_oura_token", {})).status).toBe(
        status,
      )
    }
    await fetch(`${server.url}/__admin/faults`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ preset: "connection_drop", count: 1 }),
    })
    await expect(
      synchronize((r) => server.runtime.fetch(r), server.url, "workout", "mock_oura_token", {}),
    ).rejects.toThrow()
    expect(
      (
        await synchronize(fetch, server.url, "workout", "mock_oura_token", {
          next_token: "unknown",
        })
      ).status,
    ).toBe(400)
  } finally {
    await server.close()
  }
})
