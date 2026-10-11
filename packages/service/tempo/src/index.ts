import type { FetchAPI } from "@crvouga/mockingbird-core"
import {
  type APIOptions,
  annotateResponse,
  basicAuth,
  bearerToken,
  bootSqlite,
  createService,
  defineOperations,
  faultEffect,
  HttpError,
  jsonRes,
  type OperationContext,
  type Service,
} from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"
import type { Hono } from "hono"
import { document, type SupportedOperationId } from "./generated/openapi.js"
import {
  base64ToHex,
  type DecodedSpan,
  decodeSpans,
  findAttribute,
  OtlpError,
  type SpanDefaults,
  validateIds,
  type WireKeyValue,
  type WireResourceSpans,
  type WireScopeSpans,
  type WireSpan,
} from "./otlp.js"
import { decodeTraceRequest, encodeRpcStatus, ProtobufError } from "./protobuf.js"
import { type Settings, SINGLE_TENANT, type StoredSpan, TempoState } from "./state.js"
import {
  matchesSpan,
  parseTraceQL,
  type Query,
  resolveAttribute,
  TraceQLError,
  UNSUPPORTED_NOTE,
} from "./traceql.js"

export type { FetchAPI } from "@crvouga/mockingbird-core"
export type { SqliteClient } from "@crvouga/mockingbird-sqlite"
export type { OperationId, SupportedOperationId } from "./generated/openapi.js"
export { document, operationIds, supportedOperationIds } from "./generated/openapi.js"
export type {
  AttributeValue,
  DecodedSpan,
  SpanDefaults,
  WireAnyValue,
  WireEvent,
  WireKeyValue,
  WireLink,
  WireResource,
  WireResourceSpans,
  WireScope,
  WireScopeSpans,
  WireSpan,
  WireStatus,
} from "./otlp.js"
export { base64ToHex, decodeSpans, hexToBase64, OtlpError, validateIds } from "./otlp.js"
export {
  decodeRpcStatus,
  decodeTraceRequest,
  encodeRpcStatus,
  ProtobufError,
} from "./protobuf.js"
export type { Settings, StoredSpan, UnauthorizedResponse } from "./state.js"
export { DEFAULT_SETTINGS, SINGLE_TENANT } from "./state.js"
export type { Condition, Query, Static } from "./traceql.js"
export { matchesSpan, parseTraceQL, TraceQLError } from "./traceql.js"

export const TEMPO_NAMESPACE = "tempo"

/** Tempo's tenant header. */
export const ORG_ID_HEADER = "x-scope-orgid"

/** `rootServiceName` of a trace whose root span has not arrived (`search.RootSpanNotYetReceivedText`). */
export const ROOT_SPAN_NOT_YET_RECEIVED = "<root span not yet received>"

/**
 * The names `GET /api/v2/search/tags` lists under the `intrinsic` scope
 * (`search.GetVirtualIntrinsicValues`), sorted as Tempo's collector sorts them.
 */
export const INTRINSIC_TAGS: readonly string[] = [
  "duration",
  "event:name",
  "event:timeSinceStart",
  "instrumentation:name",
  "instrumentation:version",
  "kind",
  "link:spanID",
  "link:traceID",
  "name",
  "rootName",
  "rootServiceName",
  "span:duration",
  "span:id",
  "span:kind",
  "span:name",
  "span:parentID",
  "span:status",
  "span:statusMessage",
  "status",
  "statusMessage",
  "trace:duration",
  "trace:id",
  "trace:rootName",
  "trace:rootService",
  "traceDuration",
]

export type TempoAPIOptions = APIOptions & {
  /** Initial per-namespace settings (credentials, multi-tenancy, limits). */
  settings?: Partial<Settings>
}

const PROTOBUF = "application/x-protobuf"
const TEXT = "text/plain; charset=utf-8"
/** `query_frontend.search.max_spans_per_span_set`. */
const MAX_SPANS_PER_SPAN_SET = 100
const DEFAULT_SPANS_PER_SPAN_SET = 3
/** `query_frontend.search.max_duration`, in seconds (168 h). */
const MAX_SEARCH_DURATION_SECONDS = 604_800
const TAG_SCOPES = ["resource", "span", "event", "link", "instrumentation"] as const
type TagScope = (typeof TAG_SCOPES)[number]

