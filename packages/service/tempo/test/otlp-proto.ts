/**
 * A test-side protobuf encoder for `ExportTraceServiceRequest`, written against
 * opentelemetry-proto v1 independently of the emulator's decoder: it turns the OTLP/JSON shape
 * `tracesExport` builds into the bytes a protobuf exporter posts, so one fixture can be sent in
 * both encodings and the two ingests compared.
 */
type Json = Record<string, unknown>

const varint = (value: bigint): number[] => {
  const out: number[] = []
  let rest = BigInt.asUintN(64, value)
  while (rest > 0x7fn) {
    out.push(Number(rest & 0x7fn) | 0x80)
    rest >>= 7n
  }
  out.push(Number(rest))
  return out
}

const key = (field: number, wire: number) => varint(BigInt((field << 3) | wire))
const bytes = (field: number, data: number[] | Uint8Array) => [
  ...key(field, 2),
  ...varint(BigInt(data.length)),
  ...data,
]
const string = (field: number, value: unknown) =>
  typeof value === "string" && value !== "" ? bytes(field, new TextEncoder().encode(value)) : []
const uint = (field: number, value: unknown) =>
  typeof value === "number" && value !== 0 ? [...key(field, 0), ...varint(BigInt(value))] : []
const fixed64 = (field: number, value: unknown) => {
  if (value === undefined) return []
  const out = new Uint8Array(8)
  new DataView(out.buffer).setBigUint64(0, BigInt(String(value)), true)
  return [...key(field, 1), ...out]
}
const hex = (field: number, value: unknown) =>
  typeof value === "string" && value !== ""
    ? bytes(field, value.match(/../g)?.map((pair) => Number.parseInt(pair, 16)) ?? [])
    : []
const each = (value: unknown, encode: (item: Json) => number[], field: number) =>
  (Array.isArray(value) ? (value as Json[]) : []).flatMap((item) => bytes(field, encode(item)))

const anyValue = (value: Json): number[] => {
  if (typeof value.stringValue === "string") {
    return bytes(1, new TextEncoder().encode(value.stringValue))
  }
  if (typeof value.boolValue === "boolean") return [...key(2, 0), value.boolValue ? 1 : 0]
  if (value.intValue !== undefined) return [...key(3, 0), ...varint(BigInt(String(value.intValue)))]
  if (typeof value.doubleValue === "number") {
    const out = new Uint8Array(8)
    new DataView(out.buffer).setFloat64(0, value.doubleValue, true)
    return [...key(4, 1), ...out]
  }
  if (value.arrayValue) return bytes(5, each((value.arrayValue as Json).values, anyValue, 1))
  return []
}

const keyValue = (kv: Json): number[] => [
  ...string(1, kv.key),
  ...bytes(2, anyValue((kv.value ?? {}) as Json)),
]

const event = (e: Json): number[] => [
  ...fixed64(1, e.timeUnixNano),
  ...string(2, e.name),
  ...each(e.attributes, keyValue, 3),
  ...uint(4, e.droppedAttributesCount),
]

const link = (l: Json): number[] => [
  ...hex(1, l.traceId),
  ...hex(2, l.spanId),
  ...string(3, l.traceState),
  ...each(l.attributes, keyValue, 4),
  ...uint(5, l.droppedAttributesCount),
]

const status = (s: Json): number[] => [...string(2, s.message), ...uint(3, s.code)]

const span = (s: Json): number[] => [
  ...hex(1, s.traceId),
  ...hex(2, s.spanId),
  ...string(3, s.traceState),
  ...hex(4, s.parentSpanId),
  ...string(5, s.name),
  ...uint(6, s.kind),
  ...fixed64(7, s.startTimeUnixNano),
  ...fixed64(8, s.endTimeUnixNano),
  ...each(s.attributes, keyValue, 9),
  ...uint(10, s.droppedAttributesCount),
  ...each(s.events, event, 11),
  ...uint(12, s.droppedEventsCount),
  ...each(s.links, link, 13),
  ...uint(14, s.droppedLinksCount),
  ...bytes(15, status((s.status ?? {}) as Json)),
]

const scope = (s: Json): number[] => [
  ...string(1, s.name),
  ...string(2, s.version),
  ...each(s.attributes, keyValue, 3),
]

const scopeSpans = (s: Json): number[] => [
  ...bytes(1, scope((s.scope ?? {}) as Json)),
  ...each(s.spans, span, 2),
  ...string(3, s.schemaUrl),
]

const resourceSpans = (r: Json): number[] => [
  ...bytes(1, each(((r.resource ?? {}) as Json).attributes, keyValue, 1)),
  ...each(r.scopeSpans, scopeSpans, 2),
  ...string(3, r.schemaUrl),
]

/** OTLP/JSON `{resourceSpans: [...]}` → `ExportTraceServiceRequest` bytes. */
export const encodeTraceRequest = (request: Json): Uint8Array =>
  new Uint8Array(each(request.resourceSpans, resourceSpans, 1))
