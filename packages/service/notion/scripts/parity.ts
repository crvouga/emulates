import { CredentialError, loadCredentials } from "@emulates/credentials"
import { NotionAPI } from "../src/index.js"

let key: string
try {
  const credentials = await loadCredentials(
    { provider: "notion", fields: { key: "NOTION_API_KEY" } },
    { env: process.env },
  )
  key = credentials.values.key as string
} catch (error) {
  if (error instanceof CredentialError) {
    console.error("notion: missing NOTION_API_KEY")
    process.exit(2)
  }
  throw error
}
const body = JSON.stringify({
  query: "emulates-fixture-nonexistent-example-invalid-8f47536d",
  page_size: 1,
  filter: { property: "object", value: "database" },
})
const request = (token: string): RequestInit => ({
  method: "POST",
  headers: {
    authorization: `Bearer ${token}`,
    "notion-version": "2022-06-28",
    "content-type": "application/json",
  },
  body,
})
const live = await fetch("https://api.notion.com/v1/search", request(key))
const expected = await new NotionAPI().fetch(
  new Request("http://notion.test/v1/search", request("mock_notion_token")),
)
const actual = (await live.json()) as {
  type?: string
  object?: string
  results?: unknown[]
  has_more?: boolean
  next_cursor?: string | null
}
const mock = (await expected.json()) as typeof actual
if (
  live.status !== expected.status ||
  actual.object !== mock.object ||
  actual.type !== mock.type ||
  actual.results?.length !== 0 ||
  actual.has_more !== false ||
  actual.next_cursor !== null
) {
  console.error(
    `notion: pinned-version empty search differs (HTTP ${live.status}); response and credentials withheld`,
  )
  process.exit(1)
}
console.log("notion: pinned-version empty search envelope matches; OAuth/writes not tested live")
