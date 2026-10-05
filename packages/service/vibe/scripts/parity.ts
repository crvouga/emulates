import { CredentialError, loadCredentials } from "@crvouga/mockingbird-credentials"

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
