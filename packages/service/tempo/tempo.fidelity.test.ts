import { describe, expect, test } from "bun:test"
import {
  createRuntime,
  decodeRpcStatus,
  INTRINSIC_TAGS,
  ROOT_SPAN_NOT_YET_RECEIVED,
  type Settings,
} from "./src/index.js"
import { tracesExport } from "./test/consumer.js"
import { encodeTraceRequest } from "./test/otlp-proto.js"

/**
 * Wire details a client could come to depend on, pinned to the sources they were read from:
 * Grafana's Tempo API reference, Tempo v3.1.0 and the OpenTelemetry Collector's OTLP receiver.
 */
const API = "http://tempo.mock"
const T = 1_700_000_000
const ns = (seconds: number, nanos = 0) => `${BigInt(seconds) * 1_000_000_000n + BigInt(nanos)}`
const TRACE = "000000000000000000269b633813fc7a"

const harness = (settings?: Partial<Settings>) => {
  const runtime = createRuntime(settings ? { settings } : {})
  const call = (path: string, init?: RequestInit) =>
    runtime.fetch(new Request(`${API}${path}`, init))
  const push = (payload: unknown, headers: Record<string, string> = {}) =>
    call("/v1/traces", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(payload),
    })
  const get = async (path: string, headers: Record<string, string> = {}) => {
    const res = await call(path, { headers })
    const body = await res.text()
    return { status: res.status, type: res.headers.get("content-type"), body }
  }
  return { runtime, call, push, get }
}

const fixture = () =>
  tracesExport({ "service.name": "api", "host.name": "host-1" }, [
    {
      traceId: TRACE,
      spanId: "00000000000000a1",
      name: "GET /orders",
      kind: 2,
      startTimeUnixNano: ns(T),
      endTimeUnixNano: ns(T + 2),
      attributes: { "user.id": "user-1" },
    },
    {
      traceId: TRACE,
      spanId: "00000000000000a2",
      parentSpanId: "00000000000000a1",
      name: "SELECT orders",
      kind: 3,
      startTimeUnixNano: ns(T, 500_000_000),
      endTimeUnixNano: ns(T + 1),
      attributes: { "user.id": "user-1", "db.system": "postgresql" },
      status: { code: 2, message: "timeout" },
    },
  ])

