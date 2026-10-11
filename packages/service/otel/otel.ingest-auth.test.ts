import { describe, expect, test } from "bun:test"
import { context, trace } from "@opentelemetry/api"
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http"
import { OTLPTraceExporter as OTLPProtoTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto"
import { resourceFromAttributes } from "@opentelemetry/resources"
import { BasicTracerProvider, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base"
import { createRuntime, DEFAULT_SETTINGS, type Settings } from "./src/index.js"
import { createServer, serveTarget } from "./src/server.js"

/**
 * Collector auth modes and browser CORS: an OTLP exporter is tested unchanged against a
 * collector that takes no credentials (a local collector), Basic credentials (a hosted OTLP
 * gateway: `Authorization: Basic base64(instanceId:token)`) or a bearer token (the default).
 */
const HOST = "http://otel.mock"
const TRACE_ID = "5b8efff798038103d269b633813fc60c"
const ROOT_SPAN_ID = "eee19b7ec3c1b174"
const CHILD_SPAN_ID = "eee19b7ec3c1b175"
const START_NS = 1_700_000_000_000_000_000n
const CHILD_START_NS = START_NS + 50_000_000n
const EVENT_NS = START_NS + 75_000_000n
const CHILD_END_NS = START_NS + 200_000_000n
const END_NS = START_NS + 250_000_000n

const INSTANCE_ID = "123456"
const GATEWAY_TOKEN = "otlp-gateway-write-token"
/** What a hosted-gateway exporter sends: `OTEL_EXPORTER_OTLP_HEADERS=Authorization=Basic <this>`. */
const BASIC = `Basic ${btoa(`${INSTANCE_ID}:${GATEWAY_TOKEN}`)}`
const BASIC_SETTINGS: Partial<Settings> = {
  ingestAuth: "basic",
  ingestUsers: [{ username: INSTANCE_ID, password: GATEWAY_TOKEN }],
}

/** A root span and its child, as OTLP/JSON. */
const TRACE_JSON = {
  resourceSpans: [
    {
      resource: { attributes: [{ key: "service.name", value: { stringValue: "checkout" } }] },
      scopeSpans: [
        {
          scope: { name: "@acme/telemetry" },
          spans: [
            {
              traceId: TRACE_ID,
              spanId: ROOT_SPAN_ID,
              name: "POST /orders",
              kind: 2,
              startTimeUnixNano: String(START_NS),
              endTimeUnixNano: String(END_NS),
              attributes: [
                { key: "http.method", value: { stringValue: "POST" } },
                { key: "http.status_code", value: { intValue: "201" } },
              ],
              status: { code: 1 },
            },
            {
              traceId: TRACE_ID,
              spanId: CHILD_SPAN_ID,
              parentSpanId: ROOT_SPAN_ID,
              name: "orders.insert",
              kind: 3,
              startTimeUnixNano: String(CHILD_START_NS),
              endTimeUnixNano: String(CHILD_END_NS),
              attributes: [{ key: "db.system", value: { stringValue: "postgresql" } }],
              events: [
                {
                  timeUnixNano: String(EVENT_NS),
                  name: "retry",
                  attributes: [{ key: "attempt", value: { intValue: "2" } }],
                },
              ],
              status: { code: 2, message: "deadlock detected" },
            },
          ],
        },
      ],
    },
  ],
}

// ── the same request in the protobuf wire format (opentelemetry-proto v1 field numbers) ──────
const join = (...parts: Uint8Array[]): Uint8Array<ArrayBuffer> => {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0))
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}
const varint = (value: number): Uint8Array => {
  const bytes: number[] = []
  let rest = BigInt(value)
  do {
    const byte = Number(rest & 0x7fn)
    rest >>= 7n
    bytes.push(rest > 0n ? byte | 0x80 : byte)
  } while (rest > 0n)
  return Uint8Array.from(bytes)
}
const message = (field: number, value: Uint8Array) =>
  join(varint((field << 3) | 2), varint(value.length), value)
