import type { FetchAPI, FetchHandler } from "./index.js"

const prefixes = new WeakMap<Request, string>()

/** Trusted mount metadata stays on the Request, never in a spoofable HTTP header. */
export const requestBaseUrl = (request: Request): string =>
  new URL(request.url).origin + (prefixes.get(request) ?? "")

export const forwardMountContext = (source: Request, target: Request): Request => {
  const prefix = prefixes.get(source)
  if (prefix !== undefined) prefixes.set(target, prefix)
  return target
}

export type MountedAPI = FetchAPI & {
  readonly prefix: string
  GET: FetchHandler
  POST: FetchHandler
  PUT: FetchHandler
  PATCH: FetchHandler
  DELETE: FetchHandler
  HEAD: FetchHandler
  OPTIONS: FetchHandler
}

/** Embed a native API under an application's origin without owning another listener or state. */
export function mount(
  api: FetchAPI,
  path: string,
  relativePath?: (request: Request) => string,
): MountedAPI {
  const prefix = path.replace(/\/+$/, "")
  if (!/^\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+$/.test(prefix))
    throw new Error("mount prefix must be an absolute path of plain segments")
  const fetch: FetchHandler = async (incoming) => {
    const url = new URL(incoming.url)
    if (url.pathname !== prefix && !url.pathname.startsWith(`${prefix}/`))
      return Response.json({ error: "not_found" }, { status: 404 })
    url.pathname = url.pathname.slice(prefix.length) || "/"
    const request = new Request(url, incoming)
    const publicPrefix = (prefixes.get(incoming) ?? "") + prefix
    prefixes.set(request, publicPrefix)
    const suffix = relativePath?.(request) ?? ""
    const response = await api.fetch(request)
    const local = (value: string) =>
      value.startsWith("/") &&
      !value.startsWith("//") &&
      value !== publicPrefix &&
      !value.startsWith(`${publicPrefix}/`)
        ? `${publicPrefix}${suffix && value !== suffix && !value.startsWith(`${suffix}/`) ? suffix : ""}${value}`
        : value
    const headers = new Headers(response.headers)
    const location = headers.get("location")
    if (location) headers.set("location", local(location))
    const links = headers.get("link")
    if (links)
      headers.set(
        "link",
        links.replace(/<([^>]+)>/g, (_, value: string) => {
          const target = new URL(value, url)
          if (target.origin === url.origin) target.pathname = local(target.pathname)
          return `<${target.href}>`
        }),
      )
    const cookies = headers.getSetCookie()
    if (cookies.length) {
      headers.delete("set-cookie")
      for (const cookie of cookies)
        headers.append(
          "set-cookie",
          cookie.replace(
            /(;\s*Path=)(\/[^;]*)/gi,
            (_, lead: string, value: string) => lead + local(value),
          ),
        )
    }
    if (
      incoming.method !== "HEAD" &&
      response.body &&
      headers.get("content-type")?.split(";")[0] === "text/html"
    ) {
      const html = (await response.text())
        .replace(
          /(\b(?:href|action|src)\s*=\s*["'])(\/[^"']*)(["'])/gi,
          (_, lead: string, value: string, quote: string) => lead + local(value) + quote,
        )
        .replace(
          /(url\(\s*["']?)(\/[^\s)'";]*)(["']?\s*\))/gi,
          (_, lead: string, value: string, end: string) => lead + local(value) + end,
        )
      headers.delete("content-length")
      headers.delete("content-encoding")
      headers.delete("etag")
      return new Response(html, {
        status: response.status,
        statusText: response.statusText,
        headers,
      })
    }
    return new Response(incoming.method === "HEAD" ? null : response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    })
  }
  return {
    prefix,
    fetch,
    GET: fetch,
    POST: fetch,
    PUT: fetch,
    PATCH: fetch,
    DELETE: fetch,
    HEAD: fetch,
    OPTIONS: fetch,
  }
}
