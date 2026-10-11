/**
 * OTLP export requests (JSON, or protobuf decoded to the same shape) → the spans Tempo stores,
 * already in the JSON shape `GET /api/traces/{id}` answers with.
 *
 * Tempo marshals its `tempopb.Trace` with gogo `jsonpb` defaults, which is not OTLP/JSON: ids are
 * base64 (proto `bytes`), enums are their names (`SPAN_KIND_SERVER`, `STATUS_CODE_ERROR`),
 * 64-bit integers are decimal strings, and zero values are left out. `resource`, `scope` and
 * `status` are always present because the OTLP receiver in front of Tempo always writes them.
 */

type Json = Record<string, unknown>

const isRecord = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** OTLP/JSON is lowerCamelCase; the receiver takes the proto snake_case spelling too. */
const pick = (object: Json, camel: string): unknown => {
  if (object[camel] !== undefined) return object[camel]
  const snake = camel.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)
  return object[snake]
}

/** A rejected export: OTLP `INVALID_ARGUMENT` (google.rpc code 3), HTTP 400. */
export class OtlpError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "OtlpError"
  }
}

const list = (object: Json, camel: string): Json[] => {
  const value = pick(object, camel)
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw new OtlpError(`${camel} must be an array`)
  return value.map((item) => {
    if (!isRecord(item)) throw new OtlpError(`${camel} must hold objects`)
    return item
  })
}

export type WireAnyValue = {
  stringValue?: string
  boolValue?: boolean
  /** int64 as a decimal string. */
  intValue?: string
  doubleValue?: number | "NaN" | "Infinity" | "-Infinity"
  arrayValue?: { values?: WireAnyValue[] }
  kvlistValue?: { values?: WireKeyValue[] }
  /** base64. */
  bytesValue?: string
}
export type WireKeyValue = { key?: string; value?: WireAnyValue }
export type WireEvent = {
  timeUnixNano?: string
  name?: string
  attributes?: WireKeyValue[]
  droppedAttributesCount?: number
}
export type WireLink = {
  /** base64. */
  traceId?: string
  /** base64. */
  spanId?: string
  traceState?: string
  attributes?: WireKeyValue[]
  droppedAttributesCount?: number
  flags?: number
}
export type WireStatus = {
  message?: string
  /** `STATUS_CODE_OK` or `STATUS_CODE_ERROR`; a number only for a value the enum does not name. */
  code?: string | number
}
export type WireSpan = {
  /** base64 of the 16 id bytes. */
  traceId: string
  /** base64 of the 8 id bytes. */
  spanId: string
  traceState?: string
  /** base64; absent on a root span. */
  parentSpanId?: string
  flags?: number
  name?: string
  /** `SPAN_KIND_SERVER`, …; a number only for a value the enum does not name. */
  kind?: string | number
  startTimeUnixNano?: string
  endTimeUnixNano?: string
  attributes?: WireKeyValue[]
  droppedAttributesCount?: number
  events?: WireEvent[]
  droppedEventsCount?: number
  links?: WireLink[]
  droppedLinksCount?: number
  status: WireStatus
}
export type WireResource = { attributes?: WireKeyValue[]; droppedAttributesCount?: number }
export type WireScope = {
  name?: string
  version?: string
  attributes?: WireKeyValue[]
  droppedAttributesCount?: number
}
export type WireScopeSpans = { scope: WireScope; spans: WireSpan[]; schemaUrl?: string }
export type WireResourceSpans = {
  resource: WireResource
  scopeSpans: WireScopeSpans[]
  schemaUrl?: string
}

const SPAN_KINDS = [
  "SPAN_KIND_UNSPECIFIED",
  "SPAN_KIND_INTERNAL",
  "SPAN_KIND_SERVER",
  "SPAN_KIND_CLIENT",
  "SPAN_KIND_PRODUCER",
  "SPAN_KIND_CONSUMER",
] as const
const STATUS_CODES = ["STATUS_CODE_UNSET", "STATUS_CODE_OK", "STATUS_CODE_ERROR"] as const

