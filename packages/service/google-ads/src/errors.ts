export type AdsError = {
  errorCode: Record<string, string>
  message: string
  location?: { fieldPathElements: { fieldName: string; index?: number }[] }
}
const statuses: Record<number, string> = {
  400: "INVALID_ARGUMENT",
  401: "UNAUTHENTICATED",
  403: "PERMISSION_DENIED",
  404: "NOT_FOUND",
  409: "ALREADY_EXISTS",
  429: "RESOURCE_EXHAUSTED",
  500: "INTERNAL",
  503: "UNAVAILABLE",
}
export const adsFailure = (errors: AdsError[], requestId?: string) => ({
  "@type": "type.googleapis.com/google.ads.googleads.v25.errors.GoogleAdsFailure",
  errors,
  ...(requestId ? { requestId } : {}),
})
export const rpcError = (status: number, message: string, details: unknown[] = []): Response =>
  Response.json(
    {
      error: {
        code: status,
        message,
        status: statuses[status] ?? "UNKNOWN",
        ...(details.length ? { details } : {}),
      },
    },
    { status },
  )
export class Rejection extends Error {
  constructor(
    readonly status: number,
    readonly detail: AdsError,
  ) {
    super(detail.message)
  }
  response(requestId?: string): Response {
    return rpcError(this.status, this.message, [adsFailure([this.detail], requestId)])
  }
}
export function reject(
  code: string,
  message: string,
  kind = "requestError",
  status = 400,
  field?: string,
): never {
  throw new Rejection(status, {
    errorCode: { [kind]: code },
    message,
    ...(field
      ? { location: { fieldPathElements: field.split(".").map((fieldName) => ({ fieldName })) } }
      : {}),
  })
}
export function invalid(message: string, field?: string): never {
  return reject("INVALID_VALUE", message, "fieldError", 400, field)
}
export function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}
export function present<T>(value: T | null | undefined, message = "Required value is missing"): T {
  if (value === null || value === undefined) throw new Error(message)
  return value
}
export function text(value: unknown, field: string): string {
  if (typeof value !== "string" || !value) invalid(`Missing or invalid ${field}`, field)
  return value
}
export function integer(
  value: unknown,
  field: string,
  min = 0,
  max = Number.MAX_SAFE_INTEGER,
): number {
  const n = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value
  if (typeof n !== "number" || !Number.isSafeInteger(n) || n < min || n > max)
    invalid(`Invalid ${field}`, field)
  return n
}
export function int64(value: unknown, field: string, min = 0n): string {
  if (
    !(typeof value === "string" && /^-?\d+$/.test(value)) &&
    !(typeof value === "number" && Number.isSafeInteger(value))
  )
    invalid(`Invalid int64 ${field}`, field)
  const n = BigInt(value as string | number)
  if (n < min || n > 9223372036854775807n) invalid(`Invalid int64 ${field}`, field)
  return n.toString()
}
export function flag(value: unknown, field: string): boolean {
  if (value === undefined) return false
  if (typeof value !== "boolean") invalid(`Invalid ${field}`, field)
  return value
}
