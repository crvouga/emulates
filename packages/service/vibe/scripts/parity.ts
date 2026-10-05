import { CredentialError, loadCredentials } from "@crvouga/mockingbird-credentials"
import { VibeAPI } from "../src/index.js"

if (process.argv.includes("--unauthenticated")) {
  const mock = new VibeAPI()
  for (const token of [undefined, "mock_invalid_token"]) {
    const init = { headers: token ? { authorization: `Bearer ${token}` } : {} }
    const real = await fetch(
      "https://api.vibe.co/reports/00000000-0000-4000-8000-000000000001",
      init,
    )
    const local = await mock.fetch(
      new Request("http://vibe.test/reports/00000000-0000-4000-8000-000000000001", init),
    )
    const a = await real.json(),
      b = await local.json()
    if (
      real.status !== local.status ||
      real.headers.get("www-authenticate") !== local.headers.get("www-authenticate") ||
      a.error?.type !== b.error?.type ||
      a.error?.message !== b.error?.message ||
      a.error?.status !== b.error?.status
    )
      throw new Error("Unauthenticated Vibe parity mismatch")
  }
  console.log("Vibe missing/invalid-token live parity passed; no credentials used.")
  process.exit(0)
}

let credentials: Awaited<ReturnType<typeof loadCredentials>>
try {
  credentials = await loadCredentials(
    {
      provider: "vibe",
      fields: { VIBE_ACCESS_TOKEN: "VIBE_ACCESS_TOKEN", VIBE_REPORT_ID: "VIBE_REPORT_ID" },
    },
    { env: process.env },
  )
} catch (error) {
  if (error instanceof CredentialError) {
    console.error(`vibe parity: ${error.message}`)
    process.exit(2)
  }
  throw error
}
// Read only: use an existing sandbox report, never create reports or purchase media.
const response = await fetch(
  `https://api.vibe.co/reports/${encodeURIComponent(credentials.values.VIBE_REPORT_ID ?? "")}`,
  {
    headers: {
      authorization: `Bearer ${credentials.values.VIBE_ACCESS_TOKEN}`,
      "x-vibe-revision": "2026-06-01",
    },
  },
)
const value: unknown = await response.json()
if (
  response.status !== 200 ||
  typeof value !== "object" ||
  !value ||
  !("status" in value) ||
  !["CREATED", "PROCESSING", "READY", "FAILED"].includes(String(value.status))
)
  throw new Error(`Vibe report envelope mismatch (HTTP ${response.status})`)
console.log("Vibe read-only report envelope verified; no report content printed.")