describe("search response", () => {
  test("the whole body for one matching trace", async () => {
    const { push, get } = harness()
    await push(fixture())
    const q = encodeURIComponent('{ .user.id = "user-1" && resource.service.name = "api" }')
    const res = await get(`/api/search?q=${q}&start=${T - 5}&end=${T + 5}&spss=1`)
    expect([res.status, res.type]).toEqual([200, "application/json"])
    const spanSet = {
      spans: [
        {
          spanID: "00000000000000a1",
          startTimeUnixNano: ns(T),
          durationNanos: "2000000000",
          attributes: [
            { key: "user.id", value: { stringValue: "user-1" } },
            { key: "service.name", value: { stringValue: "api" } },
          ],
        },
      ],
      // Both spans match; `spss=1` lists one of them.
      matched: 2,
    }
    const body: unknown = JSON.parse(res.body)
    const { inspectedBytes } = (body as { metrics: { inspectedBytes: string } }).metrics
    expect(body).toEqual({
      traces: [
        {
          // `util.TraceIDToHexString`: leading zeros are trimmed.
          traceID: "269b633813fc7a",
          rootServiceName: "api",
          rootTraceName: "GET /orders",
          // uint64 as a string, uint32 as a number (gogo jsonpb).
          startTimeUnixNano: ns(T),
          durationMs: 2000,
          spanSet,
          spanSets: [spanSet],
          serviceStats: { api: { spanCount: 2, errorCount: 1 } },
        },
      ],
      metrics: {
        inspectedTraces: 1,
        inspectedBytes,
        completedJobs: 1,
        totalJobs: 1,
      },
    })
    expect(inspectedBytes).toMatch(/^\d+$/)
  })

  test("no match is an empty list; a trace without a root span says so", async () => {
    const { push, get } = harness()
    const none = await get(`/api/search?q=${encodeURIComponent("{ true }")}`)
    expect(JSON.parse(none.body)).toEqual({
      traces: [],
      metrics: { completedJobs: 1, totalJobs: 1 },
    })
    await push(
      tracesExport({ "service.name": "api" }, [
        {
          traceId: TRACE,
          spanId: "00000000000000b2",
          parentSpanId: "00000000000000b1",
          name: "orphan",
          startTimeUnixNano: ns(T),
          endTimeUnixNano: ns(T, 400_000),
        },
      ]),
    )
    const orphan = JSON.parse((await get("/api/search")).body) as {
      traces: Record<string, unknown>[]
    }
    expect(orphan.traces[0]).toMatchObject({ rootServiceName: ROOT_SPAN_NOT_YET_RECEIVED })
    // jsonpb leaves zero values out: no root name, and under a millisecond no durationMs.
    expect(orphan.traces[0]).not.toHaveProperty("rootTraceName")
    expect(orphan.traces[0]).not.toHaveProperty("durationMs")
  })

  test("request validation, in the frontend's order and words", async () => {
    const { get, runtime } = harness()
    const TEXT = "text/plain; charset=utf-8"
    const cases: [string, string][] = [
      ["end=abc", 'invalid end: strconv.ParseUint: parsing "abc": invalid syntax'],
      ["start=-1", 'invalid start: strconv.ParseUint: parsing "-1": invalid syntax'],
      [
        "start=99999999999",
        'invalid start: strconv.ParseUint: parsing "99999999999": value out of range',
      ],
      ["limit=x", 'invalid limit: strconv.ParseUint: parsing "x": invalid syntax'],
      ["spss=x", 'invalid spss: strconv.ParseUint: parsing "x": invalid syntax'],
      ["start=5", "http parameter start must be before end. received start=5 end=0"],
      ["start=7&end=7", "http parameter start must be before end. received start=7 end=7"],
      ["limit=262145", "limit 262145 exceeds max limit 262144"],
      [
        `start=${T}&end=${T + 604_801}`,
        `range specified by start and end exceeds 168h0m0s. received start=${T} end=${T + 604_801}`,
      ],
      ["spss=101", "spans per span set exceeds 100. received 101"],
      // The legacy tag search is not emulated, and says so instead of matching everything.
      [
        "tags=service.name%3Dapi",
        "tags search not yet supported (Mockingbird emulates a TraceQL subset)",
      ],
      ["service.name=api", "tags search not yet supported (Mockingbird emulates a TraceQL subset)"],
      ["minDuration=1s", "minDuration not yet supported (Mockingbird emulates a TraceQL subset)"],
    ]
    for (const [query, message] of cases) {
      expect([query, await get(`/api/search?${query}`)]).toEqual([
        query,
        { status: 400, type: TEXT, body: message },
      ])
    }
    // The limit is checked before the query is parsed; the range after.
    const bad = encodeURIComponent("{ nope")
    expect((await get(`/api/search?limit=0&q=${bad}`)).body).toBe(
      "invalid limit: must be a positive number",
    )
    expect((await get(`/api/search?start=${T}&end=${T + 604_801}&q=${bad}`)).body).toStartWith(
      "invalid TraceQL query: ",
    )
    // An empty q is no q.
    expect((await get("/api/search?q=")).status).toBe(200)
    await runtime.instance().state.update({ maxLimit: 0 })
    expect((await get("/api/search?limit=262145")).status).toBe(200)
  })
})

