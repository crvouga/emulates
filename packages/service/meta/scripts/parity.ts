import { CredentialError, loadCredentials } from "@emulators/credentials"
import { createRuntime } from "../src/index.js"

let credentials: Awaited<ReturnType<typeof loadCredentials>>
try {
  credentials = await loadCredentials(
    {
      provider: "meta",
      fields: {
        META_ACCESS_TOKEN: "META_ACCESS_TOKEN",
        META_AD_ACCOUNT_ID: "META_AD_ACCOUNT_ID",
      },
    },
    { env: process.env },
  )
} catch (error) {
  if (error instanceof CredentialError) {
    console.error(`meta parity: no sandbox credentials. ${error.message}`)
    process.exit(2)
  }
  throw error
}

const token = credentials.values.META_ACCESS_TOKEN as string
const account = credentials.values.META_AD_ACCOUNT_ID as string
const query = new URLSearchParams({
  access_token: token,
  fields: "account_id,date_start,date_stop,impressions,clicks,spend",
  date_preset: "yesterday",
  limit: "1",
})
const live = await fetch(
  `https://graph.facebook.com/v26.0/${encodeURIComponent(account)}/insights?${query}`,
)
const liveBody = (await live.json()) as { data?: unknown[]; error?: { message?: string } }
if (!live.ok || !Array.isArray(liveBody.data)) {
  console.error(
    `meta parity: live Insights probe failed (${live.status}): ${liveBody.error?.message ?? "invalid response"}`,
  )
  process.exit(1)
}

const mock = createRuntime()
const mocked = await mock.fetch(
  new Request("http://meta.test/v26.0/act_emulators/insights?limit=1", {
    headers: { authorization: "Bearer meta_parity" },
  }),
)
const mockBody = (await mocked.json()) as { data?: unknown[]; paging?: unknown }
if (!mocked.ok || !Array.isArray(mockBody.data) || mockBody.paging === undefined) {
  console.error("meta parity: mock Insights response does not have the live response envelope")
  process.exit(1)
}
console.log("meta parity: live and mock Insights envelopes verified")
