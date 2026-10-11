/**
 * A protobuf wire-format decoder for `ExportTraceServiceRequest`, the body an OTLP/HTTP exporter
 * sends as `application/x-protobuf`. It produces the same shape as OTLP/JSON (lowerCamelCase
 * keys, hex ids, 64-bit integers as decimal strings) so one normaliser handles both encodings.
 *
 * Tempo is a trace store: `GET /api/traces/{id}` hands back everything a span carried. So every
 * field of opentelemetry-proto v1 `trace.proto` is decoded (links, trace state, flags, dropped
 * counts, scope attributes, schema URLs), not only the ones a search needs. No dependencies.
 */

export class ProtobufError extends Error {
  constructor(message: string) {
    super(`invalid protobuf: ${message}`)
    this.name = "ProtobufError"
  }
}

type Json = Record<string, unknown>

const utf8 = new TextDecoder("utf-8", { fatal: false })

class Reader {
  pos = 0
  constructor(private readonly buf: Uint8Array) {}

  get done(): boolean {
    return this.pos >= this.buf.length
  }

  varint(): bigint {
    let result = 0n
    let shift = 0n
    for (let i = 0; i < 10; i++) {
      if (this.pos >= this.buf.length) throw new ProtobufError("truncated varint")
      const byte = this.buf[this.pos++] as number
      result |= BigInt(byte & 0x7f) << shift
      if ((byte & 0x80) === 0) return result
      shift += 7n
    }
    throw new ProtobufError("varint longer than 10 bytes")
  }

  fixed64(): bigint {
    const bytes = this.take(8)
    let result = 0n
    for (let i = 7; i >= 0; i--) result = (result << 8n) | BigInt(bytes[i] as number)
    return result
  }

  fixed32(): number {
    const bytes = this.take(4)
    return new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, true)
  }

  double(): number {
    const bytes = this.take(8)
    return new DataView(bytes.buffer, bytes.byteOffset, 8).getFloat64(0, true)
  }

  bytes(): Uint8Array {
    return this.take(Number(this.varint()))
  }

  take(length: number): Uint8Array {
    if (length < 0 || this.pos + length > this.buf.length) {
      throw new ProtobufError("length-delimited field runs past the end")
    }
    const out = this.buf.subarray(this.pos, this.pos + length)
    this.pos += length
    return out
  }

  skip(wireType: number): void {
    if (wireType === 0) this.varint()
    else if (wireType === 1) this.take(8)
    else if (wireType === 2) this.bytes()
    else if (wireType === 5) this.take(4)
    else throw new ProtobufError(`unsupported wire type ${wireType}`)
  }
}

type FieldHandler = (field: number, wireType: number, reader: Reader) => boolean

/** Walk a message's fields; the handler returns false for fields it does not read. */
const walk = (bytes: Uint8Array, handler: FieldHandler): void => {
  const reader = new Reader(bytes)
  while (!reader.done) {
    const key = reader.varint()
    // Field numbers are 29 bits; a larger tag must not alias a small field number.
    if (key >> 3n > 536_870_911n) throw new ProtobufError("field number out of range")
    const field = Number(key >> 3n)
    const wireType = Number(key & 7n)
    if (field === 0) throw new ProtobufError("field number 0")
    if (!handler(field, wireType, reader)) reader.skip(wireType)
  }
}

const hex = (bytes: Uint8Array): string =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")