describe("trace by id", () => {
  test("ids, padding and request validation", async () => {
    const { push, get } = harness()
    await push(fixture())
    // Any hex up to 128 bits names a trace: short and odd-length ids are left-padded.
    for (const id of [TRACE, "269b633813fc7a", "0269B633813FC7A"]) {
      expect([id, (await get(`/api/traces/${id}`)).status]).toEqual([id, 200])
    }
    const TEXT = "text/plain; charset=utf-8"
    expect(await get(`/api/traces/${TRACE}00`)).toEqual({
      status: 400,
      type: TEXT,
      body: "trace IDs can't be larger than 128 bits",
    })
    expect(await get("/api/traces/12xz")).toEqual({
      status: 400,
      type: TEXT,
      body: "trace IDs can only contain hex characters: invalid character 'x' at position 3",
    })
    expect((await get(`/api/traces/${TRACE}?mode=sideways`)).body).toBe(
      "invalid value for mode sideways",
    )
    expect((await get(`/api/traces/${TRACE}?start=x`)).body).toBe(
      'invalid start: strconv.ParseInt: parsing "x": invalid syntax',
    )
    expect((await get(`/api/traces/${TRACE}?start=9&end=3`)).body).toBe(
      "http parameter start must be before end. received start=9 end=3",
    )
    expect((await get(`/api/traces/${TRACE}?start=${T - 5}&end=${T + 5}`)).status).toBe(200)
    // Unknown: 404 and nothing else, not even a content type.
    expect(await get("/api/traces/abc")).toEqual({ status: 404, type: null, body: "" })
  })

  test("batches keep their export, sorted by start; a re-exported span replaces the stored one", async () => {
    const { push, get } = harness()
    const later = tracesExport({ "service.name": "worker" }, [
      {
        traceId: TRACE,
        spanId: "00000000000000c1",
        parentSpanId: "00000000000000a1",
        name: "enqueue",
        startTimeUnixNano: ns(T + 1),
        endTimeUnixNano: ns(T + 1, 5_000),
        events: [
          { name: "second", timeUnixNano: ns(T + 1, 2_000) },
          { name: "first", timeUnixNano: ns(T + 1, 1_000) },
        ],
      },
    ])
    // Exported out of order: the later batch first.
    await push(later)
    await push(fixture())
    type Wire = {
      batches: {
        resource: { attributes: { key: string; value: { stringValue: string } }[] }
        scopeSpans: { spans: { name: string; events?: { name: string }[] }[] }[]
      }[]
    }
    const read = async () => JSON.parse((await get(`/api/traces/${TRACE}`)).body) as Wire
    const first = await read()
    expect(
      first.batches.map((batch) => [
        batch.resource.attributes[0]?.value.stringValue,
        batch.scopeSpans.flatMap((scoped) => scoped.spans.map((span) => span.name)),
      ]),
    ).toEqual([
      ["api", ["GET /orders", "SELECT orders"]],
      ["worker", ["enqueue"]],
    ])
    // Events are ordered by time, as `trace.SortTrace` leaves them.
    expect(first.batches[1]?.scopeSpans[0]?.spans[0]?.events?.map((event) => event.name)).toEqual([
      "first",
      "second",
    ])

    const renamed = fixture()
    const spans = (renamed.resourceSpans as { scopeSpans: { spans: { name: string }[] }[] }[])[0]
      ?.scopeSpans[0]?.spans
    if (spans?.[0]) spans[0].name = "GET /orders (retried export)"
    await push(renamed)
    const names = (await read()).batches.flatMap((batch) =>
      batch.scopeSpans.flatMap((scoped) => scoped.spans.map((span) => span.name)),
    )
    expect(names).toEqual(["GET /orders (retried export)", "SELECT orders", "enqueue"])
  })
})

