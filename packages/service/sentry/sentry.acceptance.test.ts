import { expect, test } from "bun:test"
import { gzipSync } from "node:zlib"
import { createRuntime, DEFAULT_PROJECT, type SentryRuntime } from "./src/index.js"
import { createServer } from "./src/server.js"
import { bytes, envelope, eventId, SentryAssertions } from "./test/consumer.js"

const fixture = (runtime: SentryRuntime, namespace?: string) =>
  new SentryAssertions((r) => runtime.fetch(r), undefined, namespace)
const data = (n: number, overrides: Record<string, unknown> = {}) => ({
  event_id: eventId(n),
  message: `Fixture ${n}`,
  level: "error",
  fingerprint: ["shared-fixture"],
  release: "fixture-release",
  ...overrides,
})

test("ingestion preserves binary items, searchable fields, issues, sessions, reports and encrypted raw bytes", async () => {
  const runtime = createRuntime()
  const client = fixture(runtime)
  const binary = bytes("fixture attachment\nwith binary\u0000payload")
  const payload = envelope(eventId(1), [
    {
      type: "attachment",
      data: binary,
      headers: { filename: "fixture.bin", content_type: "application/octet-stream" },
    },
    {
      type: "event",
      data: data(1, {
        platform: "javascript",
        environment: "test",
        transaction: "fixture-route",
        user: { id: "fake-user-1", email: "fixture@example.invalid" },
        tags: { test: "alpha" },
        contexts: { trace: { trace_id: eventId(100), span_id: "0000000000000001" } },
        exception: {
          values: [
            {
              type: "FixtureError",
              value: "fixture failure",
              stacktrace: { frames: [{ filename: "fixture.ts", function: "fixture" }] },
            },
          ],
        },
        breadcrumbs: { values: [{ message: "fixture breadcrumb", timestamp: 1_700_000_000 }] },
        request: {
          headers: { Authorization: "private-fixture-auth", cookie: "private-fixture-cookie" },
          data: "private-fixture-body",
        },
        extra: { confidential: "private-fixture-extra" },
      }),
    },
    {
      type: "session",
      data: { sid: "fixture-session", status: "ok", attrs: { release: "fixture-release" } },
    },
    {
      type: "client_report",
      data: {
        timestamp: 1_700_000_000,
        discarded_events: [{ reason: "ratelimit_backoff", category: "error", quantity: 1 }],
      },
    },
    { type: "future_item", data: bytes("unknown\nitem") },
  ])
  expect(
    (
      await client.admin("PUT", "/settings", {
        sensitivePaths: ["request.data", "request.cookies", "extra.confidential"],
      })
    ).status,
  ).toBe(200)
  const response = await client.envelope(payload)
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ id: eventId(1) })
  const captured = await (
    await client.admin(
      "GET",
      `/events?project=1&release=fixture-release&tag=test:alpha&trace=${eventId(100)}`,
    )
  ).json()
  expect(captured.events).toHaveLength(1)
  expect(captured.events[0].data.user).toEqual({ id: "fake-user-1" })
  expect(captured.events[0].data.request.data).toBe("[Filtered]")
  expect(captured.events[0].data.extra.confidential).toBe("[Filtered]")
  const issues = await (await client.issues()).json()
  expect(issues).toHaveLength(1)
  expect(issues[0].count).toBe("1")
  expect(issues[0].id).toMatch(/^\d+$/)
  const detail = await (
    await client.request("GET", `/api/0/projects/fixture-org/fixture/events/${eventId(1)}/`)
  ).json()
  expect(
    detail.entries.find((e: { type: string }) => e.type === "exception").data.values[0].type,
  ).toBe("FixtureError")
  const attachments = await (
    await client.request(
      "GET",
      `/api/0/projects/fixture-org/fixture/events/${eventId(1)}/attachments/`,
    )
  ).json()
  expect(attachments[0].size).toBe(binary.length)
  expect(attachments[0].id).toMatch(/^\d+$/)
  const download = await client.request(
    "GET",
    `/api/0/projects/fixture-org/fixture/events/${eventId(1)}/attachments/${attachments[0].id}/?download=1`,
  )
  expect(new Uint8Array(await download.arrayBuffer())).toEqual(binary)
  const api = runtime.instance()
  expect(api.state.sessions.count()).toBe(1)
  expect(api.state.clientReports.count()).toBe(1)
  expect(api.state.releases.count()).toBe(1)
  const metadata = await (await client.admin("GET", "/envelopes")).json()
  expect(metadata.envelopes[0].items.map((i: { type: string }) => i.type)).toContain("future_item")
  expect(await api.rawEnvelope(metadata.envelopes[0].id)).toEqual(payload)
  for (const path of [
    "/requests",
    "/envelopes",
    "/state/envelopes",
    "/state/attachments",
    "/state/events",
  ]) {
    const diagnostics = await (await client.admin("GET", path)).text()
    for (const secret of [
      "private-fixture-auth",
      "private-fixture-cookie",
      "private-fixture-body",
      "private-fixture-extra",
      "fixture attachment",
    ])
      expect(diagnostics).not.toContain(secret)
  }
  expect((await client.admin("POST", "/flush", { eventIds: [eventId(1)], count: 1 })).status).toBe(
    200,
  )
  expect(
    (await (await client.admin("POST", "/flush", { eventIds: [eventId(999)] })).json()).flushed,
  ).toBe(false)
})