/**
 * The credential a request carries, for `PUT /__admin/credentials`: a bearer token or a
 * Basic-auth username. Map the exporter's and the reader's credentials to one namespace so a
 * worker's exports and searches meet.
 */
export const tempoCredential = (request: Request): string | undefined =>
  bearerToken(request) ?? basicAuth(request)?.username

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const mediaType = (request: Request) =>
  request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? ""

const text = (status: number, body: string, headers: Record<string, string> = {}) =>
  new Response(body, { status, headers: { "content-type": TEXT, ...headers } })

/** A query-frontend rejection: 400 with the error text as the whole body. */
const badRequest = (message: string) => text(400, message)

/**
 * An OTLP error: `google.rpc.Status` in the encoding the request used (code 3
 * INVALID_ARGUMENT, 8 RESOURCE_EXHAUSTED, 13 INTERNAL, 14 UNAVAILABLE).
 */
const rpcStatus = (
  protobuf: boolean,
  status: number,
  code: number,
  message: string,
  headers: Record<string, string> = {},
): Response =>
  protobuf
    ? new Response(encodeRpcStatus(code, message).slice().buffer, {
        status,
        headers: { "content-type": PROTOBUF, ...headers },
      })
    : jsonRes(status, { code, message }, headers)

/** Go's `strconv` error text, which Tempo wraps into its 400 bodies. */
const strconvError = (fn: "ParseUint" | "ParseInt", value: string, bits: number): string => {
  const signed = fn === "ParseInt"
  const digits = signed ? /^[+-]?\d+$/ : /^\d+$/
  if (!digits.test(value)) return `strconv.${fn}: parsing ${JSON.stringify(value)}: invalid syntax`
  const number = BigInt(value)
  const max = signed ? 2n ** BigInt(bits - 1) - 1n : 2n ** BigInt(bits) - 1n
  const min = signed ? -(2n ** BigInt(bits - 1)) : 0n
  return number > max || number < min
    ? `strconv.${fn}: parsing ${JSON.stringify(value)}: value out of range`
    : ""
}

/** A query parameter as Tempo's `extractQueryParam` reads it: empty counts as absent. */
const param = (url: URL, name: string): string | undefined =>
  url.searchParams.get(name) || undefined

/** `exact` keeps a 64-bit value a JS number would round. */
type Parsed = { ok: true; value: number; exact: bigint } | { ok: false; error: string }

const integerParam = (
  url: URL,
  name: string,
  fn: "ParseUint" | "ParseInt",
  bits: number,
): Parsed => {
  const raw = param(url, name)
  if (raw === undefined) return { ok: true, value: 0, exact: 0n }
  const error = strconvError(fn, raw, bits)
  return error === ""
    ? { ok: true, value: Number(raw), exact: BigInt(raw) }
    : { ok: false, error: `invalid ${name}: ${error}` }
}

/** Go's `time.Duration` formatting of a whole number of seconds (`168h0m0s`). */
const goDuration = (seconds: number): string => {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = seconds % 60
  return h > 0 ? `${h}h${m}m${s}s` : m > 0 ? `${m}m${s}s` : `${s}s`
}

/** `util.TraceIDToHexString`: hex without leading zeros. */
const trimTraceId = (traceId: string): string => traceId.replace(/^0+/, "")

type TraceIdResult = { ok: true; traceId: string } | { ok: false; error: string }

/** `util.HexStringToTraceID`: any hex up to 128 bits, left-padded with zeros. */
const parseTraceId = (raw: string): TraceIdResult => {
  for (let i = 0; i < raw.length; i++) {
    if (!/[0-9a-fA-F]/.test(raw[i] as string)) {
      return {
        ok: false,
        error: `trace IDs can only contain hex characters: invalid character '${raw[i]}' at position ${i + 1}`,
      }
    }
  }
  const even = raw.length % 2 === 1 ? `0${raw}` : raw
  if (even.length > 32) return { ok: false, error: "trace IDs can't be larger than 128 bits" }
  return { ok: true, traceId: even.toLowerCase().padStart(32, "0") }
}

const big = (value: string | undefined): bigint => BigInt(value ?? "0")

const serviceName = (span: StoredSpan): string =>
  findAttribute(span.resource.attributes, "service.name")?.value?.stringValue ?? ""