describe("tags", () => {
  test("every scope, the intrinsics, and the per-scope limit", async () => {
    const { push, get } = harness()
    await push({
      resourceSpans: [
        {
          resource: { attributes: [{ key: "service.name", value: { stringValue: "api" } }] },
          scopeSpans: [
            {
              scope: {
                name: "lib",
                attributes: [{ key: "lib.language", value: { stringValue: "ts" } }],
              },
              spans: [
                {
                  traceId: TRACE,
                  spanId: "00000000000000d1",
                  name: "x",
                  attributes: [
                    { key: "zeta", value: { intValue: 1 } },
                    { key: "Alpha", value: { boolValue: true } },
                    { key: "beta", value: { doubleValue: 0.5 } },
                  ],
                  events: [
                    {
                      name: "e",
                      attributes: [{ key: "exception.type", value: { stringValue: "E" } }],
                    },
                  ],
                  links: [
                    {
                      traceId: "5b8efff798038103d269b633813fc7c9",
                      spanId: "00000000000000d9",
                      attributes: [{ key: "link.kind", value: { stringValue: "follows" } }],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    })
    const all = JSON.parse((await get("/api/v2/search/tags")).body) as {
      scopes: { name: string; tags: string[] }[]
      metrics: Record<string, unknown>
    }
    expect(all.scopes).toEqual([
      { name: "resource", tags: ["service.name"] },
      // Go's sort.Strings: capitals first.
      { name: "span", tags: ["Alpha", "beta", "zeta"] },
      { name: "event", tags: ["exception.type"] },
      { name: "link", tags: ["link.kind"] },
      { name: "instrumentation", tags: ["lib.language"] },
      { name: "intrinsic", tags: [...INTRINSIC_TAGS] },
    ])
    expect(Object.keys(all.metrics).sort()).toEqual([
      "completedJobs",
      "inspectedBytes",
      "totalJobs",
    ])
    const scopes = async (query: string) =>
      (JSON.parse((await get(`/api/v2/search/tags?${query}`)).body) as typeof all).scopes
    expect(await scopes("scope=none")).toEqual(all.scopes)
    expect(await scopes("scope=intrinsic")).toEqual([
      { name: "intrinsic", tags: [...INTRINSIC_TAGS] },
    ])
    expect(await scopes("scope=span&limit=2")).toEqual([{ name: "span", tags: ["Alpha", "beta"] }])
    expect(await scopes("scope=trace")).toEqual([])
    expect(await get("/api/v2/search/tags?scope=span&start=x")).toMatchObject({
      status: 400,
      body: 'invalid start: strconv.ParseInt: parsing "x": invalid syntax',
    })
    expect(
      await get(`/api/v2/search/tags?scope=span&q=${encodeURIComponent("{ true }")}`),
    ).toMatchObject({
      status: 400,
      body: "filtered tag names (q) not yet supported (Mockingbird emulates a TraceQL subset)",
    })
  })
})

describe("the OTLP receiver", () => {
  test("multi-tenancy on the ingest path", async () => {
    const { push, call, get } = harness({ multitenancy: true })
    // The receiver maps Tempo's plain "no org id" error to retryable UNAVAILABLE.
    const anonymous = await push(fixture())
    expect([anonymous.status, await anonymous.json()]).toEqual([
      503,
      { code: 14, message: "no org id" },
    ])
    const protobuf = await call("/v1/traces", {
      method: "POST",
      headers: { "content-type": "application/x-protobuf" },
      body: encodeTraceRequest(fixture()).slice().buffer,
    })
    expect(protobuf.status).toBe(503)
    expect(decodeRpcStatus(new Uint8Array(await protobuf.arrayBuffer()))).toEqual({
      code: 14,
      message: "no org id",
    })
    const federated = await push(fixture(), { "X-Scope-OrgID": "tenant-a|tenant-b" })
    expect([federated.status, await federated.json()]).toEqual([
      400,
      { code: 3, message: "multiple org IDs present" },
    ])
    // An export without spans is answered before the tenant is looked at.
    expect((await push({ resourceSpans: [] })).status).toBe(200)
    expect((await push(fixture(), { "X-Scope-OrgID": "tenant-a" })).status).toBe(200)
    expect((await get(`/api/traces/${TRACE}`, { "X-Scope-OrgID": "tenant-a" })).status).toBe(200)
    expect((await get(`/api/traces/${TRACE}`, { "X-Scope-OrgID": "tenant-b" })).status).toBe(404)
    // Cross-tenant federation: either tenant's data.
    expect(
      (await get(`/api/traces/${TRACE}`, { "X-Scope-OrgID": "tenant-b|tenant-a" })).status,
    ).toBe(200)
  })

  test("methods, gzip, snake_case and 64-bit numbers", async () => {
    const { push, call, get } = harness()
    const wrongMethod = await call("/v1/traces")
    expect([wrongMethod.status, await wrongMethod.text()]).toEqual([
      405,
      "405 method not allowed, supported: [POST]",
    ])
    const empty = await call("/v1/traces", {
      method: "POST",
      headers: { "content-type": "application/json" },
    })
    expect(empty.status).toBe(400)
    expect(await empty.json()).toMatchObject({ code: 3 })

    const gzipped = await new Response(
      new Blob([JSON.stringify(fixture())]).stream().pipeThrough(new CompressionStream("gzip")),
    ).arrayBuffer()
    const compressed = await call("/v1/traces", {
      method: "POST",
      headers: { "content-type": "application/json", "content-encoding": "gzip" },
      body: gzipped,
    })
    expect(compressed.status).toBe(200)
    expect((await get(`/api/traces/${TRACE}`)).status).toBe(200)

    // The documented curl example: uppercase hex ids and nanoseconds as JSON numbers.
    const documented = await push({
      resourceSpans: [
        {
          resource: { attributes: [{ key: "service.name", value: { stringValue: "my.service" } }] },
          scope_spans: [
            {
              scope: { name: "my.library", version: "1.0.0" },
              spans: [
                {
                  trace_id: "5B8EFFF798038103D269B633813FC700",
                  span_id: "EEE19B7EC3C1B100",
                  name: "I am a span!",
                  start_time_unix_nano: 1689969302000000000,
                  end_time_unix_nano: 1689970000000000000,
                  kind: "SPAN_KIND_SERVER",
                  attributes: [{ key: "my.span.attr", value: { stringValue: "some value" } }],
                },
              ],
            },
          ],
        },
      ],
    })
    expect(documented.status).toBe(200)
    // The body Grafana documents for this trace, under v1's `batches`.
    expect(JSON.parse((await get("/api/traces/5b8efff798038103d269b633813fc700")).body)).toEqual({
      batches: [
        {
          resource: { attributes: [{ key: "service.name", value: { stringValue: "my.service" } }] },
          scopeSpans: [
            {
              scope: { name: "my.library", version: "1.0.0" },
              spans: [
                {
                  traceId: "W47/95gDgQPSabYzgT/HAA==",
                  spanId: "7uGbfsPBsQA=",
                  name: "I am a span!",
                  kind: "SPAN_KIND_SERVER",
                  startTimeUnixNano: "1689969302000000000",
                  endTimeUnixNano: "1689970000000000000",
                  attributes: [{ key: "my.span.attr", value: { stringValue: "some value" } }],
                  status: {},
                },
              ],
            },
          ],
        },
      ],
    })
  })
})