/** A proto enum, sent as its number or its name. */
const enumIndex = (value: unknown, names: readonly string[], field: string): number => {
  if (value === undefined || value === null) return 0
  const int32 = (n: number) => Number.isInteger(n) && n >= -(2 ** 31) && n < 2 ** 31
  if (typeof value === "number" && int32(value)) return value
  if (typeof value === "string") {
    const index = names.indexOf(value)
    if (index >= 0) return index
    if (/^-?\d+$/.test(value) && int32(Number(value))) return Number(value)
  }
  throw new OtlpError(`${field}: unknown enum value ${JSON.stringify(value)}`)
}

/** An unsigned integer of `bits` width from a decimal string or a JSON number; `0n` when absent. */
const unsigned = (value: unknown, field: string, bits: number): bigint => {
  if (value === undefined || value === null || value === "") return 0n
  const parsed =
    typeof value === "string" && /^\d+$/.test(value)
      ? BigInt(value)
      : typeof value === "number" && Number.isInteger(value) && value >= 0
        ? BigInt(value)
        : undefined
  if (parsed === undefined || parsed >= 2n ** BigInt(bits)) {
    throw new OtlpError(
      `${field}: expected an unsigned ${bits}-bit integer, got ${JSON.stringify(value)}`,
    )
  }
  return parsed
}

const uint64 = (value: unknown, field: string): bigint => unsigned(value, field, 64)
const uint32 = (value: unknown, field: string): number => Number(unsigned(value, field, 32))

const text = (value: unknown, field: string): string => {
  if (value === undefined || value === null) return ""
  if (typeof value !== "string") throw new OtlpError(`${field}: expected a string`)
  return value
}

const HEX = /^[0-9a-fA-F]*$/

/** Nesting an `AnyValue` may reach before the export is refused instead of exhausting the stack. */
const MAX_VALUE_DEPTH = 100

/** Lowercase hex of an id field; throws when it is not hex at all. */
const hexId = (value: unknown, field: string): string => {
  const id = text(value, field)
  if (!HEX.test(id) || id.length % 2 === 1) {
    throw new OtlpError(`${field}: expected a hex-encoded id, got ${JSON.stringify(id)}`)
  }
  return id.toLowerCase()
}

/** An optional id that, when present, has exactly `bytes` bytes. */
const sizedId = (value: unknown, field: string, bytes: number): string => {
  const id = hexId(value, field)
  if (id.length !== 0 && id.length !== bytes * 2) {
    throw new OtlpError(`${field}: expected ${bytes} bytes, got ${id.length / 2}`)
  }
  return id
}

export const hexToBase64 = (hex: string): string => {
  let binary = ""
  for (let i = 0; i < hex.length; i += 2) {
    binary += String.fromCharCode(Number.parseInt(hex.slice(i, i + 2), 16))
  }
  return btoa(binary)
}

export const base64ToHex = (value: string): string =>
  Array.from(atob(value), (c) => c.charCodeAt(0).toString(16).padStart(2, "0")).join("")

