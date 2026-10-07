import { CredentialError, loadCredentials } from "@crvouga/mockingbird-credentials"

let token: string
try {
  const loaded = await loadCredentials(
    { provider: "whoop", fields: { token: "WHOOP_ACCESS_TOKEN" } },
    { env: process.env },
  )
  token = loaded.values.token as string
} catch (error) {
  if (error instanceof CredentialError) {
    console.error("whoop: missing WHOOP_ACCESS_TOKEN")
    process.exit(2)
  }
  throw error
}
const response = await fetch(
  "https://api.prod.whoop.com/developer/v2/activity/workout?start=2026-01-01T00:00:00Z&end=2026-01-01T00:00:00Z",
  { headers: { authorization: `Bearer ${token}` } },
)
const body = (await response.json()) as { records?: unknown[]; next_token?: unknown }
if (
  response.status !== 200 ||
  !Array.isArray(body.records) ||
  !(body.next_token === undefined || typeof body.next_token === "string")
) {
  console.error(
    `whoop: collection envelope check failed (HTTP ${response.status}); contents withheld`,
  )
  process.exit(1)
}
console.log(
  "whoop: safe collection envelope check passed; payloads withheld; OAuth mutations not exercised",
)