const text = (field: number, value: string) => message(field, new TextEncoder().encode(value))
const uint = (field: number, value: number) => join(varint(field << 3), varint(value))
const fixed64 = (field: number, value: bigint) => {
  const bytes = new Uint8Array(8)
  new DataView(bytes.buffer).setBigUint64(0, value, true)
  return join(varint((field << 3) | 1), bytes)
}
const id = (field: number, hex: string) =>
  message(
    field,
    Uint8Array.from(hex.match(/../g) ?? [], (pair) => Number.parseInt(pair, 16)),
  )
const attribute = (field: number, key: string, value: string | number) =>
  message(
    field,
    join(text(1, key), message(2, typeof value === "string" ? text(1, value) : uint(3, value))),
  )

const TRACE_PROTOBUF = message(
  1,
  join(
    message(1, attribute(1, "service.name", "checkout")),
    message(
      2,
      join(
        message(1, text(1, "@acme/telemetry")),
        message(
          2,
          join(
            id(1, TRACE_ID),
            id(2, ROOT_SPAN_ID),
            text(5, "POST /orders"),
            uint(6, 2),
            fixed64(7, START_NS),
            fixed64(8, END_NS),
            attribute(9, "http.method", "POST"),
            attribute(9, "http.status_code", 201),
            message(15, uint(3, 1)),
          ),
        ),
        message(
          2,
          join(
            id(1, TRACE_ID),
            id(2, CHILD_SPAN_ID),
            id(4, ROOT_SPAN_ID),
            text(5, "orders.insert"),
            uint(6, 3),
            fixed64(7, CHILD_START_NS),
            fixed64(8, CHILD_END_NS),
            attribute(9, "db.system", "postgresql"),
            message(11, join(fixed64(1, EVENT_NS), text(2, "retry"), attribute(3, "attempt", 2))),
            message(15, join(text(2, "deadlock detected"), uint(3, 2))),
          ),
        ),
      ),
    ),
  ),
)

/** `google.rpc.Status { int32 code = 1; string message = 2 }` out of its binary encoding. */
const decodeStatus = (bytes: Uint8Array): { code: number; message: string } => {
  const status = { code: 0, message: "" }
  let at = 0
  while (at < bytes.length) {
    const key = bytes[at++] as number
    if (key === 0x08) status.code = bytes[at++] as number
    else if (key === 0x12) {
      const length = bytes[at++] as number
      status.message = new TextDecoder().decode(bytes.subarray(at, at + length))
      at += length
    } else throw new Error(`unexpected Status field key ${key}`)
  }
  return status
}

type Row = Record<string, unknown>

const harness = (settings: Partial<Settings> = {}) => {
  const runtime = createRuntime({ settings })
  const call = (path: string, init: RequestInit = {}) =>
    runtime.fetch(new Request(`${HOST}${path}`, init))
  const exportTraces = (headers: Record<string, string> = {}, body: unknown = TRACE_JSON) =>
    call("/v1/traces", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    })
  const exportProtobuf = (headers: Record<string, string> = {}, body = TRACE_PROTOBUF) =>
    call("/v1/traces", {
      method: "POST",
      headers: { "content-type": "application/x-protobuf", ...headers },
      body,
    })
  const spans = async (path = "") =>
    ((await (await call(`${path}/__admin/spans?trace_id=${TRACE_ID}`)).json()) as { spans: Row[] })
      .spans
  const putSettings = (body: unknown) =>
    call("/__admin/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
  return { runtime, call, exportTraces, exportProtobuf, spans, putSettings }
}

const UNAUTHENTICATED = { code: 16, message: "Unauthenticated" }

