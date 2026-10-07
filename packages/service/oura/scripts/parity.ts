import { CredentialError, loadCredentials } from "@crvouga/mockingbird-credentials"

let token: string
try {
  const loaded = await loadCredentials(
    { provider: "oura", fields: { token: "OURA_ACCESS_TOKEN" } },
    { env: process.env },
  )
  token = loaded.values.token as string
} catch (error) {
  if (error instanceof CredentialError) {
    console.error("oura: missing OURA_ACCESS_TOKEN")
    process.exit(2)
  }
  throw error
}
const response = await fetch(
  "https://api.ouraring.com/v2/usercollection/workout?start_date=2026-01-01&end_date=2026-01-01",
  { headers: { authorization: `Bearer ${token}` } },
)
const body = (await response.json()) as { data?: unknown[]; next_token?: unknown }
if (
  response.status !== 200 ||
  !Array.isArray(body.data) ||
  !(body.next_token === null || typeof body.next_token === "string")
) {
  console.error(
    `oura: collection envelope check failed (HTTP ${response.status}); contents withheld`,
  )
  process.exit(1)
}
console.log(
  "oura: safe collection envelope check passed; payloads withheld; OAuth mutations not exercised",
)
