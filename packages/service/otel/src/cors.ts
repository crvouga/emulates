/**
 * Browser CORS for the receiver, as the OpenTelemetry Collector answers it (`confighttp`'s
 * `cors:` block over rs/cors): CORS sits in front of authentication, so a preflight needs no
 * credentials and a refused export still carries the headers. A refused preflight is a 204
 * without the `Access-Control-Allow-*` headers; that absence is what fails it in the browser.
 */
import type { CorsSettings } from "./state.js"

const DEFAULT_METHODS = ["GET", "POST", "HEAD"]
const DEFAULT_HEADERS = ["accept", "content-type", "x-requested-with"]

/** Like the Collector, CORS is off until at least one origin is allowed. */
export const corsEnabled = (cors: CorsSettings): boolean => cors.allowedOrigins.length > 0

/** `OPTIONS` naming the method it asks for; any other `OPTIONS` is an ordinary request. */
export const isPreflight = (request: Request): boolean =>
  request.method === "OPTIONS" && request.headers.has("access-control-request-method")

/** Origins compare case-insensitively; a pattern holds at most one `*`, matching any run. */
const originAllowed = (cors: CorsSettings, origin: string): boolean => {
  const candidate = origin.toLowerCase()
  return cors.allowedOrigins.some((allowed) => {
    const pattern = allowed.toLowerCase()
    const star = pattern.indexOf("*")
    if (star < 0) return pattern === candidate
    const prefix = pattern.slice(0, star)
    const suffix = pattern.slice(star + 1)
    return (
      candidate.length >= prefix.length + suffix.length &&
      candidate.startsWith(prefix) &&
      candidate.endsWith(suffix)
    )
  })
}

const allowOrigin = (cors: CorsSettings, origin: string): string =>
  cors.allowedOrigins.includes("*") ? "*" : origin

const methodAllowed = (cors: CorsSettings, method: string): boolean => {
  if (method === "OPTIONS") return true
  const methods = cors.allowedMethods?.length ? cors.allowedMethods : DEFAULT_METHODS
  return methods.some((allowed) => allowed.toUpperCase() === method)
}

/** Every name in `Access-Control-Request-Headers` must be allowed; an absent header asks for none. */
const headersAllowed = (cors: CorsSettings, requested: string | null): boolean => {
  if (requested === null) return true
  const allowed = cors.allowedHeaders?.length ? cors.allowedHeaders : DEFAULT_HEADERS
  if (allowed.includes("*")) return true
  const names = new Set(allowed.map((name) => name.toLowerCase()))
  return requested
    .split(",")
    .map((name) => name.trim().toLowerCase())
    .every((name) => name === "" || names.has(name))
}

/** The answer to a preflight: always 204, allowing the request only when all three checks pass. */
export const preflightResponse = (request: Request, cors: CorsSettings): Response => {
  const headers = new Headers({
    vary: "Origin, Access-Control-Request-Method, Access-Control-Request-Headers",
  })
  const origin = request.headers.get("origin")
  const method = request.headers.get("access-control-request-method") ?? ""
  const requested = request.headers.get("access-control-request-headers")
  if (
    origin &&
    originAllowed(cors, origin) &&
    methodAllowed(cors, method) &&
    headersAllowed(cors, requested)
  ) {
    headers.set("access-control-allow-origin", allowOrigin(cors, origin))
    headers.set("access-control-allow-methods", method)
    if (requested) headers.set("access-control-allow-headers", requested)
    headers.set("access-control-allow-credentials", "true")
    if (cors.maxAge) headers.set("access-control-max-age", String(Math.max(0, cors.maxAge)))
  }
  return new Response(null, { status: 204, headers })
}

/** Add the actual-request headers to a receiver response, whatever its status. */
export const applyCors = (request: Request, response: Response, cors: CorsSettings): void => {
  response.headers.append("vary", "Origin")
  const origin = request.headers.get("origin")
  if (!origin || !originAllowed(cors, origin) || !methodAllowed(cors, request.method)) return
  response.headers.set("access-control-allow-origin", allowOrigin(cors, origin))
  if (cors.exposedHeaders?.length) {
    response.headers.set("access-control-expose-headers", cors.exposedHeaders.join(", "))
  }
  response.headers.set("access-control-allow-credentials", "true")
}
