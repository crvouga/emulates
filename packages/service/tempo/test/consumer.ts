/**
 * The consumer's two Tempo clients, written from the service request's description of them
 * (its source was not available to port line by line):
 *
 * - a trace reader used by an investigation tool: raw `fetch` (injected) against a configurable
 *   Tempo origin, with no auth for a local deployment, a Bearer token, or Grafana Cloud-style
 *   Basic (instance id and access token). It calls `GET /api/search` with a TraceQL query,
 *   `start`/`end` in epoch seconds and `limit=50`, `GET /api/traces/{id}` with JSON, and
 *   `GET /api/v2/search/tags?scope=span`, and reads the fields the request lists
 *   (`traceID`, `startTimeUnixNano`, `durationMs`, `rootServiceName`, `rootTraceName`;
 *   `resourceSpans` or `batches` with nested spans, events, status and attributes).
 * - an OTLP/HTTP exporter posting `ExportTraceServiceRequest` to `/v1/traces`.
 *
 * The acceptance tests drive the emulator through these, so "the emulator works" means "the
 * reader's own requests, field reads and error handling reach the right outcome".
 */
export type Fetch = (input: string, init?: RequestInit) => Promise<Response>

export type TempoAuth =
  | { kind: "none" }
  | { kind: "bearer"; token: string }
  | { kind: "basic"; username: string; token: string }

export type TempoReaderConfig = {
  baseUrl: string
  auth?: TempoAuth
  /** Sent as `X-Scope-OrgID` when the deployment is multi-tenant. */
  orgId?: string
  fetchImpl: Fetch
}

export const DEFAULT_SEARCH_LIMIT = 50

export type TraceSummary = {
  traceId: string
  /** Trace start in nanoseconds, kept as the decimal string Tempo sends. */
  startTimeUnixNano: string
  durationMs: number
  rootServiceName: string | null
  rootTraceName: string | null
}

export type ReadEvent = {
  name: string
  timeUnixNano: string
  attributes: Record<string, unknown>
}

export type ReadSpan = {
  traceId: string
  spanId: string
  parentSpanId: string | null
  name: string
  serviceName: string | null
  startTimeUnixNano: string
  endTimeUnixNano: string
  attributes: Record<string, unknown>
  resourceAttributes: Record<string, unknown>
  events: ReadEvent[]
  status: { code: "unset" | "ok" | "error"; message: string | null }
}

export type Result<T> = { ok: true; value: T } | { ok: false; status: number | null; error: string }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const records = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value) ? value.filter(isRecord) : []

/** `{ true }`: every trace in the window. */
export const traceqlAll = (): string => "{ true }"

/**
 * Exact attribute equality on the correlation ids the investigation tool searches by, joined
 * with `&&`: `{ .user.id = "u-1" && .session.id = "s-9" }`.
 */
export const traceqlEquals = (filters: Record<string, string | number | boolean>): string => {
  const terms = Object.entries(filters).map(([key, value]) => {
    const literal =
      typeof value === "string"
        ? `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`
        : String(value)
    return `.${key} = ${literal}`
  })
  return terms.length === 0 ? traceqlAll() : `{ ${terms.join(" && ")} }`
}

/** Tempo sends ids as base64 (proto `bytes`); OTLP/JSON sends hex. Both become lowercase hex. */
export const idToHex = (value: unknown, bytes: number): string | null => {
  if (typeof value !== "string" || value === "") return null
  if (new RegExp(`^[0-9a-fA-F]{${bytes * 2}}$`).test(value)) return value.toLowerCase()
  try {
    const hex = Array.from(atob(value), (c) => c.charCodeAt(0).toString(16).padStart(2, "0")).join(
      "",
    )
    return hex.length === bytes * 2 ? hex : null
  } catch {
    return null
  }
}

const anyValue = (value: unknown): unknown => {
  if (!isRecord(value)) return null
  if (typeof value.stringValue === "string") return value.stringValue
  if (typeof value.boolValue === "boolean") return value.boolValue
  if (typeof value.intValue === "string" || typeof value.intValue === "number") {
    return Number(value.intValue)
  }
  if (typeof value.doubleValue === "number") return value.doubleValue
  if (isRecord(value.arrayValue)) return records(value.arrayValue.values).map(anyValue)
  if (isRecord(value.kvlistValue)) return attributes(value.kvlistValue.values)
  if (typeof value.bytesValue === "string") return value.bytesValue
  return null
}

const attributes = (value: unknown): Record<string, unknown> => {
  const out: Record<string, unknown> = {}
  for (const kv of records(value)) {
    if (typeof kv.key === "string") out[kv.key] = anyValue(kv.value)
  }
  return out
}

const nanos = (value: unknown): string =>
  typeof value === "string" ? value : typeof value === "number" ? String(value) : "0"

