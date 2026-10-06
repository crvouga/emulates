import { CredentialError, loadCredentials } from "@emulators/credentials"

let token: string
try {
  const loaded = await loadCredentials(
    { provider: "airtable", fields: { token: "AIRTABLE_ACCESS_TOKEN" } },
    { env: process.env },
  )
  token = loaded.values.token as string
} catch (error) {
  if (error instanceof CredentialError) {
    console.error("airtable: missing AIRTABLE_ACCESS_TOKEN")
    process.exit(2)
  }
  throw error
}
const response = await fetch("https://api.airtable.com/v0/meta/whoami", {
  headers: { authorization: `Bearer ${token}` },
})
const body = (await response.json()) as { id?: unknown }
if (response.status !== 200 || typeof body.id !== "string") {
  console.error(`airtable: identity envelope failed (HTTP ${response.status}); contents withheld`)
  process.exit(1)
}
console.log(
  "airtable: read-only identity envelope passed; identifiers withheld; no writes or OAuth mutation",
)
