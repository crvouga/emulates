import { describe, expect, test } from "bun:test"
import { createRuntime, decodeRpcStatus, parseTraceQL, type Settings } from "./src/index.js"
import { tracesExport } from "./test/consumer.js"
import { encodeTraceRequest } from "./test/otlp-proto.js"

/** Hostile and out-of-range input ends in the vendor's 4xx, never a 500 or a wrong answer. */
const API = "http://tempo.mock"
const T = 1_700_000_000
const ns = (seconds: number) => `${BigInt(seconds) * 1_000_000_000n}`
const TRACE = "5b8efff798038103d269b633813fc7a1"
const SPAN = "eee19b7ec3c1b101"

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
  const pushProtobuf = (bytes: Uint8Array) =>
    call("/v1/traces", {
      method: "POST",
      headers: { "content-type": "application/x-protobuf" },
      body: bytes.slice().buffer,
    })
  const admin = (path: string, body: unknown, method = "POST") =>
    call(`/__admin${path}`, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
  return { runtime, call, push, pushProtobuf, admin }
}

const span = (overrides: Record<string, unknown> = {}, resource: Record<string, string> = {}) => ({
  resourceSpans: [
    {
      resource: {
        attributes: Object.entries(resource).map(([key, value]) => ({
          key,
          value: { stringValue: value },
        })),
      },
      scopeSpans: [
        {
          spans: [
            {
              traceId: TRACE,
              spanId: SPAN,
              name: "x",
              startTimeUnixNano: ns(T),
              endTimeUnixNano: ns(T + 1),
              ...overrides,
            },
          ],
        },
      ],
    },
  ],
})

const refused = async (response: Response) => [response.status, (await response.json()) as unknown]