const anyValue = (value: unknown, field: string, depth = 0): WireAnyValue => {
  if (depth > MAX_VALUE_DEPTH) throw new OtlpError(`${field}: value nested too deeply`)
  if (value === undefined || value === null) return {}
  if (!isRecord(value)) throw new OtlpError(`${field}: expected an AnyValue object`)
  const string = pick(value, "stringValue")
  if (string !== undefined) return { stringValue: text(string, field) }
  const bool = pick(value, "boolValue")
  if (bool !== undefined) {
    if (typeof bool !== "boolean") throw new OtlpError(`${field}: boolValue must be a boolean`)
    return { boolValue: bool }
  }
  const int = pick(value, "intValue")
  if (int !== undefined) {
    const parsed =
      typeof int === "string" && /^-?\d+$/.test(int)
        ? BigInt(int)
        : typeof int === "number" && Number.isInteger(int)
          ? BigInt(int)
          : undefined
    if (parsed === undefined || parsed < -(2n ** 63n) || parsed >= 2n ** 63n) {
      throw new OtlpError(`${field}: intValue must be a 64-bit integer`)
    }
    return { intValue: parsed.toString() }
  }
  const double = pick(value, "doubleValue")
  if (double !== undefined) {
    const DECIMAL = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/
    const named = double === "NaN" || double === "Infinity" || double === "-Infinity"
    const number =
      typeof double === "number"
        ? double
        : typeof double === "string" && (named || DECIMAL.test(double))
          ? Number(double)
          : undefined
    if (number === undefined) throw new OtlpError(`${field}: doubleValue must be a number`)
    if (Number.isNaN(number)) return { doubleValue: "NaN" }
    if (!Number.isFinite(number)) return { doubleValue: number > 0 ? "Infinity" : "-Infinity" }
    return { doubleValue: number }
  }
  const array = pick(value, "arrayValue")
  if (array !== undefined) {
    if (!isRecord(array)) throw new OtlpError(`${field}: arrayValue must be an object`)
    const raw = pick(array, "values")
    if (raw !== undefined && raw !== null && !Array.isArray(raw)) {
      throw new OtlpError(`${field}: arrayValue.values must be an array`)
    }
    const values = (Array.isArray(raw) ? raw : []).map((item) => anyValue(item, field, depth + 1))
    return { arrayValue: values.length > 0 ? { values } : {} }
  }
  const kvlist = pick(value, "kvlistValue")
  if (kvlist !== undefined) {
    if (!isRecord(kvlist)) throw new OtlpError(`${field}: kvlistValue must be an object`)
    const values = keyValues(kvlist, "values", field, depth + 1)
    return { kvlistValue: values ? { values } : {} }
  }
  const bytes = pick(value, "bytesValue")
  if (bytes !== undefined) return { bytesValue: text(bytes, field) }
  return {}
}

/** `KeyValue[]` in wire shape, or `undefined` when empty (jsonpb leaves empty lists out). */
const keyValues = (
  object: Json,
  camel: string,
  field: string,
  depth = 0,
): WireKeyValue[] | undefined => {
  const out = list(object, camel).map((kv): WireKeyValue => {
    const key = text(kv.key, `${field}.key`)
    return {
      ...(key === "" ? {} : { key }),
      ...(kv.value === undefined || kv.value === null
        ? {}
        : { value: anyValue(kv.value, `${field}[${JSON.stringify(key)}]`, depth) }),
    }
  })
  return out.length > 0 ? out : undefined
}

/** Spread-ready `{[key]: value}` unless the value is the proto zero value. */
const unlessZero = <K extends string, V extends string | number>(
  key: K,
  value: V,
): { [P in K]?: V } => (value === "" || value === 0 ? {} : ({ [key]: value } as { [P in K]: V }))

const attributed = (object: Json, field: string) => {
  const attributes = keyValues(object, "attributes", `${field}.attributes`)
  return {
    ...(attributes ? { attributes } : {}),
    ...unlessZero(
      "droppedAttributesCount",
      uint32(pick(object, "droppedAttributesCount"), `${field}.droppedAttributesCount`),
    ),
  }
}

const nanos = (value: unknown, field: string): string => uint64(value, field).toString()

/** One span of an export, with the resource and scope it arrived under. */
export type DecodedSpan = {
  /** 32 lowercase hex characters. */
  traceId: string
  /** 16 lowercase hex characters. */
  spanId: string
  /** 16 lowercase hex characters, or `""` for a root span. */
  parentSpanId: string
  /** Position of the span's `ResourceSpans` in the export. */
  resourceIndex: number
  /** Position of the span's `ScopeSpans` in its `ResourceSpans`. */
  scopeIndex: number
  resource: WireResource
  resourceSchemaUrl: string
  scope: WireScope
  scopeSchemaUrl: string
  span: WireSpan
}