/** `trace.SortTrace` order for spans: start time, then span id bytes. */
const bySpanOrder = (a: WireSpan, b: WireSpan): number => {
  const start = big(a.startTimeUnixNano) - big(b.startTimeUnixNano)
  if (start !== 0n) return start < 0n ? -1 : 1
  const left = base64ToHex(a.spanId)
  const right = base64ToHex(b.spanId)
  return left < right ? -1 : left > right ? 1 : 0
}

type TraceSummary = {
  tenant: string
  traceId: string
  startNs: bigint
  endNs: bigint
  rootServiceName: string
  rootTraceName: string
  spans: StoredSpan[]
}

const summarise = (spans: StoredSpan[]): TraceSummary => {
  const ordered = [...spans].sort((a, b) => bySpanOrder(a.span, b.span))
  let startNs = big(ordered[0]?.span.startTimeUnixNano)
  let endNs = startNs
  for (const { span } of ordered) {
    const start = big(span.startTimeUnixNano)
    const end = big(span.endTimeUnixNano)
    if (start < startNs) startNs = start
    if (end > endNs) endNs = end
    if (start > endNs) endNs = start
  }
  const root = ordered.find((span) => span.parentSpanId === "")
  const first = ordered[0] as StoredSpan
  return {
    tenant: first.tenant,
    traceId: first.traceId,
    startNs,
    endNs,
    rootServiceName: root ? serviceName(root) : "",
    rootTraceName: root?.span.name ?? "",
    spans: ordered,
  }
}

/** A trace's spans regrouped into the batches they were exported in, sorted as Tempo sorts. */
const batches = (spans: readonly StoredSpan[]): WireResourceSpans[] => {
  const groups: { batch: string; value: WireResourceSpans; scopes: number[] }[] = []
  for (const stored of spans) {
    let group = groups.find((g) => g.batch === stored.batch)
    if (!group) {
      group = {
        batch: stored.batch,
        value: {
          resource: stored.resource,
          scopeSpans: [],
          ...(stored.resourceSchemaUrl ? { schemaUrl: stored.resourceSchemaUrl } : {}),
        },
        scopes: [],
      }
      groups.push(group)
    }
    let scoped: WireScopeSpans | undefined =
      group.value.scopeSpans[group.scopes.indexOf(stored.scopeIndex)]
    if (!scoped) {
      scoped = {
        scope: stored.scope,
        spans: [],
        ...(stored.scopeSchemaUrl ? { schemaUrl: stored.scopeSchemaUrl } : {}),
      }
      group.scopes.push(stored.scopeIndex)
      group.value.scopeSpans.push(scoped)
    }
    scoped.spans.push(sortedSpan(stored.span))
  }
  const firstSpan = (scoped: WireScopeSpans) => scoped.spans[0] as WireSpan
  for (const { value } of groups) {
    for (const scoped of value.scopeSpans) scoped.spans.sort(bySpanOrder)
    value.scopeSpans.sort((a, b) => bySpanOrder(firstSpan(a), firstSpan(b)))
  }
  return groups
    .map((group) => group.value)
    .sort((a, b) =>
      bySpanOrder(
        firstSpan(a.scopeSpans[0] as WireScopeSpans),
        firstSpan(b.scopeSpans[0] as WireScopeSpans),
      ),
    )
}

/** `SortTrace` also orders a span's events (time, then name) and links (trace id, then span id). */
const sortedSpan = (span: WireSpan): WireSpan => ({
  ...span,
  ...(span.events
    ? {
        events: [...span.events].sort((a, b) => {
          const time = big(a.timeUnixNano) - big(b.timeUnixNano)
          if (time !== 0n) return time < 0n ? -1 : 1
          return (a.name ?? "") < (b.name ?? "") ? -1 : (a.name ?? "") > (b.name ?? "") ? 1 : 0
        }),
      }
    : {}),
  ...(span.links
    ? {
        links: [...span.links].sort((a, b) => {
          const left = `${base64ToHex(a.traceId ?? "")}:${base64ToHex(a.spanId ?? "")}`
          const right = `${base64ToHex(b.traceId ?? "")}:${base64ToHex(b.spanId ?? "")}`
          return left < right ? -1 : left > right ? 1 : 0
        }),
      }
    : {}),
})