describe("ingest", () => {
  test("a service named like an Object.prototype member is counted, and nothing leaks into the process", async () => {
    const { push, call } = harness()
    expect(
      (await push(span({ status: { code: 2 } }, { "service.name": "__proto__" }))).status,
    ).toBe(200)
    const body = (await (await call("/api/search")).json()) as {
      traces: { serviceStats: Record<string, unknown> }[]
    }
    expect(Object.keys(body.traces[0]?.serviceStats ?? {})).toEqual(["__proto__"])
    expect(
      Object.getOwnPropertyDescriptor(body.traces[0]?.serviceStats, "__proto__")?.value,
    ).toEqual({
      spanCount: 1,
      errorCount: 1,
    })
    expect(({} as Record<string, unknown>).spanCount).toBeUndefined()
    expect(({} as Record<string, unknown>).errorCount).toBeUndefined()

    const other = harness()
    await other.push(span({}, { "service.name": "constructor" }))
    const stats = (
      (await (await other.call("/api/search")).json()) as {
        traces: { serviceStats: Record<string, unknown> }[]
      }
    ).traces[0]?.serviceStats
    expect(JSON.stringify(stats)).toBe('{"constructor":{"spanCount":1}}')
  })

  test("values outside their wire width are refused with INVALID_ARGUMENT", async () => {
    const { push, call } = harness()
    const attribute = (value: unknown) => span({ attributes: [{ key: "k", value }] })
    for (const payload of [
      attribute({ intValue: 1e21 }),
      attribute({ intValue: -1e21 }),
      attribute({ intValue: "9223372036854775808" }),
      attribute({ intValue: 1.5 }),
      attribute({ doubleValue: "abc" }),
      attribute({ doubleValue: "0x10" }),
      attribute({ arrayValue: { values: [{ intValue: 1e21 }] } }),
      span({ startTimeUnixNano: "18446744073709551616" }),
      span({ flags: 2 ** 40 }),
      span({ droppedAttributesCount: 1.9 }),
      span({ parentSpanId: "ab" }),
      span({ parentSpanId: "eee19b7ec3c1b10100" }),
      span({ links: [{ traceId: "ab", spanId: SPAN }] }),
      span({ kind: 2 ** 40 }),
    ]) {
      const response = await push(payload)
      expect([JSON.stringify(payload).slice(-120), response.status]).toEqual([
        JSON.stringify(payload).slice(-120),
        400,
      ])
      expect(await response.json()).toMatchObject({ code: 3 })
    }
    // Nothing above was stored, so a search that reads every attribute still answers.
    const search = await call(`/api/search?q=${encodeURIComponent("{ .k = 1 }")}`)
    expect([search.status, await search.json()]).toEqual([
      200,
      { traces: [], metrics: { completedJobs: 1, totalJobs: 1 } },
    ])
    // The edges of each width are fine.
    const edges = await push(
      span({
        startTimeUnixNano: "18446744073709551615",
        endTimeUnixNano: "18446744073709551615",
        flags: 2 ** 32 - 1,
        attributes: [
          { key: "max", value: { intValue: "9223372036854775807" } },
          { key: "min", value: { intValue: "-9223372036854775808" } },
          { key: "big", value: { intValue: 2 ** 53 } },
          { key: "nan", value: { doubleValue: "NaN" } },
          { key: "exp", value: { doubleValue: "1e3" } },
        ],
      }),
    )
    expect(edges.status).toBe(200)
    const max = await call(`/api/search?q=${encodeURIComponent("{ .max = 9223372036854775807 }")}`)
    expect(((await max.json()) as { traces: unknown[] }).traces).toHaveLength(1)
    const exp = await call(`/api/search?q=${encodeURIComponent("{ .exp = 1000 }")}`)
    expect(((await exp.json()) as { traces: unknown[] }).traces).toHaveLength(1)
  })

  test("a value nested past the depth cap is refused in both encodings, never recursed into", async () => {
    const { push, pushProtobuf } = harness()
    let nested: Record<string, unknown> = { stringValue: "leaf" }
    for (let i = 0; i < 500; i++) nested = { arrayValue: { values: [nested] } }
    const json = await push(span({ attributes: [{ key: "deep", value: nested }] }))
    expect(await refused(json)).toEqual([400, { code: 3, message: expect.any(String) }])

    // AnyValue{array_value{values{…}}} 500 deep, built inside out.
    let bytes: number[] = [0x0a, 0x01, 0x78]
    const varint = (n: number) => {
      const out: number[] = []
      let rest = n
      while (rest > 0x7f) {
        out.push((rest & 0x7f) | 0x80)
        rest >>>= 7
      }
      out.push(rest)
      return out
    }
    for (let i = 0; i < 500; i++) {
      const array = [0x0a, ...varint(bytes.length), ...bytes]
      bytes = [0x2a, ...varint(array.length), ...array]
    }
    const wrap = (field: number, inner: number[]) => [
      (field << 3) | 2,
      ...varint(inner.length),
      ...inner,
    ]
    const keyValue = [...wrap(1, [0x6b]), ...wrap(2, bytes)]
    const request = wrap(1, wrap(2, wrap(2, wrap(9, keyValue))))
    const protobuf = await pushProtobuf(new Uint8Array(request))
    expect(protobuf.status).toBe(400)
    expect(decodeRpcStatus(new Uint8Array(await protobuf.arrayBuffer()))).toMatchObject({ code: 3 })
    // A depth real telemetry reaches is fine.
    let shallow: Record<string, unknown> = { stringValue: "leaf" }
    for (let i = 0; i < 20; i++) shallow = { arrayValue: { values: [shallow] } }
    expect((await push(span({ attributes: [{ key: "ok", value: shallow }] }))).status).toBe(200)
  })

  test("protobuf: a tag past 29 bits is not read as a small field; unknown enum values survive as numbers", async () => {
    const { pushProtobuf, call } = harness()
    const valid = encodeTraceRequest(tracesExport({ "service.name": "api" }, []))
    // 2^32 + 10 as a varint tag would alias field 1, wire type 2.
    const aliased = new Uint8Array([0x8a, 0x80, 0x80, 0x80, 0x10, ...valid.slice(1)])
    const response = await pushProtobuf(aliased)
    expect(response.status).toBe(400)
    expect(decodeRpcStatus(new Uint8Array(await response.arrayBuffer())).code).toBe(3)

    const exported = span({ kind: 7, status: { code: 3 } }) as {
      resourceSpans: Record<string, unknown>[]
    }
    expect((await pushProtobuf(encodeTraceRequest(exported))).status).toBe(200)
    const read = async () =>
      (
        (await (await call(`/api/traces/${TRACE}`)).json()) as {
          batches: { scopeSpans: { spans: { kind: unknown; status: unknown }[] }[] }[]
        }
      ).batches[0]?.scopeSpans[0]?.spans[0]
    expect(await read()).toMatchObject({ kind: 7, status: { code: 3 } })
    // An int32 enum arrives as a ten-byte varint when negative.
    expect((await pushProtobuf(encodeTraceRequest(span({ kind: -1 })))).status).toBe(200)
    expect(await read()).toMatchObject({ kind: -1 })
  })

  test("a gzip body that does not inflate is refused only after routing and the credential check", async () => {
    const { call } = harness({ bearerTokens: ["tempo-token-1"] })
    const garbage = (path: string, headers: Record<string, string> = {}) =>
      call(path, {
        method: "POST",
        headers: { "content-type": "application/json", "content-encoding": "gzip", ...headers },
        body: "not gzip",
      })
    expect((await garbage("/nope")).status).toBe(404)
    expect((await garbage("/v1/traces")).status).toBe(401)
    const authenticated = await garbage("/v1/traces", { authorization: "Bearer tempo-token-1" })
    expect(await refused(authenticated)).toEqual([
      400,
      { code: 3, message: "gzip: invalid header" },
    ])
  })

  test("the all-zero trace id is stored; search prints its trimmed id as nothing", async () => {
    const { push, call } = harness()
    expect((await push(span({ traceId: "0".repeat(32) }))).status).toBe(200)
    const body = (await (await call("/api/search")).json()) as { traces: Record<string, unknown>[] }
    expect(body.traces).toHaveLength(1)
    expect(body.traces[0]).not.toHaveProperty("traceID")
    expect((await call("/api/traces/0")).status).toBe(200)
  })
})

