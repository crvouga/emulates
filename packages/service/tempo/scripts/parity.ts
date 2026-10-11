/**
 * Live parity: the same random walk against a real Tempo and a fresh emulator, canonicalized
 * and diffed. Credentials come from the environment (`.env.local` locally, repo secrets in the
 * Parity workflow):
 *
 *   TEMPO_BASE_URL     the query origin, e.g. http://localhost:3200 or
 *                      https://tempo-<zone>.grafana.net/tempo (a disposable tenant, never prod)
 *   TEMPO_BASIC_AUTH   base64 "user:token" (Grafana Cloud: instance id and access token);
 *                      for a local Tempo without a gateway, any placeholder value
 *
 * Only the read-only query routes run (search, trace by id, tag names). `POST /v1/traces`
 * writes telemetry into the real tenant, so it is never walked live.
 */
import { CredentialError, createRedactor, loadCredentials } from "@crvouga/mockingbird-credentials"
import { parity } from "@crvouga/mockingbird-parity"
import { document, TempoAPI } from "../src/index.js"

let credentials: Awaited<ReturnType<typeof loadCredentials>>
try {
  credentials = await loadCredentials(
    {
      provider: "tempo",
      fields: {
        TEMPO_BASE_URL: "TEMPO_BASE_URL",
        TEMPO_BASIC_AUTH: "TEMPO_BASIC_AUTH",
      },
    },
    { env: process.env },
  )
} catch (error) {
  if (error instanceof CredentialError) {
    console.error(`tempo parity: no Tempo credentials. ${error.message}`)
    process.exit(2)
  }
  throw error
}

const baseUrl = credentials.values.TEMPO_BASE_URL.replace(/\/$/, "")
const auth = credentials.values.TEMPO_BASIC_AUTH
try {
  await parity({
    provider: "tempo",
    spec: document,
    env: process.env,
    only: ["Search", "GetTrace", "SearchTagsV2"],
    real: {
      baseUrl,
      allowedHosts: [new URL(baseUrl).host],
      headers: () => ({ authorization: `Basic ${auth}` }),
      minIntervalMs: 250,
    },
    mock: {
      create: () => new TempoAPI(),
    },
    redact: createRedactor([...credentials.secrets, auth]),
  })
} catch (error) {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