/** One trace as `/__admin/traces` lists it. */
export type TraceListing = {
  tenant: string
  /** 32 lowercase hex characters (never trimmed, unlike `GET /api/search`). */
  traceID: string
  spanCount: number
  rootServiceName: string
  rootTraceName: string
  startTimeUnixNano: string
  durationMs: number
}

/**
 * Stateful emulator of Grafana Tempo: the OTLP/HTTP receiver of its distributor and the
 * query-frontend's search, trace-by-id and tag-name routes, over one store.
 *
 * A test exports spans the way its application does and reads them back with the same HTTP
 * requests its trace reader sends, so the production reader runs unchanged.
 */
export class TempoAPI implements FetchAPI {
  readonly app: Hono
  readonly sqlite: SqliteClient
  readonly state: TempoState
  private readonly service: Service
  private readonly now: () => number
  /** Exports whose gzip body did not inflate. */
  private readonly undecodable = new WeakSet<Request>()

  constructor(options: TempoAPIOptions = {}) {
    const sqlite = bootSqlite(options.sqlite)
    const namespace = options.namespace ?? TEMPO_NAMESPACE
    this.now = options.now ?? (() => Date.now())
    this.state = new TempoState(sqlite, namespace, { settings: options.settings ?? {} })
    const handlers = defineOperations<SupportedOperationId>({
      ExportTraces: (context) => this.export(context),
      Search: (context) => this.search(context),
      GetTrace: (context) => this.trace(context),
      SearchTagsV2: (context) => this.tags(context),
    })
    this.service = createService({
      document,
      handlers,
      sqlite,
      namespace,
      now: this.now,
      notFound: (request) =>
        new URL(request.url).pathname === "/v1/traces"
          ? // The OTLP receiver's answer to anything but POST.
            new Response("405 method not allowed, supported: [POST]", {
              status: 405,
              headers: { "content-type": "text/plain" },
            })
          : // Tempo's router (gorilla/mux) answers an unknown path with Go's default 404.
            text(404, "404 page not found\n", { "x-content-type-options": "nosniff" }),
      onError: (error) => {
        if (error instanceof HttpError) return error.toResponse()
        // A malformed percent-escape in the path: Go's HTTP server refuses the request line.
        if (error instanceof URIError) return text(400, "400 Bad Request")
        throw error
      },
      before: (context) => this.gate(context),
    })
    this.app = this.service.app
    this.sqlite = this.service.sqlite
  }

  /**
   * Inflate a `content-encoding: gzip` export (the exporters' `compression: "gzip"`). A body
   * that does not inflate is remembered and refused by the export handler, after routing and
   * the credential check have had their say.
   */
  async fetch(request: Request): Promise<Response> {
    const encoding = request.headers.get("content-encoding")?.toLowerCase()
    const exporting = request.method === "POST" && new URL(request.url).pathname === "/v1/traces"
    if (encoding !== "gzip" || request.body === null || !exporting) {
      return this.service.fetch(request)
    }
    let inflated: ArrayBuffer | undefined
    try {
      inflated = await new Response(
        request.body.pipeThrough(new DecompressionStream("gzip")),
      ).arrayBuffer()
    } catch {
      inflated = undefined
    }
    const headers = new Headers(request.headers)
    headers.delete("content-encoding")
    headers.delete("content-length")
    const forwarded = new Request(request.url, {
      method: request.method,
      headers,
      body: inflated ?? new ArrayBuffer(0),
    })
    if (inflated === undefined) this.undecodable.add(forwarded)
    return this.service.fetch(forwarded)
  }

  async reset(): Promise<void> {
    await this.service.reset()
    this.state.ensureSeeded()
  }

  /** Every stored span, in ingest order. */
  spans(filter?: { tenant?: string; traceId?: string }): StoredSpan[] {
    return this.state.list(
      (span) =>
        (filter?.tenant === undefined || span.tenant === filter.tenant) &&
        (filter?.traceId === undefined || span.traceId === filter.traceId),
    )
  }