describe("OTLP collector auth modes", () => {
  test("1. auth=none: an export without credentials succeeds; the mode is opt-in", async () => {
    // Opt-in: the default collector still wants a bearer token.
    const byDefault = harness()
    const refused = await byDefault.exportTraces()
    expect(refused.status).toBe(401)
    expect(await refused.json()).toEqual(UNAUTHENTICATED)
    expect(await byDefault.spans()).toEqual([])

    const open = harness({ ingestAuth: "none" })
    const accepted = await open.exportTraces()
    expect(accepted.status).toBe(200)
    expect(await accepted.json()).toEqual({ partialSuccess: {} })
    expect((await open.spans()).map((span) => span.span_id)).toEqual([ROOT_SPAN_ID, CHILD_SPAN_ID])
    // An unauthenticated collector ignores credentials an exporter still sends.
    expect((await open.exportTraces({ authorization: "Bearer anything" })).status).toBe(200)
    expect((await open.exportTraces({ authorization: BASIC })).status).toBe(200)
    // Only the receiver is opened: the search API still wants Basic credentials.
    expect((await open.call("/api/organizations")).status).toBe(401)

    // The same switch at runtime, per namespace, through the settings route.
    expect(
      ((await (await byDefault.call("/__admin/settings")).json()) as Settings).ingestAuth,
    ).toBe("bearer")
    const switched = await byDefault.putSettings({ ingestAuth: "none" })
    expect(switched.status).toBe(200)
    expect(((await switched.json()) as Settings).ingestAuth).toBe("none")
    expect((await byDefault.exportTraces()).status).toBe(200)
    expect((await byDefault.putSettings({ ingestAuth: "open" })).status).toBe(400)
  })

  test("2. auth=basic: a gateway exporter's Basic header is accepted; missing or wrong credentials are 401", async () => {
    const { exportTraces, exportProtobuf, spans } = harness(BASIC_SETTINGS)
    for (const authorization of [
      undefined,
      `Basic ${btoa(`${INSTANCE_ID}:wrong-token`)}`,
      `Basic ${btoa(`654321:${GATEWAY_TOKEN}`)}`,
      // A Basic collector does not take the token as a bearer token.
      `Bearer ${GATEWAY_TOKEN}`,
      "Basic not-base64!",
    ]) {
      const refused = await exportTraces(authorization === undefined ? {} : { authorization })
      expect(refused.status).toBe(401)
      expect(await refused.json()).toEqual(UNAUTHENTICATED)
    }
    expect(await spans()).toEqual([])
    expect((await exportTraces({ authorization: BASIC })).status).toBe(200)
    expect((await exportProtobuf({ authorization: BASIC })).status).toBe(200)
    expect(await spans()).toHaveLength(4)

    // No configured users: any Basic credentials pass, none is still a 401.
    const anyUser = harness({ ingestAuth: "basic" })
    expect((await anyUser.exportTraces()).status).toBe(401)
    expect((await anyUser.exportTraces({ authorization: `Basic ${btoa("1:t")}` })).status).toBe(200)

    // The OpenTelemetry SDK's own exporters, configured exactly as for the hosted gateway.
    const server = await createServer({ settings: BASIC_SETTINGS })
    try {
      for (const Exporter of [OTLPTraceExporter, OTLPProtoTraceExporter]) {
        const provider = new BasicTracerProvider({
          resource: resourceFromAttributes({ "service.name": "gateway-exporter" }),
          spanProcessors: [
            new SimpleSpanProcessor(
              new Exporter({ url: `${server.url}/v1/traces`, headers: { Authorization: BASIC } }),
            ),
          ],
        })
        const tracer = provider.getTracer("@acme/telemetry")
        const parent = tracer.startSpan("parent")
        const child = tracer.startSpan("child", {}, trace.setSpan(context.active(), parent))
        child.end()
        parent.end()
        await provider.forceFlush()
        await provider.shutdown()
        const stored = (
          (await (
            await fetch(`${server.url}/__admin/spans?trace_id=${parent.spanContext().traceId}`)
          ).json()) as { spans: Row[] }
        ).spans
        expect(stored.map((span) => [span.operation_name, span.span_id])).toEqual(
          expect.arrayContaining([
            ["parent", parent.spanContext().spanId],
            ["child", child.spanContext().spanId],
          ]),
        )
        expect(
          stored.find((span) => span.operation_name === "child")?.reference_parent_span_id,
        ).toBe(parent.spanContext().spanId)
      }
    } finally {
      await server.close()
    }
  }, 30_000)

  test("3. auth=bearer stays the default: any token, or only the configured ones", async () => {
    expect(DEFAULT_SETTINGS.ingestAuth).toBe("bearer")
    for (const settings of [{}, { ingestAuth: "bearer" }] satisfies Partial<Settings>[]) {
      const anyToken = harness(settings)
      expect((await anyToken.exportTraces()).status).toBe(401)
      // A Basic header is not a bearer token.
      expect((await anyToken.exportTraces({ authorization: BASIC })).status).toBe(401)
      expect((await anyToken.exportTraces({ authorization: "Bearer any-token" })).status).toBe(200)

      const pinned = harness({ ...settings, ingestTokens: ["otel-ingest-token"] })
      const wrong = await pinned.exportTraces({ authorization: "Bearer wrong" })
      expect(wrong.status).toBe(401)
      expect(await wrong.json()).toEqual(UNAUTHENTICATED)
      expect(
        (await pinned.exportTraces({ authorization: "Bearer otel-ingest-token" })).status,
      ).toBe(200)
      // Basic users are only read in basic mode.
      const ignored = harness({ ...settings, ingestUsers: BASIC_SETTINGS.ingestUsers ?? [] })
      expect((await ignored.exportTraces({ authorization: "Bearer any-token" })).status).toBe(200)
    }
  })

  test("4. CORS: a preflight succeeds only for allowed origins, headers and methods; the export carries the headers", async () => {
    const ORIGIN = "https://app.example.test"
    const REQUESTED = "authorization,content-type,traceparent,tracestate"
    const { call, exportTraces, putSettings, runtime } = harness({
      ingestAuth: "none",
      cors: {
        allowedOrigins: [ORIGIN, "https://*.preview.example.test"],
        allowedHeaders: ["Authorization", "Content-Type", "traceparent", "tracestate"],
        exposedHeaders: ["x-mockingbird"],
        maxAge: 600,
      },
    })
    const preflight = (headers: Record<string, string>, path = "/v1/traces") =>
      call(path, { method: "OPTIONS", headers })
    const browser = {
      origin: ORIGIN,
      "access-control-request-method": "POST",
      "access-control-request-headers": REQUESTED,
    }

    const allowed = await preflight(browser)
    expect(allowed.status).toBe(204)
    expect(await allowed.text()).toBe("")
    expect(allowed.headers.get("access-control-allow-origin")).toBe(ORIGIN)
    expect(allowed.headers.get("access-control-allow-methods")).toBe("POST")
    expect(allowed.headers.get("access-control-allow-headers")).toBe(REQUESTED)
    expect(allowed.headers.get("access-control-allow-credentials")).toBe("true")
    expect(allowed.headers.get("access-control-max-age")).toBe("600")
    expect(allowed.headers.get("vary")).toBe(
      "Origin, Access-Control-Request-Method, Access-Control-Request-Headers",
    )
    // Every receiver route, and origins matching a wildcard.
    for (const path of ["/v1/logs", "/v1/metrics"]) {
      expect((await preflight(browser, path)).headers.get("access-control-allow-origin")).toBe(
        ORIGIN,
      )
    }
    const preview = "https://pr-12.preview.example.test"
    expect(
      (await preflight({ ...browser, origin: preview })).headers.get("access-control-allow-origin"),
    ).toBe(preview)

    // Refused preflights answer without the CORS headers, which is what makes a browser fail them.
    for (const refusedHeaders of [
      { ...browser, origin: "https://evil.example.test" },
      { ...browser, "access-control-request-headers": `${REQUESTED},x-api-key` },
      { ...browser, "access-control-request-method": "DELETE" },
    ]) {
      const refused = await preflight(refusedHeaders)
      expect(refused.status).toBe(204)
      expect(refused.headers.get("access-control-allow-origin")).toBeNull()
      expect(refused.headers.get("access-control-allow-methods")).toBeNull()
      expect(refused.headers.get("access-control-allow-headers")).toBeNull()
    }

    // The export itself.
    const exported = await exportTraces({ origin: ORIGIN })
    expect(exported.status).toBe(200)
    expect(exported.headers.get("access-control-allow-origin")).toBe(ORIGIN)
    expect(exported.headers.get("access-control-allow-credentials")).toBe("true")
    expect(exported.headers.get("access-control-expose-headers")).toBe("x-mockingbird")
    expect(exported.headers.get("vary")).toBe("Origin")
    const foreign = await exportTraces({ origin: "https://evil.example.test" })
    expect(foreign.status).toBe(200)
    expect(foreign.headers.get("access-control-allow-origin")).toBeNull()
    // The journal still names the export and what it accepted.
    expect(runtime.journal.list({ operationId: "ExportTraces" }).at(-1)?.ids?.accepted).toBe("2")

    // A rejected export answers its error with the headers too, so the page can read it;
    // a fault preset is aimed at exports and leaves the preflight alone.
    await putSettings({ ingestAuth: "bearer" })
    const unauthenticated = await exportTraces({ origin: ORIGIN })
    expect(unauthenticated.status).toBe(401)
    expect(unauthenticated.headers.get("access-control-allow-origin")).toBe(ORIGIN)
    runtime.applyPreset("rate_limited", "default", { count: 1 })
    expect((await preflight(browser)).status).toBe(204)
    expect((await exportTraces({ origin: ORIGIN, authorization: "Bearer t" })).status).toBe(429)

    // Narrower methods and any header.
    const narrowed = await putSettings({
      cors: { allowedOrigins: ["*"], allowedHeaders: ["*"], allowedMethods: ["GET"] },
    })
    expect(narrowed.status).toBe(200)
    expect((await preflight(browser)).headers.get("access-control-allow-origin")).toBeNull()
    const anyHeader = await preflight({
      ...browser,
      "access-control-request-method": "GET",
      "access-control-request-headers": "x-anything",
    })
    expect(anyHeader.headers.get("access-control-allow-origin")).toBe("*")
    expect(anyHeader.headers.get("access-control-max-age")).toBeNull()
    expect((await putSettings({ cors: { allowedOrigins: "*" } })).status).toBe(400)

    // Off unless origins are configured: no preflight, no headers.
    const off = harness({ ingestAuth: "none" })
    const unhandled = await off.call("/v1/traces", { method: "OPTIONS", headers: browser })
    expect(unhandled.status).toBe(405)
    expect(unhandled.headers.get("access-control-allow-origin")).toBeNull()
    const plain = await off.exportTraces({ origin: ORIGIN })
    expect(plain.status).toBe(200)
    expect(plain.headers.get("access-control-allow-origin")).toBeNull()
    expect(plain.headers.get("vary")).toBeNull()
  })

  test("5. every mode stores the same spans, ids, links, attributes, events and timing; bad payloads are OTLP errors", async () => {
    const modes: { settings: Partial<Settings>; headers: Record<string, string> }[] = [
      { settings: { ingestAuth: "none" }, headers: {} },
      { settings: BASIC_SETTINGS, headers: { authorization: BASIC } },
      { settings: {}, headers: { authorization: "Bearer otel-ingest-token" } },
    ]
    const expected = [
      {
        _stream: "default",
        service_name: "checkout",
        instrumentation_library_name: "@acme/telemetry",
        trace_id: TRACE_ID,
        span_id: ROOT_SPAN_ID,
        operation_name: "POST /orders",
        span_kind: "2",
        span_status: "OK",
        http_method: "POST",
        http_status_code: 201,
        start_time: Number(START_NS),
        end_time: Number(END_NS),
        duration: 250_000,
        _timestamp: 1_700_000_000_000_000,
        events: "[]",
      },
      {
        _stream: "default",
        service_name: "checkout",
        instrumentation_library_name: "@acme/telemetry",
        trace_id: TRACE_ID,
        span_id: CHILD_SPAN_ID,
        reference_parent_span_id: ROOT_SPAN_ID,
        reference_ref_type: "ChildOf",
        operation_name: "orders.insert",
        span_kind: "3",
        span_status: "ERROR",
        db_system: "postgresql",
        start_time: Number(CHILD_START_NS),
        end_time: Number(CHILD_END_NS),
        duration: 150_000,
        _timestamp: 1_700_000_000_050_000,
        events: JSON.stringify([{ name: "retry", _timestamp: 1_700_000_000_075_000, attempt: 2 }]),
      },
    ]
    for (const { settings, headers } of modes) {
      for (const encoding of ["json", "protobuf"] as const) {
        const { exportTraces, exportProtobuf, spans } = harness(settings)
        const response = await (encoding === "json"
          ? exportTraces(headers)
          : exportProtobuf(headers))
        expect(response.status).toBe(200)
        // Nothing but the org the row landed in is added, and nothing is dropped.
        expect((await spans()).map(({ _org, ...row }) => row)).toEqual(expected)

        // Authorized or unauthenticated, a payload is still parsed: bad data is a 400
        // google.rpc.Status in the request's own encoding, and stores nothing.
        const notAnExport = await exportTraces(headers, [1, 2])
        expect(notAnExport.status).toBe(400)
        expect(notAnExport.headers.get("content-type")).toContain("application/json")
        expect(await notAnExport.json()).toEqual({
          code: 3,
          message: "request body is not an OTLP/JSON export request",
        })
        const truncated = await exportProtobuf(headers, TRACE_PROTOBUF.subarray(0, 40))
        expect(truncated.status).toBe(400)
        expect(truncated.headers.get("content-type")).toBe("application/x-protobuf")
        const status = decodeStatus(new Uint8Array(await truncated.arrayBuffer()))
        expect(status.code).toBe(3)
        expect(status.message).toContain("invalid protobuf")
        expect(await spans()).toHaveLength(2)
      }
    }
    // A refused protobuf export is told so in protobuf as well.
    const refused = await harness(BASIC_SETTINGS).exportProtobuf()
    expect(refused.status).toBe(401)
    expect(refused.headers.get("content-type")).toBe("application/x-protobuf")
    expect(decodeStatus(new Uint8Array(await refused.arrayBuffer()))).toEqual(UNAUTHENTICATED)
  })
})

