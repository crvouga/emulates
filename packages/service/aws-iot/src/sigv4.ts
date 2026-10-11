/**
 * Verification of an AWS Signature Version 4 `Authorization` header, as a service other than
 * Amazon S3 computes it: the path is URI-encoded a second time for the canonical request, and
 * the payload hash is the SHA-256 of the body.
 *
 * https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_sigv-create-signed-request.html
 * The canonical path follows the AWS SDK's signer (`@smithy/signature-v4`, `getCanonicalPath`
 * with `uriEscapePath`), which `iotdata.sdk.test.ts` checks this against.
 */
import { toHex } from "@crvouga/mockingbird-service"

export type SigV4Authorization = {
  accessKeyId: string
  /** `YYYYMMDD`. */
  date: string
  region: string
  service: string
  signedHeaders: string[]
  signature: string
}

const encoder = new TextEncoder()

/** Parse `AWS4-HMAC-SHA256 Credential=…, SignedHeaders=…, Signature=…`. */
export const parseAuthorization = (header: string | null): SigV4Authorization | undefined => {
  if (!header) return undefined
  const match = /^AWS4-HMAC-SHA256\s+(.+)$/.exec(header.trim())
  if (!match?.[1]) return undefined
  const fields = new Map(
    match[1].split(",").map((part) => {
      const [name, ...value] = part.trim().split("=")
      return [name ?? "", value.join("=")] as const
    }),
  )
  const scope = (fields.get("Credential") ?? "").split("/")
  const signedHeaders = (fields.get("SignedHeaders") ?? "").split(";").filter(Boolean)
  const signature = fields.get("Signature") ?? ""
  const [accessKeyId, date, region, service, terminator] = scope
  if (
    scope.length !== 5 ||
    !accessKeyId ||
    !date ||
    !region ||
    !service ||
    terminator !== "aws4_request" ||
    signedHeaders.length === 0 ||
    signature === ""
  ) {
    return undefined
  }
  return { accessKeyId, date, region, service, signedHeaders, signature }
}

/** `UriEncode()`: every byte but the unreserved characters, uppercase hexadecimal. */
const uriEncode = (value: string): string =>
  encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  )

const sha256 = async (data: Uint8Array): Promise<string> =>
  toHex(await crypto.subtle.digest("SHA-256", data as BufferSource))

const hmac = async (key: Uint8Array, message: string): Promise<Uint8Array> => {
  const imported = await crypto.subtle.importKey(
    "raw",
    key as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  )
  return new Uint8Array(await crypto.subtle.sign("HMAC", imported, encoder.encode(message)))
}

/** Why a signature was refused; `undefined` when it verifies. */
export type SigV4Failure =
  | "host_not_signed"
  | "missing_date"
  | "date_scope_mismatch"
  | "payload_hash_mismatch"
  | "signature_mismatch"

/**
 * Recompute the signature of `request` (whose body is `body`) under `secretAccessKey` and
 * compare it with the one `authorization` carries.
 */
export const verifySigV4 = async (
  request: Request,
  body: Uint8Array,
  authorization: SigV4Authorization,
  secretAccessKey: string,
): Promise<SigV4Failure | undefined> => {
  const url = new URL(request.url)
  if (!authorization.signedHeaders.includes("host")) return "host_not_signed"
  const timestamp = request.headers.get("x-amz-date")
  if (!timestamp || !/^\d{8}T\d{6}Z$/.test(timestamp)) return "missing_date"
  if (timestamp.slice(0, 8) !== authorization.date) return "date_scope_mismatch"
  const payloadHash = await sha256(body)
  const declared = request.headers.get("x-amz-content-sha256")
  if (declared !== null && declared !== payloadHash) return "payload_hash_mismatch"

  const canonicalPath = url.pathname
    .replace(/\/+/g, "/")
    .split("/")
    .map((segment) => uriEncode(segment))
    .join("/")
  // Sorted by encoded name, then encoded value.
  const canonicalQuery = [...url.searchParams]
    .map(([name, value]) => [uriEncode(name), uriEncode(value)] as const)
    .sort(([a, x], [b, y]) => (a < b ? -1 : a > b ? 1 : x < y ? -1 : x > y ? 1 : 0))
    .map(([name, value]) => `${name}=${value}`)
    .join("&")
  const canonicalHeaders = authorization.signedHeaders
    .map((name) => {
      const value =
        name === "host" ? (request.headers.get("host") ?? url.host) : request.headers.get(name)
      return `${name}:${(value ?? "").trim().replace(/\s+/g, " ")}\n`
    })
    .join("")
  const canonicalRequest = [
    request.method,
    canonicalPath,
    canonicalQuery,
    canonicalHeaders,
    authorization.signedHeaders.join(";"),
    payloadHash,
  ].join("\n")
  const scope = `${authorization.date}/${authorization.region}/${authorization.service}/aws4_request`
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    timestamp,
    scope,
    await sha256(encoder.encode(canonicalRequest)),
  ].join("\n")
  let key = await hmac(encoder.encode(`AWS4${secretAccessKey}`), authorization.date)
  key = await hmac(key, authorization.region)
  key = await hmac(key, authorization.service)
  key = await hmac(key, "aws4_request")
  const expected = toHex(await hmac(key, stringToSign))
  return expected === authorization.signature.toLowerCase() ? undefined : "signature_mismatch"
}