  /** Every stored trace, oldest start first. */
  traces(tenant?: string): TraceListing[] {
    const byTrace: StoredSpan[][] = []
    for (const span of this.spans(tenant === undefined ? {} : { tenant })) {
      const group = byTrace.find(
        (g) => g[0]?.tenant === span.tenant && g[0]?.traceId === span.traceId,
      )
      if (group) group.push(span)
      else byTrace.push([span])
    }
    return byTrace
      .map(summarise)
      .sort((a, b) => (a.startNs < b.startNs ? -1 : a.startNs > b.startNs ? 1 : 0))
      .map((trace) => ({
        tenant: trace.tenant,
        traceID: trace.traceId,
        spanCount: trace.spans.length,
        rootServiceName: trace.rootServiceName || ROOT_SPAN_NOT_YET_RECEIVED,
        rootTraceName: trace.rootTraceName,
        startTimeUnixNano: trace.startNs.toString(),
        durationMs: Number((trace.endNs - trace.startNs) / 1_000_000n),
      }))
  }

  /**
   * Store an OTLP/JSON export directly: no credentials, no faults, no tenant header. A span
   * without a start time starts at the emulator clock and, without an end time, ends there too.
   * Throws {@link OtlpError} for a payload Tempo would refuse.
   */
  inject(payload: unknown, tenant: string = SINGLE_TENANT): DecodedSpan[] {
    const defaults: SpanDefaults = {
      startTimeUnixNano: (BigInt(Math.trunc(this.now())) * 1_000_000n).toString(),
    }
    const spans = decodeSpans(payload, defaults)
    validateIds(spans)
    this.sqlite.transaction(() => this.state.ingest(tenant, spans))
    return spans
  }

  private settings(): Settings {
    return this.state.current()
  }

  private unauthorized(): Response {
    const { status, body, contentType } = this.settings().unauthorized
    return new Response(body, { status, headers: { "content-type": contentType } })
  }

  /** The gateway in front of Tempo, then Tempo's own tenant check on the query routes. */
  private gate(context: OperationContext): Response | undefined {
    const { request } = context
    const settings = this.settings()
    if (faultEffect(request, "unauthorized") !== undefined) return this.unauthorized()
    if (settings.bearerTokens.length > 0 || settings.basicUsers.length > 0) {
      const token = bearerToken(request)
      const basic = basicAuth(request)
      const accepted =
        (token !== undefined && settings.bearerTokens.includes(token)) ||
        (basic !== undefined &&
          settings.basicUsers.some(
            (user) => user.username === basic.username && user.password === basic.password,
          ))
      if (!accepted) return this.unauthorized()
    }
    // dskit's `middleware.AuthenticateUser`: `http.Error(w, "no org id", 401)`. The OTLP
    // receiver has its own server and reports the same condition differently (see `export`).
    if (
      context.operation.operationId !== "ExportTraces" &&
      settings.multitenancy &&
      !request.headers.get(ORG_ID_HEADER)
    ) {
      return text(401, "no org id\n", { "x-content-type-options": "nosniff" })
    }
    return undefined
  }

  /** The tenants a query reads: `a|b` federates, as Tempo's cross-tenant queries do. */
  private readTenants(request: Request): string[] {
    if (!this.settings().multitenancy) return [SINGLE_TENANT]
    return [...new Set((request.headers.get(ORG_ID_HEADER) ?? "").split("|"))].filter(Boolean)
  }