test("event IDs dedupe concurrent replay and project scope, with no extra grouping or attachment side effects", async () => {
  const runtime = createRuntime({
    projects: [DEFAULT_PROJECT, { ...DEFAULT_PROJECT, id: "2", slug: "second" }],
  })
  const client = fixture(runtime)
  const payload = envelope(eventId(2), [
    { type: "event", data: data(2) },
    { type: "attachment", data: bytes("fixture") },
  ])
  const responses = await Promise.all(Array.from({ length: 4 }, () => client.envelope(payload)))
  for (const response of responses) {
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ id: eventId(2) })
  }
  expect(runtime.instance().state.events.count()).toBe(1)
  expect(runtime.instance().state.envelopes.count()).toBe(1)
  expect(runtime.instance().state.attachments.count()).toBe(1)
  expect((await (await client.issues()).json())[0].count).toBe("1")
  expect(
    (await client.request("POST", `/api/2/store/?sentry_key=${DEFAULT_PROJECT.publicKey}`, data(2)))
      .status,
  ).toBe(200)
  expect(runtime.instance().state.events.count()).toBe(2)
})

test("grouping, issue resolution, newest-first pagination, filters and every event exactly once", async () => {
  const runtime = createRuntime()
  const client = fixture(runtime)
  for (let n = 10; n < 15; n++) expect((await client.store(data(n))).status).toBe(200)
  let path = "/api/0/projects/fixture-org/fixture/events/?limit=2"
  const seen: string[] = []
  for (let page = 0; page < 4; page++) {
    const response = await client.request("GET", path)
    const rows = await response.json()
    seen.push(...rows.map((e: { eventID: string }) => e.eventID))
    const next = response.headers
      .get("link")
      ?.split(", ")
      .find((v) => v.includes('rel="next"'))
    if (!next?.includes('results="true"')) break
    const url = new URL(next.match(/<([^>]+)>/)?.[1] as string)
    path = url.pathname + url.search
  }
  expect(seen).toEqual([14, 13, 12, 11, 10].map(eventId))
  expect(new Set(seen).size).toBe(5)
  const issue = (await (await client.issues()).json())[0]
  expect(issue.count).toBe("5")
  expect(
    (
      await client.request("PUT", `/api/0/organizations/fixture-org/issues/${issue.id}/`, {
        status: "resolved",
      })
    ).status,
  ).toBe(200)
  expect(await (await client.issues()).json()).toEqual([])
  expect((await (await client.issues("?query=is:resolved")).json())[0].id).toBe(issue.id)
  expect(
    (await client.admin("POST", `/issues/${issue.id}/status`, { status: "unresolved" })).status,
  ).toBe(200)
  expect((await client.request("GET", `/api/0/issues/${issue.id}/`)).status).toBe(200)
  expect(
    (await client.request("GET", `/api/0/organizations/other/issues/${issue.id}/`)).status,
  ).toBe(404)
  expect((await client.admin("PUT", "/settings", { grouping: "message" })).status).toBe(200)
  expect((await client.store({ message: "new fixture", tags: { branch: "new" } })).status).toBe(200)
  expect(await (await client.issues("?query=branch:new")).json()).toHaveLength(1)
  expect((await client.events("?cursor=bad")).status).toBe(400)
})

