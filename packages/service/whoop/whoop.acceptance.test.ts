import { expect, test } from "bun:test"
import { createRuntime, type DataRecord, WhoopAPI } from "./src/index.js"
import { createServer } from "./src/server.js"
import { refresh, synchronize } from "./test/consumer.js"

const base = "http://whoop.test"
const records: DataRecord[] = [1, 2, 3, 4].map((i) => ({
  key: `workout-${i}`,
  userId: "synthetic-user",
  collection: "workout",
  data: {
    id: `00000000-0000-4000-8000-00000000000${i}`,
    user_id: 1,
    created_at: `2026-01-0${i}T12:00:00Z`,
    updated_at: `2026-01-0${i}T12:00:00Z`,
    start: `2026-01-0${i}T09:00:00Z`,
    end: `2026-01-0${i}T10:00:00Z`,
    timezone_offset: "Z",
    sport_name: "walking",
    score_state: "PENDING_SCORE",
  },
}))
test("windows are inclusive start/exclusive end, descending and exhaust pagination", async () => {
  const api = new WhoopAPI({ records })
  const result = await synchronize((r) => api.fetch(r), base, "workout", "mock_whoop_token", {
    start: "2026-01-02T09:00:00Z",
    end: "2026-01-04T09:00:00Z",
    limit: "1",
  })
  expect(result.records).toEqual(
    records
      .slice(1, 3)
      .reverse()
      .map((r) => r.data),
  )
  expect(result.records[0]?.score_state).toBe("PENDING_SCORE")
  expect(result.records[0]).not.toHaveProperty("score")
})
test("recovery keeps cycle_id/sleep_id and filters by related sleep, not invented id/start/end", async () => {
  // The issue's generic recovery field list disagrees with WHOOP's official Recovery schema.
  const first = records[0]
  if (!first) throw new Error("missing fixture")
  const sleep: DataRecord = { ...first, key: "sleep-1", collection: "sleep" }
  const recovery: DataRecord = {
    key: "recovery-1",
    userId: "synthetic-user",
    collection: "recovery",
    data: {
      cycle_id: 1,
      sleep_id: sleep.data.id,
      user_id: 1,
      created_at: "2026-01-01T12:00:00Z",
      updated_at: "2026-01-01T12:00:00Z",
      score_state: "UNSCORABLE",
    },
  }
  const cycle: DataRecord = {
    ...first,
    key: "cycle-1",
    collection: "cycle",
    data: { ...first.data, id: 1, step_count: null },
  }
  const api = new WhoopAPI({ records: [sleep, recovery, cycle] })
  expect(
    (
      await synchronize((r) => api.fetch(r), base, "recovery", "mock_whoop_token", {
        start: "2026-01-01T00:00:00Z",
        end: "2026-01-02T00:00:00Z",
      })
    ).records,
  ).toEqual([recovery.data])
  expect(
    (
      await synchronize((r) => api.fetch(r), base, "recovery", "mock_whoop_token", {
        start: "2026-01-02T00:00:00Z",
      })
    ).records,
  ).toEqual([])
  expect(
    (await synchronize((r) => api.fetch(r), base, "sleep", "mock_whoop_token", {})).records,
  ).toEqual([sleep.data])
  expect(
    (await synchronize((r) => api.fetch(r), base, "cycle", "mock_whoop_token", {})).records[0]
      ?.step_count,
  ).toBeNull()
})
test("refresh revokes both old access and refresh and retains same user data", async () => {
  let now = Date.UTC(2026, 1, 1)
  const api = new WhoopAPI({ records, now: () => now, tokenTtlSeconds: 1 })
  const first = (await (await refresh((r) => api.fetch(r), base, "mock_whoop_refresh")).json()) as {
    access_token: string
    refresh_token: string
  }
  expect(
    (await synchronize((r) => api.fetch(r), base, "workout", "mock_whoop_token", {})).status,
  ).toBe(401)
  now += 1000
  expect(
    (await synchronize((r) => api.fetch(r), base, "workout", first.access_token, {})).status,
  ).toBe(401)
  const next = (await (await refresh((r) => api.fetch(r), base, first.refresh_token)).json()) as {
    access_token: string
  }
  expect(
    (await synchronize((r) => api.fetch(r), base, "workout", next.access_token, {})).records,
  ).toHaveLength(4)
  expect(
    await (await refresh((r) => api.fetch(r), base, first.refresh_token)).json(),
  ).toMatchObject({ error: "invalid_grant" })
})
test("code exchange requires offline to issue refresh and consumes PKCE codes once concurrently", async () => {
  const verifier = "a".repeat(43)
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
  )
  const challenge = btoa(String.fromCharCode(...digest))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "")
  const api = new WhoopAPI({
    codes: [
      {
        code: "mock_code",
        clientId: "mock_client",
        userId: "synthetic-user",
        scopes: ["read:sleep"],
        expiresAt: 4102444800000,
        challenge,
      },
    ],
  })
  const exchange = () =>
    api.fetch(
      new Request(`${base}/oauth/oauth2/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: "mock_code",
          code_verifier: verifier,
          client_id: "mock_client",
          client_secret: "mock_client_secret",
        }),
      }),
    )
  const responses = await Promise.all([exchange(), exchange()])
  expect(responses.map((r) => r.status).sort()).toEqual([200, 400])
  const success = responses.find((r) => r.status === 200)
  if (!success) throw new Error("missing success")
  expect(await success.json()).not.toHaveProperty("refresh_token")
})
test("namespace reset preserves other state and journals do not expose bodies", async () => {
  const runtime = createRuntime({ records })
  const admin = (path: string, ns: string, body: unknown) =>
    runtime.fetch(
      new Request(`${base}/__admin/${path}`, {
        method: "POST",
        headers: { "x-emulators-namespace": ns, "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    )
  await admin("state/records", "a", { id: "extra", value: { ...records[0], key: "extra" } })
  await admin("reset", "b", {})
  expect(
    (
      await synchronize(
        (r) => runtime.fetch(r),
        `${base}/__admin/ns/a`,
        "workout",
        "mock_whoop_token",
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
        "mock_whoop_token",
        {},
      )
    ).records,
  ).toHaveLength(4)
  await refresh((r) => runtime.fetch(r), base, "mock_whoop_refresh")
  const journal = await (await runtime.fetch(new Request(`${base}/__admin/requests`))).text()
  expect(journal).not.toContain("mock_client_secret")
  expect(journal).not.toContain("mock_whoop_refresh")
})
test("served HTTP propagates empty envelopes and every fault preset", async () => {
  const server = await createServer()
  try {
    expect(
      (await synchronize(fetch, server.url, "workout", "mock_whoop_token", {})).records,
    ).toEqual([])
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
      expect((await synchronize(fetch, server.url, "workout", "mock_whoop_token", {})).status).toBe(
        status,
      )
    }
    await fetch(`${server.url}/__admin/faults`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ preset: "connection_drop", count: 1 }),
    })
    await expect(
      synchronize((r) => server.runtime.fetch(r), server.url, "workout", "mock_whoop_token", {}),
    ).rejects.toThrow()
    expect(
      (await synchronize(fetch, server.url, "workout", "mock_whoop_token", { limit: "26" })).status,
    ).toBe(400)
  } finally {
    await server.close()
  }
})
