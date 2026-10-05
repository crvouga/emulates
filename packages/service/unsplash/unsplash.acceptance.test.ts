import { expect, test } from "bun:test"
import { createRuntime, DEFAULT_PHOTOS } from "./src/index.js"
import { createServer } from "./src/server.js"
import { client } from "./test/consumer.js"

const sample = DEFAULT_PHOTOS[0]
if (!sample) throw new Error("Missing default photo")
const fixtures = Array.from({ length: 12 }, (_, i) => ({
  ...sample,
  id: `photo-${i}`,
  user: { first_name: "Synthetic", links: { html: "https://example.invalid/author" } },
}))
const setup = () => {
  const runtime = createRuntime({ photos: fixtures })
  const fetchImpl = ((input: RequestInfo | URL, init?: RequestInit) =>
    runtime.fetch(new Request(input, init))) as typeof fetch
  return { runtime, fetchImpl, consumer: client(fetchImpl, "http://unsplash.test") }
}
test("consecutive search pages have stable distinct hits and nullable attribution", async () => {
  const { consumer } = setup()
  const first = await consumer.search("mock"),
    second = await consumer.search("mock", 2)
  expect(first.status).toBe(200)
  const one = await first.json(),
    two = await second.json()
  expect(one.total).toBe(12)
  expect(one.total_pages).toBe(2)
  expect(one.results).toHaveLength(9)
  expect(two.results).toHaveLength(3)
  expect(
    new Set([...one.results, ...two.results].map((photo: { id: string }) => photo.id)).size,
  ).toBe(12)
  expect(one.results[0].alt_description).toBeNull()
  expect(one.results[0].user).not.toHaveProperty("last_name")
  expect(first.headers.get("link")).toContain('rel="next"')
  expect(first.headers.get("link")).not.toContain("mock_unsplash_key")
  expect(await (await consumer.search("mock")).json()).toEqual(one)
})
test("no matches and orientation filtering return genuine empty pages", async () => {
  const { consumer, fetchImpl } = setup()
  expect(await (await consumer.search("absent")).json()).toEqual({
    total: 0,
    total_pages: 0,
    results: [],
  })
  const response = await fetchImpl(
    "http://unsplash.test/search/photos?query=mock&orientation=portrait&client_id=mock_unsplash_key",
  )
  expect((await response.json()).results).toEqual([])
})
test("local image bytes and download location preserve selected namespace and admin prefix", async () => {
  const runtime = createRuntime({ adminPrefix: "/_control/mock", photos: fixtures })
  const fetchImpl = ((input: RequestInfo | URL, init?: RequestInit) =>
    runtime.fetch(new Request(input, init))) as typeof fetch
  const consumer = client(fetchImpl, "http://unsplash.test/_control/mock/ns/isolated")
  const { results } = await (await consumer.search("mock")).json()
  const image = await fetchImpl(results[0].urls.regular)
  expect(image.status).toBe(200)
  expect(image.headers.get("content-type")).toBe("image/png")
  expect(new Uint8Array(await image.arrayBuffer()).slice(0, 4)).toEqual(
    new Uint8Array([137, 80, 78, 71]),
  )
  const download = await fetchImpl(results[0].links.download_location, {
    headers: { authorization: "Client-ID mock_unsplash_key" },
  })
  expect((await download.json()).url).toBe(results[0].urls.regular)
  expect(runtime.instance("isolated").downloads.get("photo-0")?.count).toBe(1)
  expect(runtime.instance().downloads.count()).toBe(0)
  runtime.instance("isolated").photos.delete("photo-0")
  await runtime.reset("isolated")
  expect(runtime.instance("isolated").photos.count()).toBe(12)
  expect(runtime.instance().photos.count()).toBe(12)
})
test("auth, quota, transport faults and journals do not expose credentials", async () => {
  const { runtime, fetchImpl, consumer } = setup()
  expect((await client(fetchImpl, "http://unsplash.test", "wrong").search("mock")).status).toBe(401)
  expect((await fetchImpl("http://unsplash.test/search/photos?query=mock")).status).toBe(401)
  runtime.applyPreset("rate_limited", "default", { count: 1 })
  expect((await consumer.search("mock")).status).toBe(403)
  runtime.applyPreset("connection_drop", "default", { count: 1 })
  await expect(consumer.search("mock")).rejects.toBeInstanceOf(TypeError)
  expect((await consumer.search("mock")).status).toBe(200)
  const journal = await (await fetchImpl("http://unsplash.test/__admin/requests")).text()
  expect(journal).not.toContain("mock_unsplash_key")
})
test("served HTTP search links return locally hosted bytes", async () => {
  const server = await createServer()
  try {
    const { results } = await (await client(fetch, server.url).search("mock")).json()
    const image = await fetch(results[0].urls.regular)
    expect(image.status).toBe(200)
    expect((await image.arrayBuffer()).byteLength).toBeGreaterThan(0)
  } finally {
    await server.close()
  }
})