describe("test controls in every auth mode", () => {
  test("fault presets and namespaces keep working without a bearer token", async () => {
    const open = harness({ ingestAuth: "none" })
    // No credential to map: an unauthenticated exporter picks its namespace by path prefix.
    expect((await open.call("/__admin/ns/worker-a/v1/traces", traceInit())).status).toBe(200)
    expect(await open.spans("/__admin/ns/worker-a")).toHaveLength(2)
    expect(await open.spans()).toEqual([])
    open.runtime.applyPreset("unauthorized", "default", { count: 1 })
    expect((await open.exportTraces()).status).toBe(401)
    expect((await open.exportTraces()).status).toBe(200)

    // A Basic collector's instance id is the credential a namespace maps from.
    const basic = harness(BASIC_SETTINGS)
    await basic.call("/__admin/credentials", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ credentials: { [INSTANCE_ID]: "worker-b" } }),
    })
    expect((await basic.exportTraces({ authorization: BASIC })).status).toBe(200)
    expect(await basic.spans("/__admin/ns/worker-b")).toHaveLength(2)
    expect(await basic.spans()).toEqual([])
  })

  test("serve flags pick the mode, the Basic credentials and the CORS origins", async () => {
    const common = { adminKey: undefined, seed: undefined, onLog: undefined }
    const settings = async (values: Record<string, string | boolean>) => {
      const runtime = await serveTarget.create(values, common)
      const response = await runtime.fetch(new Request(`${HOST}/__admin/settings`))
      return (await response.json()) as Settings
    }
    expect(await settings({})).toMatchObject({ ingestAuth: "bearer", ingestUsers: [] })
    expect(await settings({ "ingest-auth": "none" })).toMatchObject({ ingestAuth: "none" })
    expect(
      await settings({ "ingest-basic-auth": `${INSTANCE_ID}:${GATEWAY_TOKEN}` }),
    ).toMatchObject(BASIC_SETTINGS)
    expect(
      await settings({
        "cors-origins": "https://app.example.test, http://localhost:5173",
        "cors-headers": "authorization,content-type",
      }),
    ).toMatchObject({
      cors: {
        allowedOrigins: ["https://app.example.test", "http://localhost:5173"],
        allowedHeaders: ["authorization", "content-type"],
      },
    })
    expect(() => serveTarget.create({ "ingest-auth": "open" }, common)).toThrow("--ingest-auth")
  })
})

function traceInit(): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(TRACE_JSON),
  }
}
