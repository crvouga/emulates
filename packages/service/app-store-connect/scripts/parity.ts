import { CredentialError, loadCredentials } from "@emulates/credentials"

let token: string
try {
  const credentials = await loadCredentials(
    {
      provider: "app-store-connect",
      fields: { APP_STORE_CONNECT_TOKEN: "APP_STORE_CONNECT_TOKEN" },
    },
    { env: process.env },
  )
  token = credentials.values.APP_STORE_CONNECT_TOKEN
} catch (error) {
  if (error instanceof CredentialError) {
    console.error(`app-store-connect parity: ${error.message}`)
    process.exit(2)
  }
  throw error
}
const response = await fetch("https://api.appstoreconnect.apple.com/v1/apps?limit=1", {
  headers: { authorization: `Bearer ${token}` },
})
if (response.status !== 200)
  throw new Error(`Apple safe app-list probe failed (${response.status})`)
const body = (await response.json()) as {
  data?: unknown[]
  links?: { self?: string; next?: string | null }
}
if (
  !Array.isArray(body.data) ||
  body.data.length > 1 ||
  typeof body.links?.self !== "string" ||
  !(
    body.links.next === undefined ||
    body.links.next === null ||
    typeof body.links.next === "string"
  )
)
  throw new Error("Apple app-list response differs from supported JSON:API envelope")
console.log(
  "Apple safe app-list shape matches the supported contract; account data was not printed and no writes were sent",
)
