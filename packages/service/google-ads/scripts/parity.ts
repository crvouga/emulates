import { CredentialError, createRedactor, loadCredentials } from "@emulates/credentials"
import { listOperations } from "@emulates/openapi"
import { parity } from "@emulates/parity"
import { document, GoogleAdsAPI } from "../src/index.js"

let credentials: Awaited<ReturnType<typeof loadCredentials>>
try {
  credentials = await loadCredentials(
    {
      provider: "google-ads",
      fields: {
        GOOGLE_ADS_ACCESS_TOKEN: "GOOGLE_ADS_ACCESS_TOKEN",
        GOOGLE_ADS_CUSTOMER_ID: "GOOGLE_ADS_CUSTOMER_ID",
      },
    },
    { env: process.env },
  )
} catch (e) {
  if (e instanceof CredentialError) {
    console.error(`google-ads parity: sandbox access is unavailable. ${e.message}`)
    process.exit(2)
  }
  throw e
}
const { GOOGLE_ADS_ACCESS_TOKEN: token, GOOGLE_ADS_CUSTOMER_ID: customerId } = credentials.values
// Cold, read-only empty-result query: no campaign, budget, conversion or analytics writes.
const spec = structuredClone(document),
  query = "SELECT campaign.id FROM campaign WHERE campaign.id = 0"
for (const o of listOperations(spec)) {
  if (o.operationId !== "SearchGoogleAds") continue
  o.operation.requestBody = {
    required: true,
    content: { "application/json": { schema: { enum: [{ query }] } } },
  }
  for (const p of o.operation.parameters ?? [])
    if ("schema" in p && p.name === "customerId") p.schema = { type: "string", enum: [customerId] }
}
const auth = () => ({
  authorization: `Bearer ${token}`,
  ...(process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID
    ? { "login-customer-id": process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID }
    : {}),
})
await parity({
  provider: "google-ads",
  spec,
  env: process.env,
  only: ["SearchGoogleAds"],
  includeUnsafe: false,
  invalidProbability: 0,
  real: {
    baseUrl: "https://googleads.googleapis.com",
    allowedHosts: ["googleads.googleapis.com"],
    headers: auth,
    minIntervalMs: 250,
  },
  mock: {
    headers: auth,
    create: () =>
      new GoogleAdsAPI({
        customers: [
          {
            id: customerId,
            descriptiveName: "Fixture oracle account",
            currencyCode: "USD",
            timeZone: "UTC",
          },
        ],
        budgets: [],
        campaigns: [],
        actions: [],
        metrics: [],
        tokens: [{ token }],
      }),
  },
  redact: createRedactor(credentials.secrets),
})
