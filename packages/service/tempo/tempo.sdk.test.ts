import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { ROOT_CONTEXT, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api"
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http"
import { OTLPTraceExporter as OTLPProtoTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto"
import { resourceFromAttributes } from "@opentelemetry/resources"
import { BasicTracerProvider, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base"
import { createServer, type TempoServer } from "./src/server.js"
import { type TempoAuth, TempoTraceReader, traceqlEquals } from "./test/consumer.js"

/**
 * The OpenTelemetry JS SDK at the versions the repository pins for its OTLP emulator
 * (`@opentelemetry/exporter-trace-otlp-http@0.201.1`, `-otlp-proto@0.201.1`,
 * `sdk-trace-base@2.0.1`), exporting to the served emulator exactly as an application does:
 * the exporter's `url` is `<origin>/v1/traces` and its `headers` carry the gateway credential.
 * The trace reader then finds what the SDK sent.
 */
const USER = "123456"
const TOKEN = "cloud-token-1"
const AUTH: TempoAuth = { kind: "basic", username: USER, token: TOKEN }
const HEADERS = { Authorization: `Basic ${btoa(`${USER}:${TOKEN}`)}` }

let server: TempoServer

beforeAll(async () => {
  server = await createServer({
    settings: { basicUsers: [{ username: USER, password: TOKEN }] },
  })
})

afterAll(async () => {
  await server.close()
})

type Encoding = "json" | "protobuf"

const provider = (serviceName: string, encoding: Encoding, headers: Record<string, string>) => {
  const url = `${server.url}/v1/traces`
  const exporter =
    encoding === "json"
      ? new OTLPTraceExporter({ url, headers })
      : new OTLPProtoTraceExporter({ url, headers })
  return new BasicTracerProvider({
    resource: resourceFromAttributes({
      "service.name": serviceName,
      "service.version": "3f2c9ab",
      "deployment.environment.name": "test",
    }),
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  })
}

const reader = (overrides: { auth?: TempoAuth; orgId?: string } = {}) =>
  new TempoTraceReader({
    baseUrl: server.url,
    auth: AUTH,
    fetchImpl: (input, init) => fetch(input, init),
    ...overrides,
  })

const admin = (path: string, body: unknown, method = "POST") =>
  fetch(`${server.url}/__admin${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })

const journal = async () =>
  (
    (await (await fetch(`${server.url}/__admin/requests?operationId=ExportTraces`)).json()) as {
      requests: { status: number }[]
    }
  ).requests.map((r) => r.status)

describe.each(["json", "protobuf"] as const)("OpenTelemetry SDK over OTLP/HTTP %s", (encoding) => {
  test(
    "a parent and a child span export, then come back through search, lookup and tags",
    async () => {
      const service = `checkout-${encoding}`
      const tracing = provider(service, encoding, HEADERS)
      const tracer = tracing.getTracer("@acme/telemetry", "1.0.0")
      const root = tracer.startSpan("POST /checkout", {
        kind: SpanKind.SERVER,
        attributes: { "user.id": `user-${encoding}`, "session.id": "session-1" },
      })
      const child = tracer.startSpan(
        "charge card",
        {
          kind: SpanKind.CLIENT,
          attributes: { "mutation.id": `mutation-${encoding}`, attempt: 2 },
        },
        trace.setSpan(ROOT_CONTEXT, root),
      )
      child.addEvent("retry", { attempt: 1 })
      child.setStatus({ code: SpanStatusCode.ERROR, message: "card declined" })
      child.end()
      root.end()
      await tracing.forceFlush()
      await tracing.shutdown()
      const traceId = root.spanContext().traceId

      // Search by the id only the child span carries, as the investigation tool does.
      const found = await reader().search({
        q: traceqlEquals({ "mutation.id": `mutation-${encoding}` }),
        startSeconds: Math.floor(Date.now() / 1000) - 3600,
        endSeconds: Math.floor(Date.now() / 1000) + 60,
      })
      if (!found.ok) throw new Error(found.error)
      expect(found.value).toHaveLength(1)
      // Tempo trims leading zeros from a trace id; the SDK's random ids rarely have any.
      expect(found.value[0]?.traceId).toBe(traceId.replace(/^0+/, ""))
      expect(found.value[0]).toMatchObject({
        rootServiceName: service,
        rootTraceName: "POST /checkout",
      })
      expect(BigInt(found.value[0]?.startTimeUnixNano ?? "0")).toBeGreaterThan(0n)

      const spans = await reader().trace(found.value[0]?.traceId ?? "")
      if (!spans.ok || spans.value === null) throw new Error("trace not found")
      const byName = Object.fromEntries(spans.value.map((span) => [span.name, span]))
      expect(Object.keys(byName).sort()).toEqual(["POST /checkout", "charge card"])
      expect(byName["POST /checkout"]).toMatchObject({
        traceId,
        spanId: root.spanContext().spanId,
        parentSpanId: null,
        serviceName: service,
        attributes: { "user.id": `user-${encoding}`, "session.id": "session-1" },
        status: { code: "unset", message: null },
      })
      expect(byName["charge card"]).toMatchObject({
        traceId,
        spanId: child.spanContext().spanId,
        parentSpanId: root.spanContext().spanId,
        attributes: { "mutation.id": `mutation-${encoding}`, attempt: 2 },
        status: { code: "error", message: "card declined" },
      })
      expect(byName["charge card"]?.events.map((event) => [event.name, event.attributes])).toEqual([
        ["retry", { attempt: 1 }],
      ])
      expect(byName["charge card"]?.resourceAttributes).toMatchObject({
        "service.name": service,
        "service.version": "3f2c9ab",
        "deployment.environment.name": "test",
      })

      const tags = await reader().spanTags()
      expect(tags.ok && tags.value).toEqual(
        expect.arrayContaining(["attempt", "mutation.id", "session.id", "user.id"]),
      )
    },
    { timeout: 30_000 },
  )
})

describe("the exporter's retry and drop paths", () => {
  test(
    "503 is retried until the export lands; a wrong credential is a 401 the SDK drops",
    async () => {
      await admin("/reset", {})
      const before = (await journal()).length
      await admin("/faults", { preset: "ingest_unavailable", count: 1 })
      const tracing = provider("retry-service", "protobuf", HEADERS)
      tracing.getTracer("@acme/telemetry").startSpan("retry.me").end()
      await tracing.forceFlush()
      await tracing.shutdown()
      expect((await journal()).slice(before)).toEqual([503, 200])
      const landed = await reader().search({ q: '{ resource.service.name = "retry-service" }' })
      expect(landed.ok && landed.value).toHaveLength(1)

      const rejected = provider("rejected-service", "json", {
        Authorization: `Basic ${btoa(`${USER}:wrong-token`)}`,
      })
      rejected.getTracer("@acme/telemetry").startSpan("never.stored").end()
      await rejected.forceFlush()
      await rejected.shutdown()
      expect((await journal()).slice(before)).toEqual([503, 200, 401])
      const absent = await reader().search({ q: '{ resource.service.name = "rejected-service" }' })
      expect(absent).toEqual({ ok: true, value: [] })
    },
    { timeout: 30_000 },
  )

  test(
    "under multi-tenancy the exporter's X-Scope-OrgID header picks the tenant",
    async () => {
      await admin("/reset", {})
      await admin(
        "/settings",
        { multitenancy: true, basicUsers: [{ username: USER, password: TOKEN }] },
        "PUT",
      )
      const tracing = provider("tenant-service", "json", {
        ...HEADERS,
        "X-Scope-OrgID": "tenant-a",
      })
      tracing.getTracer("@acme/telemetry").startSpan("tenant.span").end()
      await tracing.forceFlush()
      await tracing.shutdown()
      const q = '{ resource.service.name = "tenant-service" }'
      const mine = await reader({ orgId: "tenant-a" }).search({ q })
      expect(mine.ok && mine.value).toHaveLength(1)
      expect(await reader({ orgId: "tenant-b" }).search({ q })).toEqual({ ok: true, value: [] })
      // Both tenants at once: Tempo's cross-tenant query federation.
      const both = await reader({ orgId: "tenant-b|tenant-a" }).search({ q })
      expect(both.ok && both.value).toHaveLength(1)
    },
    { timeout: 30_000 },
  )
})
