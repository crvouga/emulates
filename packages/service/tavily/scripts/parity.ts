import { loadCredentials } from "@emulates/credentials"
import { TavilyAPI } from "../src/index.js"

let apiKey: string
try {
  const credentials = await loadCredentials(
    { provider: "tavily", fields: { apiKey: "TAVILY_API_KEY" } },
    { env: process.env },
  )
  apiKey = credentials.values.apiKey
} catch {
  console.error("Missing TAVILY_API_KEY; no live request sent.")
  process.exit(2)
}
const real = await fetch("https://api.tavily.com/search", {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
  body: "{}",
})
const mock = await new TavilyAPI().fetch(
  new Request("http://mock.local/search", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer mock_tavily_key" },
    body: "{}",
  }),
)
if (real.status !== mock.status)
  throw new Error(`Invalid-input parity status mismatch: ${real.status} vs ${mock.status}`)
console.log("Tavily missing-query validation status agrees; no search or extraction requested.")