test("vendor auth and malformed input errors are finite and atomic; compressed input is accepted", async () => {
  const runtime = createRuntime({ maxPayloadBytes: 4096 })
  const client = fixture(runtime)
  for (const [path, body, headers, status, detail] of [
    ["/api/1/store/", data(20), {}, 401, "missing authorization information"],
    ["/api/1/store/?sentry_key=bad", data(20), {}, 400, "bad sentry DSN public key"],
    [
      `/api/1/store/?sentry_key=${DEFAULT_PROJECT.publicKey}&sentry_version=8`,
      data(20),
      {},
      400,
      "unsupported protocol version (8)",
    ],
    [
      `/api/1/store/?sentry_key=${DEFAULT_PROJECT.publicKey}`,
      data(20),
      { "x-sentry-auth": `Sentry sentry_key=${DEFAULT_PROJECT.publicKey}` },
      401,
      "multiple authorization payloads detected",
    ],
    [
      "/api/1/envelope/",
      "broken",
      { "content-type": "application/x-sentry-envelope" },
      400,
      "invalid event envelope",
    ],
    [
      `/api/1/store/?sentry_key=${DEFAULT_PROJECT.publicKey}`,
      { message: "fixture", event_id: "invalid" },
      {},
      400,
      "invalid event id",
    ],
  ] as const) {
    const response = await client.request("POST", path, body, headers)
    expect(response.status).toBe(status)
    expect((await response.json()).detail).toBe(detail)
  }
  expect(runtime.instance().state.events.count()).toBe(0)
  expect(
    (
      await client.request("GET", "/api/0/projects/fixture-org/fixture/events/", undefined, {
        authorization: "",
      })
    ).status,
  ).toBe(401)
  const oversized = await client.envelope(bytes("x".repeat(4097)))
  expect(oversized.status).toBe(413)
  const compressed = gzipSync(envelope(eventId(21), [{ type: "event", data: data(21) }]))
  const response = await client.request(
    "POST",
    `/api/1/envelope/?sentry_key=${DEFAULT_PROJECT.publicKey}`,
    new Uint8Array(compressed),
    { "content-type": "application/x-sentry-envelope", "content-encoding": "gzip" },
  )
  expect(response.status).toBe(200)
  expect(runtime.instance().state.events.count()).toBe(1)
})

test("self-authenticated envelopes, partial item drops, presets and snapshot/reset namespace fixtures", async () => {
  const runtime = createRuntime()
  const a = fixture(runtime, "a"),
    b = fixture(runtime, "b")
  expect(
    (await a.admin("POST", "/clock", { set: "2024-01-02T00:00:00Z", freeze: true })).status,
  ).toBe(200)
  const concurrent = await Promise.all([a.store(data(30)), b.store(data(31))])
  expect(concurrent.map((response) => response.status)).toEqual([200, 200])
  expect((await (await a.admin("GET", "/events")).json()).events[0].receivedAt).toBe(
    "2024-01-02T00:00:00.000Z",
  )
  expect(runtime.instance("a").state.events.count()).toBe(1)
  expect(runtime.instance("b").state.events.count()).toBe(1)
  const snapshot = await (await a.admin("POST", "/snapshots")).json()
  expect((await a.admin("POST", "/projects/1/clear")).status).toBe(200)
  expect(runtime.instance("a").state.events.count()).toBe(0)
  expect((await a.admin("POST", `/snapshots/${snapshot.id}/restore`)).status).toBe(200)
  expect(runtime.instance("a").state.events.count()).toBe(1)
  const restoredEnvelope = runtime.instance("a").state.envelopes.list()[0]
  expect(await runtime.instance("a").rawEnvelope(restoredEnvelope?.id as string)).toEqual(
    bytes(JSON.stringify(data(30))),
  )
  for (const [preset, status] of [
    ["rate_limited", 429],
    ["server_error", 503],
    ["item_rejected", 403],
  ] as const) {
    expect((await a.admin("POST", "/faults", { preset, count: 1 })).status).toBe(201)
    const response = await a.store(data(32))
    expect(response.status).toBe(status)
    if (status === 429) {
      expect(response.headers.get("retry-after")).toBe("60")
      expect(response.headers.get("x-sentry-rate-limits")).toBe("60:error:organization")
    }
    expect(runtime.instance("a").state.events.count()).toBe(1)
  }
  await a.admin("POST", "/faults", { preset: "network_reset", count: 1 })
  await expect(a.store(data(32))).rejects.toThrow(TypeError)
  // Presets expand to one rule per ingestion operation; clear the unused envelope/minidump rules.
  await a.admin("DELETE", "/faults")
  await a.admin("PUT", "/settings", { rejectItems: ["transaction"] })
  expect(
    (
      await a.envelope(
        envelope(eventId(32), [
          { type: "transaction", data: { transaction: "fixture" } },
          { type: "session", data: { sid: "fixture-drop", status: "ok" } },
        ]),
      )
    ).status,
  ).toBe(200)
  expect(runtime.instance("a").state.sessions.count()).toBe(1)
  expect(runtime.instance("a").state.events.count()).toBe(1)
  const selfAuthenticated = bytes(
    `${JSON.stringify({ dsn: `http://${DEFAULT_PROJECT.publicKey}@sentry.fixture/1`, event_id: eventId(33) })}\n${JSON.stringify({ type: "event" })}\n${JSON.stringify(data(33))}`,
  )
  expect(
    (
      await a.request("POST", "/api/1/envelope/", selfAuthenticated, {
        "content-type": "application/x-sentry-envelope",
      })
    ).status,
  ).toBe(200)
  await a.admin("POST", "/reset")
  expect(runtime.instance("a").state.events.count()).toBe(0)
  expect(runtime.instance("a").state.projects.get("1")).toEqual(DEFAULT_PROJECT)
  expect(runtime.instance("a").state.current().rejectItems).toEqual([])
  expect(runtime.instance("b").state.events.count()).toBe(1)
})