  private export(context: OperationContext): Response {
    const { request } = context
    const type = mediaType(request)
    if (type !== PROTOBUF && type !== "application/json") {
      // The OTLP receiver's own wording, as plain text whatever the request was.
      return new Response(
        `415 unsupported media type, supported: [application/json, ${PROTOBUF}]`,
        { status: 415, headers: { "content-type": "text/plain" } },
      )
    }
    const protobuf = type === PROTOBUF
    const invalid = (message: string) => rpcStatus(protobuf, 400, 3, message)
    if (this.undecodable.has(request)) return invalid("gzip: invalid header")
    const body = context.body
    let spans: DecodedSpan[]
    try {
      if (protobuf) {
        spans = decodeSpans(
          decodeTraceRequest(body.kind === "bytes" ? body.value : new Uint8Array(0)),
        )
      } else {
        if (body.kind === "empty") return invalid("unexpected end of JSON input")
        if (body.kind !== "json" || !isRecord(body.value)) {
          return invalid("request body is not an OTLP/JSON export request")
        }
        spans = decodeSpans(body.value)
      }
    } catch (error) {
      if (error instanceof ProtobufError || error instanceof OtlpError) {
        return invalid(error.message)
      }
      throw error
    }
    const ok = () =>
      protobuf
        ? new Response(new Uint8Array(0), { status: 200, headers: { "content-type": PROTOBUF } })
        : jsonRes(200, { partialSuccess: {} })
    // The receiver answers an export without spans before anything else looks at it.
    if (spans.length === 0) return ok()

    const fault = faultEffect(request, "ingest_error")
    if (fault !== undefined) {
      const retryAfter = fault.retryAfterSeconds
      // Only the statuses the contract declares for an ingest failure.
      const status = [429, 500, 503].find((s) => s === Number(fault.status)) ?? 503
      return rpcStatus(
        protobuf,
        status,
        Number.isInteger(Number(fault.code)) ? Number(fault.code) : 14,
        String(fault.message ?? "unavailable"),
        retryAfter === undefined ? {} : { "retry-after": String(retryAfter) },
      )
    }

    const settings = this.settings()
    let tenant = SINGLE_TENANT
    if (settings.multitenancy) {
      const orgId = request.headers.get(ORG_ID_HEADER) ?? ""
      // Not a status error, so the receiver reports it as retryable UNAVAILABLE.
      if (orgId === "") return rpcStatus(protobuf, 503, 14, "no org id")
      if (orgId.includes("|")) return invalid("multiple org IDs present")
      tenant = orgId
    }
    try {
      validateIds(spans)
    } catch (error) {
      if (error instanceof OtlpError) return invalid(error.message)
      throw error
    }
    // One transaction per export: a transaction per span makes a large batch crawl.
    this.sqlite.transaction(() => this.state.ingest(tenant, spans))
    return annotateResponse(ok(), {
      ids: {
        accepted: String(spans.length),
        tenant,
        traceId: [...new Set(spans.map((span) => span.traceId))].join(","),
      },
    })
  }

  /** Every trace the request's tenants hold, summarised. */
  private summaries(request: Request): TraceSummary[] {
    return this.readTenants(request).flatMap((tenant) =>
      [...this.state.traces(tenant).values()].map(summarise),
    )
  }

