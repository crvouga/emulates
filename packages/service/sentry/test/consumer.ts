import { DEFAULT_PROJECT } from "../src/index.js"
/** The issue supplies wire surfaces, not application source. This client follows those surfaces. */
export class SentryAssertions {
  constructor(
    readonly fetch: (request: Request) => Promise<Response>,
    readonly base = "http://sentry.fixture",
    readonly namespace?: string,
    readonly adminPrefix = "/__admin",
  ) {}
  async request(
    method: string,
    path: string,
    body?: unknown,
    headers: HeadersInit = {},
  ): Promise<Response> {
    const h = new Headers({
      authorization: "Bearer fixture-rest-token",
      ...Object.fromEntries(new Headers(headers)),
    })
    if (this.namespace) h.set("x-mockingbird-namespace", this.namespace)
    if (body !== undefined && !h.has("content-type")) h.set("content-type", "application/json")
    return this.fetch(
      new Request(`${this.base}${path}`, {
        method,
        headers: h,
        ...(body === undefined
          ? {}
          : {
              body:
                body instanceof Uint8Array
                  ? body.slice()
                  : typeof body === "string"
                    ? body
                    : JSON.stringify(body),
            }),
      }),
    )
  }
  store(data: unknown): Promise<Response> {
    return this.request(
      "POST",
      `/api/1/store/?sentry_key=${DEFAULT_PROJECT.publicKey}&sentry_version=7`,
      data,
    )
  }
  envelope(bytes: Uint8Array): Promise<Response> {
    return this.request("POST", "/api/1/envelope/", bytes, {
      "content-type": "application/x-sentry-envelope",
      "x-sentry-auth": `Sentry sentry_key=${DEFAULT_PROJECT.publicKey}, sentry_version=7`,
    })
  }
  events(query = ""): Promise<Response> {
    return this.request("GET", `/api/0/projects/fixture-org/fixture/events/${query}`)
  }
  issues(query = ""): Promise<Response> {
    return this.request("GET", `/api/0/projects/fixture-org/fixture/issues/${query}`)
  }
  admin(method: string, path: string, body?: unknown): Promise<Response> {
    return this.request(method, `${this.adminPrefix}${path}`, body)
  }
}
export const bytes = (value: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(value)
export const envelope = (
  id: string | undefined,
  items: { type: string; data: unknown; headers?: Record<string, unknown> }[],
): Uint8Array => {
  const chunks = [bytes(JSON.stringify(id ? { event_id: id } : {}))]
  for (const item of items) {
    const payload =
      item.data instanceof Uint8Array ? item.data.slice() : bytes(JSON.stringify(item.data))
    chunks.push(
      bytes(`\n${JSON.stringify({ type: item.type, length: payload.length, ...item.headers })}\n`),
      payload,
    )
  }
  const output = new Uint8Array(chunks.reduce((sum, part) => sum + part.length, 0))
  let offset = 0
  for (const part of chunks) {
    output.set(part, offset)
    offset += part.length
  }
  return output
}
export const eventId = (n: number): string => n.toString(16).padStart(32, "0")