const base64 = (bytes: Uint8Array): string => {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

/** Two's-complement int64 from a varint. */
const int64 = (value: bigint): string => BigInt.asIntN(64, value).toString()

const uint32 = (value: bigint): number => Number(BigInt.asUintN(32, value))

/** A proto enum travels as a varint of its int32 value. */
const enumValue = (value: bigint): number => Number(BigInt.asIntN(32, value))

/** Nesting an `AnyValue` may reach before the message is refused instead of exhausting the stack. */
const MAX_VALUE_DEPTH = 100

const decodeAnyValue = (bytes: Uint8Array, depth = 0): Json => {
  if (depth > MAX_VALUE_DEPTH) throw new ProtobufError("value nested too deeply")
  let out: Json = {}
  walk(bytes, (field, wire, r) => {
    if (field === 1 && wire === 2) out = { stringValue: utf8.decode(r.bytes()) }
    else if (field === 2 && wire === 0) out = { boolValue: r.varint() !== 0n }
    else if (field === 3 && wire === 0) out = { intValue: int64(r.varint()) }
    else if (field === 4 && wire === 1) out = { doubleValue: r.double() }
    else if (field === 5 && wire === 2) {
      out = { arrayValue: { values: decodeValues(r.bytes(), depth + 1) } }
    } else if (field === 6 && wire === 2) {
      out = { kvlistValue: { values: decodeKeyValues(r.bytes(), depth + 1) } }
    } else if (field === 7 && wire === 2) out = { bytesValue: base64(r.bytes()) }
    else return false
    return true
  })
  return out
}

/** `ArrayValue { repeated AnyValue values = 1 }`. */
const decodeValues = (bytes: Uint8Array, depth: number): Json[] => {
  const values: Json[] = []
  walk(bytes, (field, wire, r) => {
    if (field !== 1 || wire !== 2) return false
    values.push(decodeAnyValue(r.bytes(), depth))
    return true
  })
  return values
}

/** `KeyValueList { repeated KeyValue values = 1 }`. */
const decodeKeyValues = (bytes: Uint8Array, depth: number): Json[] => {
  const values: Json[] = []
  walk(bytes, (field, wire, r) => {
    if (field !== 1 || wire !== 2) return false
    values.push(decodeKeyValue(r.bytes(), depth))
    return true
  })
  return values
}

const decodeKeyValue = (bytes: Uint8Array, depth = 0): Json => {
  const kv: Json = { key: "" }
  walk(bytes, (field, wire, r) => {
    if (field === 1 && wire === 2) kv.key = utf8.decode(r.bytes())
    else if (field === 2 && wire === 2) kv.value = decodeAnyValue(r.bytes(), depth)
    else return false
    return true
  })
  return kv
}

/** `Resource { repeated KeyValue attributes = 1; uint32 dropped_attributes_count = 2 }`. */
const decodeResource = (bytes: Uint8Array): Json => {
  const resource: Json = { attributes: [] }
  walk(bytes, (field, wire, r) => {
    if (field === 1 && wire === 2) (resource.attributes as Json[]).push(decodeKeyValue(r.bytes()))
    else if (field === 2 && wire === 0) resource.droppedAttributesCount = uint32(r.varint())
    else return false
    return true
  })
  return resource
}

/** `InstrumentationScope { name = 1; version = 2; attributes = 3; dropped_attributes_count = 4 }`. */
const decodeScope = (bytes: Uint8Array): Json => {
  const scope: Json = { attributes: [] }
  walk(bytes, (field, wire, r) => {
    if (field === 1 && wire === 2) scope.name = utf8.decode(r.bytes())
    else if (field === 2 && wire === 2) scope.version = utf8.decode(r.bytes())
    else if (field === 3 && wire === 2) {
      ;(scope.attributes as Json[]).push(decodeKeyValue(r.bytes()))
    } else if (field === 4 && wire === 0) scope.droppedAttributesCount = uint32(r.varint())
    else return false
    return true
  })
  return scope
}

const decodeEvent = (bytes: Uint8Array): Json => {
  const event: Json = { attributes: [] }
  walk(bytes, (field, wire, r) => {
    if (field === 1 && wire === 1) event.timeUnixNano = r.fixed64().toString()
    else if (field === 2 && wire === 2) event.name = utf8.decode(r.bytes())
    else if (field === 3 && wire === 2) {
      ;(event.attributes as Json[]).push(decodeKeyValue(r.bytes()))
    } else if (field === 4 && wire === 0) event.droppedAttributesCount = uint32(r.varint())
    else return false
    return true
  })
  return event
}

const decodeLink = (bytes: Uint8Array): Json => {
  const link: Json = { attributes: [] }
  walk(bytes, (field, wire, r) => {
    if (field === 1 && wire === 2) link.traceId = hex(r.bytes())
    else if (field === 2 && wire === 2) link.spanId = hex(r.bytes())
    else if (field === 3 && wire === 2) link.traceState = utf8.decode(r.bytes())
    else if (field === 4 && wire === 2) (link.attributes as Json[]).push(decodeKeyValue(r.bytes()))
    else if (field === 5 && wire === 0) link.droppedAttributesCount = uint32(r.varint())
    else if (field === 6 && wire === 5) link.flags = r.fixed32()
    else return false
    return true
  })
  return link
}

const decodeStatus = (bytes: Uint8Array): Json => {
  const status: Json = {}
  walk(bytes, (field, wire, r) => {
    if (field === 2 && wire === 2) status.message = utf8.decode(r.bytes())
    else if (field === 3 && wire === 0) status.code = enumValue(r.varint())
    else return false
    return true
  })
  return status
}

const decodeSpan = (bytes: Uint8Array): Json => {
  const span: Json = { attributes: [], events: [], links: [] }
  walk(bytes, (field, wire, r) => {
    if (field === 1 && wire === 2) span.traceId = hex(r.bytes())
    else if (field === 2 && wire === 2) span.spanId = hex(r.bytes())
    else if (field === 3 && wire === 2) span.traceState = utf8.decode(r.bytes())
    else if (field === 4 && wire === 2) span.parentSpanId = hex(r.bytes())
    else if (field === 5 && wire === 2) span.name = utf8.decode(r.bytes())
    else if (field === 6 && wire === 0) span.kind = enumValue(r.varint())
    else if (field === 7 && wire === 1) span.startTimeUnixNano = r.fixed64().toString()
    else if (field === 8 && wire === 1) span.endTimeUnixNano = r.fixed64().toString()
    else if (field === 9 && wire === 2) (span.attributes as Json[]).push(decodeKeyValue(r.bytes()))
    else if (field === 10 && wire === 0) span.droppedAttributesCount = uint32(r.varint())
    else if (field === 11 && wire === 2) (span.events as Json[]).push(decodeEvent(r.bytes()))
    else if (field === 12 && wire === 0) span.droppedEventsCount = uint32(r.varint())
    else if (field === 13 && wire === 2) (span.links as Json[]).push(decodeLink(r.bytes()))
    else if (field === 14 && wire === 0) span.droppedLinksCount = uint32(r.varint())
    else if (field === 15 && wire === 2) span.status = decodeStatus(r.bytes())
    else if (field === 16 && wire === 5) span.flags = r.fixed32()
    else return false
    return true
  })
  return span
}

/** `ScopeSpans { scope = 1; repeated Span spans = 2; string schema_url = 3 }`. */
const decodeScopeSpans = (bytes: Uint8Array): Json => {
  const scoped: Json = { spans: [] }
  walk(bytes, (field, wire, r) => {
    if (field === 1 && wire === 2) scoped.scope = decodeScope(r.bytes())
    else if (field === 2 && wire === 2) (scoped.spans as Json[]).push(decodeSpan(r.bytes()))
    else if (field === 3 && wire === 2) scoped.schemaUrl = utf8.decode(r.bytes())
    else return false
    return true
  })
  return scoped
}

/** `ResourceSpans { resource = 1; repeated ScopeSpans scope_spans = 2; string schema_url = 3 }`. */
const decodeResourceSpans = (bytes: Uint8Array): Json => {
  const group: Json = { scopeSpans: [] }
  walk(bytes, (field, wire, r) => {
    if (field === 1 && wire === 2) group.resource = decodeResource(r.bytes())
    else if (field === 2 && wire === 2) {
      ;(group.scopeSpans as Json[]).push(decodeScopeSpans(r.bytes()))
    } else if (field === 3 && wire === 2) group.schemaUrl = utf8.decode(r.bytes())
    else return false
    return true
  })
  return group
}

/** `ExportTraceServiceRequest` → OTLP/JSON `{resourceSpans: [...]}`. */
export const decodeTraceRequest = (bytes: Uint8Array): { resourceSpans: Json[] } => {
  const resourceSpans: Json[] = []
  walk(bytes, (field, wire, r) => {
    if (field !== 1 || wire !== 2) return false
    resourceSpans.push(decodeResourceSpans(r.bytes()))
    return true
  })
  return { resourceSpans }
}

const varint = (value: number): number[] => {
  const out: number[] = []
  let rest = value >>> 0
  while (rest > 0x7f) {
    out.push((rest & 0x7f) | 0x80)
    rest >>>= 7
  }
  out.push(rest)
  return out
}

/**
 * `google.rpc.Status { int32 code = 1; string message = 2 }`, the body of an OTLP error when
 * the request was protobuf (the response uses the request's encoding).
 */
export const encodeRpcStatus = (code: number, message: string): Uint8Array => {
  const text = new TextEncoder().encode(message)
  return new Uint8Array([
    ...(code === 0 ? [] : [0x08, ...varint(code)]),
    ...(text.length === 0 ? [] : [0x12, ...varint(text.length), ...text]),
  ])
}

/** The inverse of {@link encodeRpcStatus}, for clients and tests reading a protobuf error. */
export const decodeRpcStatus = (bytes: Uint8Array): { code: number; message: string } => {
  const status = { code: 0, message: "" }
  walk(bytes, (field, wire, r) => {
    if (field === 1 && wire === 0) status.code = Number(BigInt.asIntN(32, r.varint()))
    else if (field === 2 && wire === 2) status.message = utf8.decode(r.bytes())
    else return false
    return true
  })
  return status
}
