import { CredentialError, createRedactor, loadCredentials } from "@crvouga/mockingbird-credentials"
import type { OperationObject } from "@crvouga/mockingbird-openapi"
import { parity } from "@crvouga/mockingbird-parity"
import { document, VercelBlobAPI } from "../src/index.js"

let credentials: Awaited<ReturnType<typeof loadCredentials>>
try {
  credentials = await loadCredentials(
    {
      provider: "vercel-blob",
      fields: {
        VERCEL_BLOB_API_URL: "VERCEL_BLOB_API_URL",
        VERCEL_BLOB_READ_WRITE_TOKEN: "VERCEL_BLOB_READ_WRITE_TOKEN",
      },
    },
    { env: process.env },
  )
} catch (e) {
  if (e instanceof CredentialError) {
    console.error(`vercel-blob parity: no sandbox credentials. ${e.message}`)
    process.exit(2)
  }
  throw e
}
const values = credentials.values
const apiUrl = new URL(values.VERCEL_BLOB_API_URL)
const auth = { authorization: `Bearer ${values.VERCEL_BLOB_READ_WRITE_TOKEN}` }
const preflight = await fetch(apiUrl, { headers: auth })
const data = (await preflight.json()) as { blobs?: unknown[]; hasMore?: boolean }
if (!preflight.ok || !Array.isArray(data.blobs) || data.blobs.length || data.hasMore) {
  console.error(
    `vercel-blob parity: requires an accessible empty test store (preflight status ${preflight.status}); no vendor state was modified`,
  )
  process.exit(2)
}
// Read-only: never fetch public object content or modify the configured store.
const spec = structuredClone(document)
const op = spec.paths?.["/api/blob"]?.get as OperationObject
op.parameters = (op.parameters ?? []).filter(
  (p) => !("name" in p) || !["url", "cursor"].includes(p.name),
)
for (const p of op.parameters ?? []) {
  if (!("schema" in p)) continue
  if (p.name === "prefix") p.schema = { type: "string", enum: ["fixture-absent/"] }
}
// The SDK API override may include a prefix; keep the canonical operation path for generation.
const realFetch = (request: Request) => {
  const source = new URL(request.url)
  const destination = new URL(apiUrl)
  destination.search = source.search
  return fetch(new Request(destination, request))
}
await parity({
  provider: "vercel-blob",
  spec,
  only: ["ReadBlobStore"],
  invalidProbability: 0,
  includeUnsafe: false,
  env: process.env,
  real: {
    baseUrl: apiUrl.origin,
    allowedHosts: [apiUrl.host],
    headers: () => auth,
    fetch: realFetch,
    minIntervalMs: 250,
  },
  mock: {
    headers: () => auth,
    create: () =>
      new VercelBlobAPI({ tokens: { [values.VERCEL_BLOB_READ_WRITE_TOKEN]: "fixture" } }),
  },
  redact: createRedactor(credentials.secrets),
})