describe("query routes", () => {
  test("a malformed percent-escape in the trace id is a 400", async () => {
    const { call } = harness()
    for (const path of ["/api/traces/%zz", "/api/traces/%E0%A4%A"]) {
      const response = await call(path)
      expect([path, response.status]).toEqual([path, 400])
    }
  })

  test("64-bit start and end on trace by id compare exactly", async () => {
    const { push, call } = harness()
    await push(span())
    const huge = await call(
      `/api/traces/${TRACE}?start=9223372036854775806&end=9223372036854775807`,
    )
    expect(huge.status).toBe(200)
    const reversed = await call(
      `/api/traces/${TRACE}?start=9223372036854775807&end=9223372036854775806`,
    )
    expect([reversed.status, await reversed.text()]).toEqual([
      400,
      "http parameter start must be before end. received start=9223372036854775807 end=9223372036854775806",
    ])
  })

  test("a window needs both start and end, as Tempo's block filter does", async () => {
    const { push, call } = harness()
    await push(span())
    // `end` alone passes validation (start is 0) and applies no window.
    const open = (await (await call("/api/search?end=5")).json()) as { traces: unknown[] }
    expect(open.traces).toHaveLength(1)
    const closed = (await (await call("/api/search?start=1&end=5")).json()) as { traces: unknown[] }
    expect(closed.traces).toHaveLength(0)
  })
})

describe("TraceQL lexing follows Go's scanner", () => {
  const error = (query: string): string => {
    try {
      parseTraceQL(query)
    } catch (e) {
      return (e as Error).message
    }
    return "accepted"
  }

  test("only tab, newline, carriage return and space separate tokens", () => {
    expect(parseTraceQL("{\t.a\n=\r1 }").conditions).toHaveLength(1)
    for (const space of [" ", " ", "﻿", "\v", "\f", "　"]) {
      expect([JSON.stringify(space), error(`{${space}true${space}}`)]).toEqual([
        JSON.stringify(space),
        "parse error at line 1, col 2: syntax error: unexpected IDENTIFIER",
      ])
    }
    // A Unicode space still ends an attribute name.
    expect(error('{ .a = "b" }')).toBe(
      "parse error at line 1, col 5: syntax error: unexpected IDENTIFIER",
    )
  })

  test("string and number literals as strconv reads them", () => {
    expect(parseTraceQL('{ .a = "\\101\\x42\\u0043" }').conditions[0]?.value).toEqual({
      type: "string",
      value: "ABC",
    })
    expect(error('{ .a = "\\ud800" }')).toBe("parse error at line 1, col 8: invalid syntax")
    expect(error('{ .a = "\\q" }')).toBe("parse error at line 1, col 8: invalid syntax")
    expect(error("{ .a = 08 }")).toBe(
      "parse error at line 1, col 8: invalid digit '8' in octal literal",
    )
    expect(parseTraceQL("{ .a = 010 }").conditions[0]?.value).toEqual({ type: "int", value: 10n })
    expect(error("{ .a = 99999999999999999999999 }")).toBe(
      'parse error at line 1, col 8: strconv.Atoi: parsing "99999999999999999999999": value out of range',
    )
    expect(error("{ .a = 1e999 }")).toBe(
      'parse error at line 1, col 8: strconv.ParseFloat: parsing "1e999": value out of range',
    )
  })

  test("columns count characters, and a long run of digits lexes in linear time", () => {
    expect(error('{ .a = "😀" x }')).toBe(
      "parse error at line 1, col 12: syntax error: unexpected IDENTIFIER",
    )
    const started = performance.now()
    expect(error(`{ .a = 1${".1".repeat(40_000)} }`)).toContain("parse error")
    // Milliseconds when linear; the quadratic scan this guards against took minutes at this
    // size. The bound is loose because CI machines are shared.
    expect(performance.now() - started).toBeLessThan(20_000)
  }, 60_000)
})

describe("admin input", () => {
  test("settings and custom faults cannot push the emulator outside its contract", async () => {
    const { admin, push } = harness()
    for (const bad of [
      { basicUsers: [{}] },
      { basicUsers: [{ username: "" }] },
      { basicUsers: [{ username: "u", password: 1 }] },
      { unauthorized: { status: 418.5 } },
      { unauthorized: { status: 499 } },
    ]) {
      expect([JSON.stringify(bad), (await admin("/settings", bad, "PUT")).status]).toEqual([
        JSON.stringify(bad),
        400,
      ])
    }
    expect(
      (
        await admin(
          "/settings",
          { bearerTokens: ["t"], unauthorized: { status: 403, body: "Forbidden" } },
          "PUT",
        )
      ).status,
    ).toBe(200)
    const forbidden = await push(span())
    expect([forbidden.status, await forbidden.text()]).toEqual([403, "Forbidden"])

    // A hand-written ingest fault with a status the route never returns falls back to 503.
    await admin("/settings", { bearerTokens: [] }, "PUT")
    for (const status of [999, "abc", 204]) {
      await admin("/faults", {
        operationId: "ExportTraces",
        effect: "ingest_error",
        params: { status, code: "x" },
        count: 1,
      })
      expect(await refused(await push(span()))).toEqual([503, { code: 14, message: "unavailable" }])
    }
  })
})
