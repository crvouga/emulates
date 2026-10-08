import { expect, test } from "bun:test"
import { mount, requestBaseUrl } from "./src/index.js"

test("mount keeps Fetch bodies, signals and streamed binary responses intact", async () => {
  const stopped = new AbortController()
  const data = new Uint8Array([0, 255, 13, 10])
  const handler = mount(
    {
      async fetch(request) {
        expect(request.url).toBe("https://app.example.test/files?q=1")
        expect(requestBaseUrl(request)).toBe("https://app.example.test/api/mock")
        expect(request.signal.aborted).toBe(true)
        expect(new Uint8Array(await request.arrayBuffer())).toEqual(data)
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(data)
              controller.close()
            },
          }),
          { headers: { "content-type": "application/octet-stream" } },
        )
      },
    },
    "/api/mock/",
  )
  stopped.abort()
  const response = await handler.POST(
    new Request("https://app.example.test/api/mock/files?q=1", {
      method: "POST",
      body: data,
      signal: stopped.signal,
    }),
  )
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(data)
  expect(
    (await handler.GET(new Request("https://app.example.test/api/mock-other/files"))).status,
  ).toBe(404)
})

test("mount rewrites local UI links, redirects, pagination and cookies without rewriting external callbacks", async () => {
  const handler = mount(
    {
      async fetch() {
        const headers = new Headers({
          "content-type": "text/html",
          "content-length": "1234",
          etag: "stale",
          location: "/next?x=1",
          link: '<https://app.example.test/items?page=2>; rel="next", <https://elsewhere.example.test/>; rel="help"',
        })
        headers.append("set-cookie", "one=1; Path=/; HttpOnly")
        headers.append("set-cookie", "two=2; Path=/oauth; SameSite=Lax")
        return new Response(
          '<form action="/oauth"><a href="//elsewhere.example.test/x">external</a><a href="https://app.example.test/callback">callback</a><img src="/icon"><style>x{background:url(/icon)}</style></form>',
          { headers },
        )
      },
    },
    "/mock/google",
  )
  const response = await handler.GET(new Request("https://app.example.test/mock/google"))
  expect(response.headers.get("location")).toBe("/mock/google/next?x=1")
  expect(response.headers.get("link")).toContain(
    "https://app.example.test/mock/google/items?page=2",
  )
  expect(response.headers.get("link")).toContain("https://elsewhere.example.test/")
  expect(response.headers.getSetCookie()).toEqual([
    "one=1; Path=/mock/google/; HttpOnly",
    "two=2; Path=/mock/google/oauth; SameSite=Lax",
  ])
  expect(response.headers.has("content-length")).toBe(false)
  expect(response.headers.has("etag")).toBe(false)
  const html = await response.text()
  expect(html).toContain('action="/mock/google/oauth"')
  expect(html).toContain('src="/mock/google/icon"')
  expect(html).toContain("url(/mock/google/icon)")
  expect(html).toContain('href="//elsewhere.example.test/x"')
  expect(html).toContain('href="https://app.example.test/callback"')
})

test("mounted HEAD has no body and custom OPTIONS is forwarded", async () => {
  const handler = mount(
    {
      async fetch(request) {
        return new Response(request.method, { status: request.method === "OPTIONS" ? 202 : 200 })
      },
    },
    "/mock",
  )
  expect(
    await (
      await handler.HEAD(new Request("https://app.example.test/mock/", { method: "HEAD" }))
    ).text(),
  ).toBe("")
  expect(
    (await handler.OPTIONS(new Request("https://app.example.test/mock/", { method: "OPTIONS" })))
      .status,
  ).toBe(202)
  for (const bad of ["/", "//host/path", "relative", "/a/../b", "/a?query", "/a#fragment"])
    expect(() => mount({ fetch: async () => new Response() }, bad)).toThrow()
})
