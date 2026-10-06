import { CredentialError, loadCredentials } from "@emulates/credentials"
import { BrevoAPI } from "../src/index.js"

let key: string
try {
  const credentials = await loadCredentials(
    { provider: "brevo", fields: { key: "BREVO_API_KEY" } },
    { env: process.env },
  )
  key = credentials.values.key as string
} catch (error) {
  if (error instanceof CredentialError) {
    console.error("brevo: missing BREVO_API_KEY")
    process.exit(2)
  }
  throw error
}
// Only a nonexistent synthetic address is queried; no contacts are created or changed.
const path = "/v3/contacts/emulates-parity-nonexistent%40example.invalid?identifierType=email_id"
const live = await fetch(`https://api.brevo.com${path}`, { headers: { "api-key": key } })
const mock = await new BrevoAPI().fetch(
  new Request(`http://brevo.test${path}`, { headers: { "api-key": "mock_brevo_key" } }),
)
const body = (await live.json()) as { code?: string }
const expected = (await mock.json()) as { code?: string }
if (live.status !== 404 || live.status !== mock.status || body.code !== expected.code) {
  console.error(
    `brevo: absent-contact probe differs (live status ${live.status}); response and credentials withheld`,
  )
  process.exit(1)
}
console.log("brevo: absent-contact status/code match; mutating operations not tested live")