const statusCode = (value: unknown): ReadSpan["status"]["code"] =>
  value === "STATUS_CODE_ERROR" || value === 2
    ? "error"
    : value === "STATUS_CODE_OK" || value === 1
      ? "ok"
      : "unset"

/** Flatten a trace-by-id body: `resourceSpans` (OTLP, Tempo v2) or `batches` (Tempo v1). */
export const readSpans = (body: unknown): ReadSpan[] => {
  if (!isRecord(body)) return []
  const out: ReadSpan[] = []
  for (const batch of records(body.resourceSpans ?? body.batches)) {
    const resourceAttributes = attributes(isRecord(batch.resource) ? batch.resource.attributes : [])
    const service = resourceAttributes["service.name"]
    for (const scoped of records(batch.scopeSpans)) {
      for (const span of records(scoped.spans)) {
        const traceId = idToHex(span.traceId, 16)
        const spanId = idToHex(span.spanId, 8)
        if (traceId === null || spanId === null) continue
        const status = isRecord(span.status) ? span.status : {}
        out.push({
          traceId,
          spanId,
          parentSpanId: idToHex(span.parentSpanId, 8),
          name: typeof span.name === "string" ? span.name : "",
          serviceName: typeof service === "string" ? service : null,
          startTimeUnixNano: nanos(span.startTimeUnixNano),
          endTimeUnixNano: nanos(span.endTimeUnixNano),
          attributes: attributes(span.attributes),
          resourceAttributes,
          events: records(span.events).map((event) => ({
            name: typeof event.name === "string" ? event.name : "",
            timeUnixNano: nanos(event.timeUnixNano),
            attributes: attributes(event.attributes),
          })),
          status: {
            code: statusCode(status.code),
            message: typeof status.message === "string" ? status.message : null,
          },
        })
      }
    }
  }
  return out
}

/** The investigation tool's Tempo adapter. */
export class TempoTraceReader {
  private readonly baseUrl: string

  constructor(private readonly config: TempoReaderConfig) {
    this.baseUrl = config.baseUrl.trim().replace(/\/$/, "")
  }

  private headers(): Record<string, string> {
    const auth = this.config.auth ?? { kind: "none" }
    return {
      accept: "application/json",
      ...(auth.kind === "bearer" ? { authorization: `Bearer ${auth.token}` } : {}),
      ...(auth.kind === "basic"
        ? { authorization: `Basic ${btoa(`${auth.username}:${auth.token}`)}` }
        : {}),
      ...(this.config.orgId ? { "X-Scope-OrgID": this.config.orgId } : {}),
    }
  }

