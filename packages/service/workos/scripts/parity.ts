import { CredentialError, loadCredentials } from "@emulates/credentials"
import { WorkOSAPI } from "../src/index.js"

let key: string
try {
  const credentials = await loadCredentials(
    { provider: "workos", fields: { WORKOS_API_KEY: "WORKOS_API_KEY" } },
    { env: process.env },
  )
  key = credentials.values.WORKOS_API_KEY
} catch (error) {
  if (error instanceof CredentialError) {
    console.error(`workos parity: ${error.message}`)
    process.exit(2)
  }
  throw error
}
const response = await fetch("https://api.workos.com/user_management/users?limit=1", {
  headers: { authorization: `Bearer ${key}` },
})
if (response.status !== 200) throw new Error(`WorkOS safe list probe failed (${response.status})`)
const actual = (await response.json()) as {
  object?: string
  data?: unknown[]
  list_metadata?: { after?: string | null }
}
const mock = (await (
  await new WorkOSAPI().fetch(
    new Request("http://workos.mock/user_management/users?limit=1", {
      headers: { authorization: "Bearer mock_workos_key" },
    }),
  )
).json()) as typeof actual
for (const body of [actual, mock]) {
  if (
    body.object !== "list" ||
    !Array.isArray(body.data) ||
    body.data.length > 1 ||
    !body.list_metadata ||
    !(body.list_metadata.after === null || typeof body.list_metadata.after === "string")
  )
    throw new Error("WorkOS list shape differs from supported contract")
}
console.log("WorkOS safe list response shape agrees; account data was not compared or printed")
