import { expect, test } from "bun:test"
import { createClock } from "@emulates/service"
import { createRuntime, DEFAULT_DATABASES, type OAuthCode } from "./src/index.js"
import { createServer } from "./src/server.js"
import { client } from "./test/consumer.js"

const origin = "http://notion.test",
  databaseId = "00000000-0000-4000-8000-000000000001"
const setup = () => {
  const runtime = createRuntime({ clock: createClock(() => Date.UTC(2026, 0, 1)) })
  const fetchImpl = ((input: RequestInfo | URL, init?: RequestInit) =>
    runtime.fetch(new Request(input, init))) as typeof fetch
  return { runtime, fetchImpl, consumer: client(fetchImpl, origin) }
}
test("legacy database search exposes the authorized id and schema", async () => {
  const { consumer } = setup(),
    result = await (await consumer.search()).json()
  expect(result.type).toBe("page_or_database")
  expect(result.results).toHaveLength(1)
  expect(result.results[0]).toMatchObject({
    object: "database",
    id: databaseId,
    properties: { Name: { type: "title" }, Score: { type: "number" } },
  })
  expect(result.next_cursor).toBeNull()
  expect(result.has_more).toBe(false)
})
test("valid page properties persist under the same database with UUID identity", async () => {
  const { runtime, consumer } = setup()
  const response = await consumer.create(databaseId, {
    Name: { title: [{ text: { content: "Synthetic answer" } }] },
    Score: { number: 8 },
  })
  expect(response.status).toBe(200)
  const page = await response.json()
  expect(page.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/)
  expect(page.parent.database_id).toBe(databaseId)
  expect(runtime.instance().pages.get(page.id)).toMatchObject({
    databaseId,
    properties: { Score: { type: "number", number: 8 } },
  })
})
test("invalid properties and inaccessible/read-only parents never create pages", async () => {
  const { runtime, fetchImpl, consumer } = setup()
  expect((await consumer.create(databaseId, { Score: { number: "wrong" } })).status).toBe(400)
  expect((await consumer.create(databaseId, { Unknown: { number: 1 } })).status).toBe(400)
  expect((await consumer.create("missing", {})).status).toBe(404)
  runtime.instance().grants.insert("read_only", {
    token: "read_only",
    workspaceId: "mock-workspace",
    databaseIds: [databaseId],
    write: false,
  })
  expect((await client(fetchImpl, origin, "read_only").create(databaseId, {})).status).toBe(403)
  expect(runtime.instance().pages.count()).toBe(0)
  expect((await client(fetchImpl, origin, "wrong").search()).status).toBe(401)
})
test("unfiltered search includes untitled pages but title queries do not", async () => {
  const { consumer, fetchImpl } = setup()
  await consumer.create(databaseId, {})
  const search = (query: string) =>
    fetchImpl(`${origin}/v1/search`, {
      method: "POST",
      headers: {
        authorization: "Bearer mock_notion_token",
        "notion-version": "2022-06-28",
        "content-type": "application/json",
      },
      body: JSON.stringify({ filter: { property: "object", value: "page" }, query }),
    })
  expect((await (await search("")).json()).results).toHaveLength(1)
  expect((await (await search("missing")).json()).results).toHaveLength(0)
})
test("pagination, namespaces, reset and journals retain isolation", async () => {
  const { runtime, fetchImpl, consumer } = setup(),
    db = DEFAULT_DATABASES[0]
  if (!db) throw new Error("Missing database fixture")
  runtime.instance().databases.insert("second", { ...db, id: "second" })
  runtime.instance().grants.insert("mock_notion_token", {
    token: "mock_notion_token",
    workspaceId: "mock-workspace",
    databaseIds: [databaseId, "second"],
    write: true,
  })
  const first = await (await consumer.search(1)).json(),
    second = await (await consumer.search(1, first.next_cursor)).json()
  expect(first.has_more).toBe(true)
  expect(second.results[0].id).toBe("second")
  expect(second.has_more).toBe(false)
  const other = client(fetchImpl, `${origin}/__admin/ns/other`)
  expect((await (await other.search()).json()).results).toHaveLength(1)
  await other.create(databaseId, {
    Name: { title: [{ text: { content: "private synthetic body" } }] },
  })
  await runtime.reset("other")
  expect(runtime.instance("other").pages.count()).toBe(0)
  expect(runtime.instance().databases.count()).toBe(2)
  const journal = await (await fetchImpl(`${origin}/__admin/requests`)).text()
  expect(journal).not.toContain("mock_notion_token")
  expect(journal).not.toContain("private synthetic body")
})
test("OAuth code exchange is client-bound, single-use and workspace-scoped", async () => {
  const { runtime, fetchImpl } = setup()
  const code: OAuthCode = {
    code: "mock_code",
    clientId: "mock_client",
    redirectUri: "https://app.example.test/callback",
    used: false,
    grant: {
      token: "mock_oauth_token",
      workspaceId: "mock-workspace",
      databaseIds: [databaseId],
      write: true,
    },
  }
  runtime.instance().codes.insert(code.code, code)
  const exchange = (redirectUri = code.redirectUri) =>
    fetchImpl(`${origin}/v1/oauth/token`, {
      method: "POST",
      headers: {
        authorization: `Basic ${btoa("mock_client:mock_client_secret")}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        grant_type: "authorization_code",
        code: code.code,
        redirect_uri: redirectUri,
      }),
    })
  expect((await exchange("https://other.example.test")).status).toBe(400)
  const response = await exchange()
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({
    access_token: "mock_oauth_token",
    workspace_id: "mock-workspace",
  })
  expect((await exchange()).status).toBe(400)
  expect((await client(fetchImpl, origin, "mock_oauth_token").search()).status).toBe(200)
})
test("served HTTP version errors and scripted quota failures remain vendor-shaped", async () => {
  const server = await createServer()
  try {
    const response = await fetch(`${server.url}/v1/search`, {
      method: "POST",
      headers: { authorization: "Bearer mock_notion_token", "content-type": "application/json" },
      body: "{}",
    })
    expect(await response.json()).toMatchObject({
      object: "error",
      code: "missing_version",
      status: 400,
    })
    server.runtime.applyPreset("rate_limited", "default", { count: 1 })
    const quota = await client(fetch, server.url).search()
    expect(quota.status).toBe(429)
    expect(quota.headers.get("retry-after")).toBe("1")
    expect((await client(fetch, server.url).search()).status).toBe(200)
  } finally {
    await server.close()
  }
})