/**
 * Tempo's distributor checks, run after the receiver decoded the export: a trace id is exactly
 * 128 bits, a span id is exactly 64 bits and not all zero. Both messages are Tempo's own
 * (`modules/distributor/distributor.go`). The first offending span fails the whole export.
 */
export const validateIds = (spans: readonly DecodedSpan[]): void => {
  for (const { traceId, spanId } of spans) {
    if (traceId.length !== 32) {
      throw new OtlpError(`trace ids must be 128 bit, received ${traceId.length * 4} bits`)
    }
    if (spanId.length !== 16 || /^0+$/.test(spanId)) {
      throw new OtlpError(
        `span ids must be 64 bit and not all zero, received ${spanId.length * 4} bits`,
      )
    }
  }
}

/** Values for fields an injected span leaves out (`POST /__admin/traces`). */
export type SpanDefaults = {
  /** Start time for a span with none: the emulator clock, in nanoseconds. */
  startTimeUnixNano: string
}

const decodeSpan = (
  span: Json,
  defaults: SpanDefaults | undefined,
): { traceId: string; spanId: string; parent: string; wire: WireSpan } => {
  const traceId = hexId(pick(span, "traceId"), "traceId")
  const spanId = hexId(pick(span, "spanId"), "spanId")
  const rawParent = sizedId(pick(span, "parentSpanId"), "parentSpanId", 8)
  // An all-zero parent is "no parent", as the OTLP specification defines an invalid span id.
  const parent = /^0*$/.test(rawParent) ? "" : rawParent
  const kind = enumIndex(pick(span, "kind"), SPAN_KINDS, "kind")
  const status = pick(span, "status")
  if (status !== undefined && status !== null && !isRecord(status)) {
    throw new OtlpError("status must be an object")
  }
  const code = isRecord(status) ? enumIndex(pick(status, "code"), STATUS_CODES, "status.code") : 0
  const events = list(span, "events").map(
    (event): WireEvent => ({
      ...unlessZero("timeUnixNano", nanos(pick(event, "timeUnixNano"), "events.timeUnixNano")),
      ...unlessZero("name", text(event.name, "events.name")),
      ...attributed(event, "events"),
    }),
  )
  const links = list(span, "links").map((link): WireLink => {
    const linkTrace = sizedId(pick(link, "traceId"), "links.traceId", 16)
    const linkSpan = sizedId(pick(link, "spanId"), "links.spanId", 8)
    return {
      ...unlessZero("traceId", hexToBase64(linkTrace)),
      ...unlessZero("spanId", hexToBase64(linkSpan)),
      ...unlessZero("traceState", text(pick(link, "traceState"), "links.traceState")),
      ...attributed(link, "links"),
      ...unlessZero("flags", uint32(pick(link, "flags"), "links.flags")),
    }
  })
  const givenStart = nanos(pick(span, "startTimeUnixNano"), "startTimeUnixNano")
  const start = givenStart === "0" && defaults ? defaults.startTimeUnixNano : givenStart
  const givenEnd = nanos(pick(span, "endTimeUnixNano"), "endTimeUnixNano")
  const end = givenEnd === "0" && defaults ? start : givenEnd
  const message = isRecord(status) ? text(status.message, "status.message") : ""
  const wire: WireSpan = {
    traceId: hexToBase64(traceId),
    spanId: hexToBase64(spanId),
    ...unlessZero("traceState", text(pick(span, "traceState"), "traceState")),
    ...(parent === "" ? {} : { parentSpanId: hexToBase64(parent) }),
    ...unlessZero("flags", uint32(pick(span, "flags"), "flags")),
    ...unlessZero("name", text(span.name, "name")),
    ...(kind === 0 ? {} : { kind: SPAN_KINDS[kind] ?? kind }),
    ...(start === "0" ? {} : { startTimeUnixNano: start }),
    ...(end === "0" ? {} : { endTimeUnixNano: end }),
    ...attributed(span, "span"),
    ...(events.length > 0 ? { events } : {}),
    ...unlessZero(
      "droppedEventsCount",
      uint32(pick(span, "droppedEventsCount"), "droppedEventsCount"),
    ),
    ...(links.length > 0 ? { links } : {}),
    ...unlessZero(
      "droppedLinksCount",
      uint32(pick(span, "droppedLinksCount"), "droppedLinksCount"),
    ),
    status: {
      ...unlessZero("message", message),
      ...(code === 0 ? {} : { code: STATUS_CODES[code] ?? code }),
    },
  }
  return { traceId, spanId, parent, wire }
}

