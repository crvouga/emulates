/**
 * The OTLP/HTTP error body: every 4xx and 5xx carries a `google.rpc.Status`, in the encoding
 * the request came in (binary protobuf for `application/x-protobuf`, JSON for everything else,
 * as the Collector falls back).
 */
import { jsonRes } from "@crvouga/mockingbird-service"

export const PROTOBUF = "application/x-protobuf"

export const mediaType = (request: Request): string =>
  request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? ""

const varint = (value: number): number[] => {
  const bytes: number[] = []
  let rest = value >>> 0
  while (rest > 0x7f) {
    bytes.push((rest & 0x7f) | 0x80)
    rest >>>= 7
  }
  bytes.push(rest)
  return bytes
}

/** `Status { int32 code = 1; string message = 2 }` on the wire; zero values are left out. */
export const encodeStatus = (code: number, message: string): Uint8Array<ArrayBuffer> => {
  const text = new TextEncoder().encode(message)
  return Uint8Array.from([
    ...(code === 0 ? [] : [0x08, ...varint(code)]),
    ...(text.length === 0 ? [] : [0x12, ...varint(text.length), ...text]),
  ])
}

/** An OTLP failure (code 16 = UNAUTHENTICATED, 3 = INVALID_ARGUMENT) answering `request`. */
export const rpcStatus = (
  request: Request,
  status: number,
  code: number,
  message: string,
): Response =>
  mediaType(request) === PROTOBUF
    ? new Response(encodeStatus(code, message), { status, headers: { "content-type": PROTOBUF } })
    : jsonRes(status, { code, message })