  private search(context: OperationContext): Response {
    const { url, request } = context
    const settings = this.settings()

    const start = integerParam(url, "start", "ParseUint", 32)
    if (!start.ok) return badRequest(start.error)
    const end = integerParam(url, "end", "ParseUint", 32)
    if (!end.ok) return badRequest(end.error)
    const q = param(url, "q")
    if (param(url, "tags") !== undefined) {
      if (q !== undefined) {
        return badRequest("invalid request: can't specify tags and q in the same query")
      }
      return badRequest(`tags search not yet supported ${UNSUPPORTED_NOTE}`)
    }
    for (const name of ["minDuration", "maxDuration"]) {
      if (param(url, name) !== undefined) {
        return badRequest(`${name} not yet supported ${UNSUPPORTED_NOTE}`)
      }
    }
    // Without q, tags, start and end, Tempo reads every other parameter as a tag to match.
    if (q === undefined && start.value === 0 && end.value === 0) {
      const reserved = new Set(["q", "tags", "minDuration", "maxDuration", "limit", "spss"])
      const legacy = [...url.searchParams].find(
        ([key, value]) => !reserved.has(key) && key !== "start" && key !== "end" && value !== "",
      )
      if (legacy) return badRequest(`tags search not yet supported ${UNSUPPORTED_NOTE}`)
    }
    const limitParam = integerParam(url, "limit", "ParseUint", 32)
    if (!limitParam.ok) return badRequest(limitParam.error)
    if (param(url, "limit") !== undefined && limitParam.value === 0) {
      return badRequest("invalid limit: must be a positive number")
    }
    const spssParam = integerParam(url, "spss", "ParseUint", 32)
    if (!spssParam.ok) return badRequest(spssParam.error)
    if ((start.value !== 0 || end.value !== 0) && end.value <= start.value) {
      return badRequest(
        `http parameter start must be before end. received start=${start.value} end=${end.value}`,
      )
    }
    if (settings.maxLimit !== 0 && limitParam.value > settings.maxLimit) {
      return badRequest(`limit ${limitParam.value} exceeds max limit ${settings.maxLimit}`)
    }
    const limit = limitParam.value === 0 ? settings.defaultLimit : limitParam.value

    let query: Query = { conditions: [], never: false }
    if (q !== undefined) {
      try {
        query = parseTraceQL(q)
      } catch (error) {
        if (error instanceof TraceQLError) {
          return badRequest(`invalid TraceQL query: ${error.message}`)
        }
        throw error
      }
    }
    if (end.value - start.value > MAX_SEARCH_DURATION_SECONDS) {
      return badRequest(
        `range specified by start and end exceeds ${goDuration(MAX_SEARCH_DURATION_SECONDS)}. received start=${start.value} end=${end.value}`,
      )
    }
    if (spssParam.value > MAX_SPANS_PER_SPAN_SET) {
      return badRequest(
        `spans per span set exceeds ${MAX_SPANS_PER_SPAN_SET}. received ${spssParam.value}`,
      )
    }
    const spss = spssParam.value === 0 ? DEFAULT_SPANS_PER_SPAN_SET : spssParam.value

    // A trace is in the window when it overlaps it: start <= end of window, end >= its start.
    const windowed = start.value > 0 && end.value > 0
    const windowStart = BigInt(start.value) * 1_000_000_000n
    const windowEnd = BigInt(end.value) * 1_000_000_000n
    const all = this.summaries(request)
    let inspectedBytes = 0
    const found = all.flatMap((trace) => {
      inspectedBytes += trace.spans.reduce((sum, s) => sum + JSON.stringify(s.span).length, 0)
      if (windowed && !(trace.startNs <= windowEnd && trace.endNs >= windowStart)) return []
      const matched = trace.spans.filter((stored) =>
        matchesSpan(query, { span: stored.span.attributes, resource: stored.resource.attributes }),
      )
      return matched.length === 0 ? [] : [{ trace, matched }]
    })
    // Newest first, as the frontend's combiner sorts; the trace id settles equal start times.
    found.sort((a, b) =>
      a.trace.startNs !== b.trace.startNs
        ? a.trace.startNs > b.trace.startNs
          ? -1
          : 1
        : a.trace.traceId < b.trace.traceId
          ? -1
          : 1,
    )
    const traces = found.slice(0, limit).map(({ trace, matched }) => {
      const spanSet = {
        spans: matched.slice(0, spss).map((stored) => this.searchSpan(stored, query)),
        matched: matched.length,
      }
      const durationMs = Number((trace.endNs - trace.startNs) / 1_000_000n)
      // A Map: a service may be named `__proto__` or `constructor`.
      const serviceStats = new Map<string, { spanCount: number; errorCount?: number }>()
      for (const stored of trace.spans) {
        const name = serviceName(stored)
        const stats = serviceStats.get(name) ?? { spanCount: 0 }
        stats.spanCount++
        if (stored.span.status.code === "STATUS_CODE_ERROR") {
          stats.errorCount = (stats.errorCount ?? 0) + 1
        }
        serviceStats.set(name, stats)
      }
      // An all-zero id trims to nothing, and jsonpb leaves an empty string out.
      const traceID = settings.leftPadTraceIds ? trace.traceId : trimTraceId(trace.traceId)
      return {
        ...(traceID === "" ? {} : { traceID }),
        rootServiceName: trace.rootServiceName || ROOT_SPAN_NOT_YET_RECEIVED,
        ...(trace.rootTraceName ? { rootTraceName: trace.rootTraceName } : {}),
        ...(trace.startNs === 0n ? {} : { startTimeUnixNano: trace.startNs.toString() }),
        ...(durationMs === 0 ? {} : { durationMs }),
        spanSet,
        spanSets: [spanSet],
        serviceStats: Object.fromEntries(serviceStats),
      }
    })
    return annotateResponse(
      jsonRes(200, {
        traces,
        metrics: {
          ...(all.length === 0 ? {} : { inspectedTraces: all.length }),
          ...(inspectedBytes === 0 ? {} : { inspectedBytes: String(inspectedBytes) }),
          completedJobs: 1,
          totalJobs: 1,
        },
      }),
      { ids: { traces: String(traces.length) } },
    )
  }

  /** A matched span as search lists it, carrying the attributes the query compared. */
  private searchSpan(stored: StoredSpan, query: Query) {
    const start = big(stored.span.startTimeUnixNano)
    const end = big(stored.span.endTimeUnixNano)
    const attributes: WireKeyValue[] = []
    for (const condition of query.conditions) {
      const attribute = resolveAttribute(condition, {
        span: stored.span.attributes,
        resource: stored.resource.attributes,
      })
      if (attribute && !attributes.some((kv) => kv.key === attribute.key)) {
        attributes.push(attribute)
      }
    }
    return {
      spanID: stored.spanId,
      ...(start === 0n ? {} : { startTimeUnixNano: start.toString() }),
      ...(end > start ? { durationNanos: (end - start).toString() } : {}),
      ...(attributes.length > 0 ? { attributes } : {}),
    }
  }

