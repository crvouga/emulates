import { CredentialError, loadCredentials } from "@crvouga/mockingbird-credentials"
import { UnsplashAPI } from "../src/index.js"

let key: string
try {
  const credentials = await loadCredentials(
    { provider: "unsplash", fields: { key: "UNSPLASH_ACCESS_KEY" } },
    { env: process.env },
  )
  key = credentials.values.key as string
} catch (error) {
  if (error instanceof CredentialError) {
    console.error("unsplash: missing UNSPLASH_ACCESS_KEY")
    process.exit(2)
  }
  throw error
}
// Only metadata search: never fetch real images or register downloads.
const path =
  "/search/photos?query=mockingbird-fixture-nonexistent-example-invalid-8f47536d&per_page=1"
const live = await fetch(`https://api.unsplash.com${path}`, {
  headers: { authorization: `Client-ID ${key}`, "accept-version": "v1" },
})
const mock = await new UnsplashAPI({ photos: [] }).fetch(
  new Request(`http://unsplash.test${path}`, {
    headers: { authorization: "Client-ID mock_unsplash_key" },
  }),
)
const actual = (await live.json()) as { total?: number; total_pages?: number; results?: unknown[] }
const expected = (await mock.json()) as { total: number; total_pages: number }
if (
  live.status !== 200 ||
  actual.total !== expected.total ||
  actual.total_pages !== expected.total_pages ||
  actual.results?.length !== 0
) {
  console.error(
    `unsplash: empty-search probe differs (status ${live.status}); response and credentials withheld`,
  )
  process.exit(1)
}
console.log("unsplash: empty-search envelope matches; ranking and image delivery are fixture-only")
