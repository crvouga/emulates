import { CredentialError, loadCredentials } from "@crvouga/mockingbird-credentials"
import { VantaAPI } from "../src/index.js"

if (process.argv.includes("--unauthenticated")) {
  const mock = new VantaAPI()
  for (const token of [undefined, "mock_invalid_token"]) {
    const init = { headers: token ? { authorization: `Bearer ${token}` } : {} }
    const real = await fetch("https://api.vanta.com/v1/people", init),
      local = await mock.fetch(new Request("http://vanta.test/v1/people", init))
    if (
      real.status !== local.status ||
      real.headers.get("content-type") !== local.headers.get("content-type") ||
      (await real.text()) !== (await local.text())
    )
      throw new Error("Vanta unauthenticated parity mismatch")
  }
  console.log("Vanta missing/invalid-token live parity passed; no credentials used.")
  process.exit(0)
}
let credentials: Awaited<ReturnType<typeof loadCredentials>>
try {
  credentials = await loadCredentials(
    { provider: "vanta", fields: { VANTA_ACCESS_TOKEN: "VANTA_ACCESS_TOKEN" } },
    { env: process.env },
  )
} catch (error) {
  if (error instanceof CredentialError) {
    console.error(`vanta parity: ${error.message}`)
    process.exit(2)
  }
  throw error
}
// Read-only metadata check. Never print people or evidence, and never mutate a real tenant.
const response = await fetch("https://api.vanta.com/v1/people?pageSize=1", {
  headers: { authorization: `Bearer ${credentials.values.VANTA_ACCESS_TOKEN}` },
})
const value = await response.json()
if (
  response.status !== 200 ||
  !Array.isArray(value.results?.data) ||
  typeof value.results?.pageInfo?.hasNextPage !== "boolean"
)
  throw new Error(`Vanta list envelope mismatch (HTTP ${response.status})`)
console.log("Vanta read-only pagination envelope verified; no records printed.")