  private trace(context: OperationContext): Response {
    const { url, request } = context
    const id = parseTraceId(context.params.traceId ?? "")
    if (!id.ok) return badRequest(id.error)
    const mode = param(url, "mode")
    if (mode !== undefined && !["all", "ingesters", "blocks", "external"].includes(mode)) {
      return badRequest(`invalid value for mode ${mode}`)
    }
    if (mode !== "ingesters") {
      const start = integerParam(url, "start", "ParseInt", 64)
      if (!start.ok) return badRequest(start.error)
      const end = integerParam(url, "end", "ParseInt", 64)
      if (!end.ok) return badRequest(end.error)
      if (
        param(url, "start") !== undefined &&
        param(url, "end") !== undefined &&
        end.exact <= start.exact
      ) {
        return badRequest(
          `http parameter start must be before end. received start=${start.exact} end=${end.exact}`,
        )
      }
    }
    const tenants = this.readTenants(request)
    const spans = this.state.list(
      (span) => span.traceId === id.traceId && tenants.includes(span.tenant),
    )
    // Tempo's trace-by-id combiner: "404 with no body" when no job found the trace.
    if (spans.length === 0) return new Response(null, { status: 404 })
    return annotateResponse(jsonRes(200, { batches: batches(spans) }), {
      ids: { traceId: id.traceId },
    })
  }

  private tags(context: OperationContext): Response {
    const { url, request } = context
    const scope = param(url, "scope") ?? ""
    const scoped = (TAG_SCOPES as readonly string[]).includes(scope)
    if (!scoped && !["", "none", "trace", "intrinsic"].includes(scope)) {
      return badRequest(`invalid scope: ${scope}`)
    }
    if (param(url, "q") !== undefined) {
      return badRequest(`filtered tag names (q) not yet supported ${UNSUPPORTED_NOTE}`)
    }
    for (const name of ["start", "end"]) {
      const parsed = integerParam(url, name, "ParseInt", 32)
      if (!parsed.ok) return badRequest(parsed.error)
    }
    const limit = Number(/^\d+$/.test(param(url, "limit") ?? "") ? param(url, "limit") : 0)
    const everything = scope === "" || scope === "none"
    const tenants = this.readTenants(request)
    const spans = this.state.list((span) => tenants.includes(span.tenant))
    const names: Record<TagScope, Set<string>> = {
      resource: new Set(),
      span: new Set(),
      event: new Set(),
      link: new Set(),
      instrumentation: new Set(),
    }
    const collect = (target: TagScope, attributes: WireKeyValue[] | undefined) => {
      for (const kv of attributes ?? []) if (kv.key) names[target].add(kv.key)
    }
    let inspectedBytes = 0
    for (const stored of spans) {
      inspectedBytes += JSON.stringify(stored.span).length
      collect("resource", stored.resource.attributes)
      collect("span", stored.span.attributes)
      collect("instrumentation", stored.scope.attributes)
      for (const event of stored.span.events ?? []) collect("event", event.attributes)
      for (const link of stored.span.links ?? []) collect("link", link.attributes)
    }
    const scopes: { name: string; tags: string[] }[] = []
    for (const name of TAG_SCOPES) {
      if (!everything && scope !== name) continue
      // Go's sort.Strings: by code unit, not locale.
      const tags = [...names[name]].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
      if (tags.length > 0) scopes.push({ name, tags: limit > 0 ? tags.slice(0, limit) : tags })
    }
    if (everything || scope === "intrinsic") {
      scopes.push({ name: "intrinsic", tags: [...INTRINSIC_TAGS] })
    }
    return jsonRes(200, {
      scopes,
      metrics: {
        ...(inspectedBytes === 0 ? {} : { inspectedBytes: String(inspectedBytes) }),
        totalJobs: 1,
        completedJobs: 1,
      },
    })
  }
}

export type { TempoRuntime, TempoRuntimeOptions } from "./runtime.js"
export { createRuntime, TEMPO_PRESETS } from "./runtime.js"