  private async get(path: string): Promise<Result<{ status: number; body: unknown }>> {
    try {
      const res = await this.config.fetchImpl(`${this.baseUrl}${path}`, {
        method: "GET",
        headers: this.headers(),
        signal: AbortSignal.timeout(30_000),
      })
      const text = await res.text()
      if (!res.ok) return { ok: false, status: res.status, error: text.slice(0, 600) }
      return { ok: true, value: { status: res.status, body: text ? JSON.parse(text) : {} } }
    } catch (error) {
      return {
        ok: false,
        status: null,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }

  /** `GET /api/search`: `start`/`end` are epoch seconds; the limit defaults to 50. */
  async search(input: {
    q: string
    startSeconds?: number
    endSeconds?: number
    limit?: number
  }): Promise<Result<TraceSummary[]>> {
    const params = new URLSearchParams({ q: input.q })
    if (input.startSeconds !== undefined) params.set("start", String(input.startSeconds))
    if (input.endSeconds !== undefined) params.set("end", String(input.endSeconds))
    params.set("limit", String(input.limit ?? DEFAULT_SEARCH_LIMIT))
    const res = await this.get(`/api/search?${params.toString()}`)
    if (!res.ok) return res
    const body = res.value.body
    if (!isRecord(body) || !Array.isArray(body.traces)) {
      return {
        ok: false,
        status: res.value.status,
        error: "Malformed search response: `traces` is missing or not an array",
      }
    }
    const traces: TraceSummary[] = []
    for (const trace of records(body.traces)) {
      if (typeof trace.traceID !== "string") continue
      traces.push({
        traceId: trace.traceID,
        startTimeUnixNano: nanos(trace.startTimeUnixNano),
        durationMs: typeof trace.durationMs === "number" ? trace.durationMs : 0,
        rootServiceName: typeof trace.rootServiceName === "string" ? trace.rootServiceName : null,
        rootTraceName: typeof trace.rootTraceName === "string" ? trace.rootTraceName : null,
      })
    }
    return { ok: true, value: traces }
  }

  /** `GET /api/traces/{id}`: the trace's spans, or `null` for a 404. */
  async trace(traceId: string): Promise<Result<ReadSpan[] | null>> {
    const res = await this.get(`/api/traces/${encodeURIComponent(traceId)}`)
    if (!res.ok) return res.status === 404 ? { ok: true, value: null } : res
    return { ok: true, value: readSpans(res.value.body) }
  }

  /** `GET /api/v2/search/tags?scope=span`: the span-scoped tag names. */
  async spanTags(): Promise<Result<string[]>> {
    const res = await this.get("/api/v2/search/tags?scope=span")
    if (!res.ok) return res
    const body = res.value.body
    const scopes = isRecord(body) ? records(body.scopes) : []
    const span = scopes.find((scope) => scope.name === "span")
    return {
      ok: true,
      value: Array.isArray(span?.tags) ? span.tags.filter((t) => typeof t === "string") : [],
    }
  }
}

// ── emitting: OTLP/JSON exports as @opentelemetry/exporter-trace-otlp-http produces them ──

export type AttributeInput = string | number | boolean | string[]

export type SpanInput = {
  traceId: string
  spanId: string
  parentSpanId?: string
  name: string
  /** OTLP `SpanKind` number; default 1 (internal). */
  kind?: number
  startTimeUnixNano: string
  endTimeUnixNano: string
  attributes?: Record<string, AttributeInput>
  events?: { name: string; timeUnixNano: string; attributes?: Record<string, AttributeInput> }[]
  links?: { traceId: string; spanId: string; attributes?: Record<string, AttributeInput> }[]
  status?: { code: 0 | 1 | 2; message?: string }
}

const otlpValue = (value: AttributeInput): Record<string, unknown> =>
  Array.isArray(value)
    ? { arrayValue: { values: value.map((item) => ({ stringValue: item })) } }
    : typeof value === "string"
      ? { stringValue: value }
      : typeof value === "boolean"
        ? { boolValue: value }
        : Number.isInteger(value)
          ? { intValue: value }
          : { doubleValue: value }

const otlpAttributes = (values: Record<string, AttributeInput> = {}) =>
  Object.entries(values).map(([key, value]) => ({ key, value: otlpValue(value) }))

/** An `ExportTraceServiceRequest` for one resource and one instrumentation scope. */
export const tracesExport = (
  resource: Record<string, AttributeInput>,
  spans: SpanInput[],
  scope: { name: string; version?: string } = { name: "@acme/telemetry", version: "1.0.0" },
): Record<string, unknown> => ({
  resourceSpans: [
    {
      resource: { attributes: otlpAttributes(resource), droppedAttributesCount: 0 },
      scopeSpans: [
        {
          scope,
          spans: spans.map((span) => ({
            traceId: span.traceId,
            spanId: span.spanId,
            ...(span.parentSpanId ? { parentSpanId: span.parentSpanId } : {}),
            name: span.name,
            kind: span.kind ?? 1,
            startTimeUnixNano: span.startTimeUnixNano,
            endTimeUnixNano: span.endTimeUnixNano,
            attributes: otlpAttributes(span.attributes),
            droppedAttributesCount: 0,
            events: (span.events ?? []).map((event) => ({
              name: event.name,
              timeUnixNano: event.timeUnixNano,
              attributes: otlpAttributes(event.attributes),
              droppedAttributesCount: 0,
            })),
            droppedEventsCount: 0,
            links: (span.links ?? []).map((link) => ({
              traceId: link.traceId,
              spanId: link.spanId,
              attributes: otlpAttributes(link.attributes),
              droppedAttributesCount: 0,
            })),
            droppedLinksCount: 0,
            status: {
              code: span.status?.code ?? 0,
              ...(span.status?.message ? { message: span.status.message } : {}),
            },
          })),
        },
      ],
    },
  ],
})

export type ExportOutcome = { status: number; contentType: string; body: Uint8Array }

/** Post one export to `/v1/traces`, as JSON or as the bytes of a protobuf message. */
export const exportTraces = async (
  config: { baseUrl: string; auth?: TempoAuth; orgId?: string; fetchImpl: Fetch },
  payload: Record<string, unknown> | Uint8Array,
): Promise<ExportOutcome> => {
  const auth = config.auth ?? { kind: "none" }
  const protobuf = payload instanceof Uint8Array
  const res = await config.fetchImpl(`${config.baseUrl.replace(/\/$/, "")}/v1/traces`, {
    method: "POST",
    headers: {
      "content-type": protobuf ? "application/x-protobuf" : "application/json",
      ...(auth.kind === "bearer" ? { authorization: `Bearer ${auth.token}` } : {}),
      ...(auth.kind === "basic"
        ? { authorization: `Basic ${btoa(`${auth.username}:${auth.token}`)}` }
        : {}),
      ...(config.orgId ? { "X-Scope-OrgID": config.orgId } : {}),
    },
    body: protobuf ? payload.slice().buffer : JSON.stringify(payload),
  })
  return {
    status: res.status,
    contentType: res.headers.get("content-type") ?? "",
    body: new Uint8Array(await res.arrayBuffer()),
  }
}