/**
 * `ExportTraceServiceRequest` → one {@link DecodedSpan} per span, in export order. Throws
 * {@link OtlpError} for a payload the receiver cannot decode. Ids are hex of whatever length
 * was sent: {@link validateIds} is the separate, later check.
 */
export const decodeSpans = (request: unknown, defaults?: SpanDefaults): DecodedSpan[] => {
  if (!isRecord(request)) throw new OtlpError("request body is not an OTLP export request")
  const out: DecodedSpan[] = []
  list(request, "resourceSpans").forEach((group, resourceIndex) => {
    const rawResource = pick(group, "resource")
    if (rawResource !== undefined && rawResource !== null && !isRecord(rawResource)) {
      throw new OtlpError("resource must be an object")
    }
    const resource: WireResource = isRecord(rawResource) ? attributed(rawResource, "resource") : {}
    const resourceSchemaUrl = text(pick(group, "schemaUrl"), "schemaUrl")
    list(group, "scopeSpans").forEach((scoped, scopeIndex) => {
      const rawScope = pick(scoped, "scope")
      if (rawScope !== undefined && rawScope !== null && !isRecord(rawScope)) {
        throw new OtlpError("scope must be an object")
      }
      const scope: WireScope = isRecord(rawScope)
        ? {
            ...unlessZero("name", text(rawScope.name, "scope.name")),
            ...unlessZero("version", text(rawScope.version, "scope.version")),
            ...attributed(rawScope, "scope"),
          }
        : {}
      const scopeSchemaUrl = text(pick(scoped, "schemaUrl"), "schemaUrl")
      for (const raw of list(scoped, "spans")) {
        const { traceId, spanId, parent, wire } = decodeSpan(raw, defaults)
        out.push({
          traceId,
          spanId,
          parentSpanId: parent,
          resourceIndex,
          scopeIndex,
          resource,
          resourceSchemaUrl,
          scope,
          scopeSchemaUrl,
          span: wire,
        })
      }
    })
  })
  return out
}

/** What a TraceQL comparison sees of an attribute value. */
export type AttributeValue =
  | { type: "string"; value: string }
  | { type: "int"; value: bigint }
  | { type: "float"; value: number }
  | { type: "bool"; value: boolean }

/**
 * The comparable values of an attribute: one for a scalar, one per element for an array (TraceQL
 * `=` matches an array when any element does), none for a kvlist, bytes or an empty value.
 */
export const comparableValues = (value: WireAnyValue | undefined): AttributeValue[] => {
  if (!value) return []
  if (value.stringValue !== undefined) return [{ type: "string", value: value.stringValue }]
  if (value.boolValue !== undefined) return [{ type: "bool", value: value.boolValue }]
  if (value.intValue !== undefined) return [{ type: "int", value: BigInt(value.intValue) }]
  if (value.doubleValue !== undefined) {
    return [{ type: "float", value: Number(value.doubleValue) }]
  }
  if (value.arrayValue !== undefined) {
    return (value.arrayValue.values ?? []).flatMap((item) =>
      item.arrayValue === undefined ? comparableValues(item) : [],
    )
  }
  return []
}

/** The first attribute named `key`, as Tempo's lookups resolve duplicates. */
export const findAttribute = (
  attributes: WireKeyValue[] | undefined,
  key: string,
): WireKeyValue | undefined => attributes?.find((kv) => (kv.key ?? "") === key)
