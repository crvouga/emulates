import { CredentialError, loadCredentials } from "@emulates/credentials"
import { CheckrAPI } from "../src/index.js"

let key: string
try {
  const credentials = await loadCredentials(
    { provider: "checkr", fields: { CHECKR_API_KEY: "CHECKR_API_KEY" } },
    { env: process.env },
  )
  key = credentials.values.CHECKR_API_KEY
} catch (error) {
  if (error instanceof CredentialError) {
    console.error(`checkr parity: ${error.message}`)
    process.exit(2)
  }
  throw error
}
const response = await fetch("https://api.checkr.com/v1/packages?per_page=1", {
  headers: { authorization: `Basic ${btoa(`${key}:`)}` },
})
if (response.status !== 200) throw new Error(`Checkr safe package read failed (${response.status})`)
const real = (await response.json()) as {
  object?: string
  data?: unknown[]
  next_href?: string | null
}
const mock = (await (
  await new CheckrAPI().fetch(
    new Request("http://checkr.mock/v1/packages?per_page=1", {
      headers: { authorization: `Basic ${btoa("mock_checkr_key:")}` },
    }),
  )
).json()) as typeof real
for (const body of [real, mock])
  if (
    body.object !== "list" ||
    !Array.isArray(body.data) ||
    body.data.length > 1 ||
    !(body.next_href === null || typeof body.next_href === "string")
  )
    throw new Error("Checkr package list shape differs")
console.log(
  "Checkr package list response shape agrees; no candidates, invitations or reports were created",
)
