import { expect, test } from "bun:test"
import { createRuntime, type SearchScript } from "./src/index.js"
import { createServer } from "./src/server.js"
import { call } from "./test/consumer.js"

const scripts: SearchScript[] = [
  {
    query: "fixture",
    answer: "Scripted answer",
    results: [1, 2, 3].map((n) => ({
      title: `Hit ${n}`,
      url: `https://example.test/${n}`,
      content: "Synthetic text",
      score: 1 - n / 10,
    })),
  },
]
const admin = (
  runtime: ReturnType<typeof createRuntime>,
  path: string,
  body?: unknown,
  method = "POST",
) =>
  runtime.fetch(
    new Request(`http://mock.local/__admin/${path}`, {
      method,
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  )
test("scripted query returns ranked hits, caps max_results, answer and empty results", async () => {
  const runtime = createRuntime({ searches: scripts })
  const data = await (
    await call(runtime.fetch, "/search", {
      query: "fixture",
      topic: "general",
      max_results: 2,
      search_depth: "basic",
      include_answer: true,
    })
  ).json()
  expect(data.results.map((r: { title: string }) => r.title)).toEqual(["Hit 1", "Hit 2"])
  expect(data.answer).toBe("Scripted answer")
  expect(data.response_time).toBe(0)
  expect(
    (await (await call(runtime.fetch, "/search", { query: "fixture", max_results: 0 })).json())
      .results,
  ).toEqual([])
  expect(
    (await (await call(runtime.fetch, "/search", { query: "absent" })).json()).results,
  ).toEqual([])
  expect(
    (await (await call(runtime.fetch, "/search", { query: "fixture" })).json()).answer,
  ).toBeUndefined()
})
test("query selector can script topic and time-window variants without crawling", async () => {
  const runtime = createRuntime({
    searches: [
      ...scripts,
      {
        query: "fixture",
        match: { topic: "news", time_range: "week" },
        answer: "Weekly fixture",
        results: [],
      },
    ],
  })
  const data = await (
    await call(runtime.fetch, "/search", {
      query: "fixture",
      topic: "news",
      time_range: "week",
      include_answer: true,
    })
  ).json()
  expect(data.answer).toBe("Weekly fixture")
  expect(data.results).toEqual([])
})
test("batch extraction separates successful content and per-URL failures", async () => {
  const runtime = createRuntime({
    extractions: [
      { url: "https://example.test/a", raw_content: "Synthetic content" },
      { url: "https://example.test/b", error: "Scripted unavailable" },
    ],
  })
  const data = await (
    await call(runtime.fetch, "/extract", {
      urls: ["https://example.test/a", "https://example.test/b"],
    })
  ).json()
  expect(data.results).toEqual([
    { url: "https://example.test/a", raw_content: "Synthetic content", images: [] },
  ])
  expect(data.failed_results).toEqual([
    { url: "https://example.test/b", error: "Scripted unavailable" },
  ])
  expect(
    (await (await call(runtime.fetch, "/extract", { urls: "https://example.test/a" })).json())
      .results,
  ).toHaveLength(1)
})
test("auth, validation, quota and every error/disconnect preset", async () => {
  const runtime = createRuntime()
  expect(
    (await call(runtime.fetch, "/search", { query: "fixture" }, { authorization: "" })).status,
  ).toBe(401)
  expect(
    (
      await call(
        runtime.fetch,
        "/extract",
        { urls: "https://example.test" },
        { authorization: "Bearer invalid_fixture" },
      )
    ).status,
  ).toBe(401)
  expect((await call(runtime.fetch, "/search", { query: "fixture", max_results: 21 })).status).toBe(
    422,
  )
  expect(
    (await call(runtime.fetch, "/search", { query: "fixture", topic: "invalid" })).status,
  ).toBe(400)
  for (const [preset, status] of [
    ["invalid_key", 401],
    ["quota_exceeded", 429],
    ["plan_limit", 432],
    ["payg_limit", 433],
    ["internal_error", 500],
  ] as const) {
    await admin(runtime, "faults", { preset, count: 1 })
    expect((await call(runtime.fetch, "/search", { query: "fixture" })).status).toBe(status)
  }
  await admin(runtime, "faults", { preset: "connection_drop", count: 1 })
  await expect(call(runtime.fetch, "/search", { query: "fixture" })).rejects.toThrow()
  await admin(runtime, "state/apiKeys", {
    id: "limited_fixture",
    value: { key: "limited_fixture", status: "quota" },
  })
  expect(
    (
      await call(
        runtime.fetch,
        "/search",
        { query: "fixture" },
        { authorization: "Bearer limited_fixture" },
      )
    ).status,
  ).toBe(429)
})
test("namespace carriers/reset/Timeline isolate scripts and journal omits query content and keys", async () => {
  const runtime = createRuntime({ searches: scripts })
  runtime.instance("alpha").searches.delete("0")
  expect(
    (
      await (
        await call(
          runtime.fetch,
          "/search",
          { query: "fixture" },
          { "x-emulates-namespace": "alpha" },
        )
      ).json()
    ).results,
  ).toEqual([])
  expect(
    (await (await call(runtime.fetch, "/search", { query: "fixture" })).json()).results,
  ).toHaveLength(3)
  await admin(runtime, "credentials", { credentials: { mock_tavily_key: "alpha" } }, "PUT")
  expect(
    (await (await call(runtime.fetch, "/search", { query: "fixture" })).json()).results,
  ).toEqual([])
  await runtime.instance("alpha").reset()
  const prefix = (r: Request) =>
    runtime.fetch(new Request(r.url.replace("mock.local/", "mock.local/__admin/ns/alpha/"), r))
  expect((await (await call(prefix, "/search", { query: "fixture" })).json()).results).toHaveLength(
    3,
  )
  const checkpoint = await (await admin(runtime, "snapshots")).json()
  runtime.instance().searches.delete("0")
  await admin(runtime, `snapshots/${checkpoint.id}/restore`)
  expect(runtime.instance().searches.list()).toHaveLength(1)
  await call(runtime.fetch, "/search", { query: "PRIVATE_QUERY_MARKER" })
  const journal = await (await admin(runtime, "requests", undefined, "GET")).text()
  expect(journal).not.toContain("PRIVATE_QUERY_MARKER")
  expect(journal).not.toContain("mock_tavily_key")
})
test("served HTTP timeout preset delays the response past a client deadline", async () => {
  const server = await createServer()
  try {
    expect((await fetch(server.url + "/__admin/health")).status).toBe(200)
    await fetch(server.url + "/__admin/faults", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ preset: "timeout", count: 1 }),
    })
    await expect(
      fetch(server.url + "/search", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer mock_tavily_key" },
        body: JSON.stringify({ query: "fixture" }),
        signal: AbortSignal.timeout(20),
      }),
    ).rejects.toThrow()
  } finally {
    await server.close()
  }
})