test("served HTTP accepts raw and multipart minidumps, credential namespaces and custom admin prefixes", async () => {
  const server = await createServer({ adminPrefix: "/_control/mock" })
  const client = new SentryAssertions((r) => fetch(r), server.url, "served", "/_control/mock")
  try {
    expect(
      (
        await client.request(
          "POST",
          `/api/1/minidump/?sentry_key=${DEFAULT_PROJECT.publicKey}`,
          bytes("MDMPfixture dump"),
          { "content-type": "application/octet-stream" },
        )
      ).status,
    ).toBe(200)
    const form = new FormData()
    form.set("upload_file_minidump", new Blob([bytes("MDMPmultipart fixture")]), "fixture.dmp")
    form.set("sentry", JSON.stringify(data(40)))
    const response = await fetch(
      `${server.url}/api/1/minidump/?sentry_key=${DEFAULT_PROJECT.publicKey}`,
      { method: "POST", headers: { "x-mockingbird-namespace": "served" }, body: form },
    )
    expect(response.status).toBe(200)
    expect(await response.text()).toBe("00000000-0000-0000-0000-000000000028")
    expect(server.runtime.instance("served").state.attachments.count()).toBe(2)
    await client.store(data(41))
    const listed = await client.events("?limit=1")
    expect(listed.headers.get("link")).toContain("/_control/mock/ns/served/api/")
    const link = listed.headers
      .get("link")
      ?.split(", ")
      .find((s) => s.includes('rel="next"'))
      ?.match(/<([^>]+)>/)?.[1] as string
    expect(
      (await fetch(link, { headers: { authorization: "Bearer fixture-rest-token" } })).status,
    ).toBe(200)
    expect((await client.admin("GET", "/health")).status).toBe(200)
    expect(
      (
        await client.admin("PUT", "/credentials", {
          credentials: { [DEFAULT_PROJECT.publicKey]: "credential-suite" },
        })
      ).status,
    ).toBe(200)
    expect(
      (
        await fetch(`${server.url}/api/1/store/?sentry_key=${DEFAULT_PROJECT.publicKey}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(data(42)),
        })
      ).status,
    ).toBe(200)
    expect(server.runtime.instance("credential-suite").state.events.count()).toBe(1)
    expect(server.runtime.instance().state.events.count()).toBe(0)
  } finally {
    await server.close()
  }
})

test("legacy false messages are accepted and normalized without overwriting REST resource fields", async () => {
  const runtime = createRuntime()
  const client = fixture(runtime)
  const response = await client.store({
    event_id: eventId(50),
    message: false,
    id: "spoofed",
    projectID: "other",
    groupID: "spoofed",
    dateCreated: "invalid",
  })
  expect(response.status).toBe(200)
  const detail = await (
    await client.request("GET", `/api/0/projects/fixture-org/fixture/events/${eventId(50)}/`)
  ).json()
  expect(detail.message).toBe("")
  expect(detail.id).toBe(eventId(50))
  expect(detail.projectID).toBe("1")
  expect(detail.groupID).toMatch(/^\d+$/)
  expect(Number.isFinite(Date.parse(detail.dateCreated))).toBe(true)
})
