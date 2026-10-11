/**
 * Live parity: the same random walk over the REST API against a real EMQX 5 broker and a fresh
 * emulator, canonicalized and diffed. Point it at a self-hosted broker you own (for example
 * `docker run -p 18083:18083 emqx/emqx:5.8`) with an API key created in its dashboard.
 * Credentials come from the environment (`.env.local` locally, repo secrets in the Parity
 * workflow):
 *
 *   EMQX_API_URL      e.g. http://127.0.0.1:18083
 *   EMQX_API_KEY
 *   EMQX_API_SECRET
 *
 * Both operations change the broker (a publish reaches whoever subscribes, a kick ends a
 * session), so nothing runs without `--include-unsafe`. The MQTT surface is not covered here:
 * `emqx.sdk.test.ts` drives it with the consumer's client library.
 */
import { CredentialError, createRedactor, loadCredentials } from "@crvouga/mockingbird-credentials"
import { parity } from "@crvouga/mockingbird-parity"
import { document, EmqxAPI } from "../src/index.js"

let credentials: Awaited<ReturnType<typeof loadCredentials>>
try {
  credentials = await loadCredentials(
    {
      provider: "emqx",
      fields: {
        EMQX_API_URL: "EMQX_API_URL",
        EMQX_API_KEY: "EMQX_API_KEY",
        EMQX_API_SECRET: "EMQX_API_SECRET",
      },
    },
    { env: process.env },
  )
} catch (error) {
  if (error instanceof CredentialError) {
    console.error(`emqx parity: no broker credentials. ${error.message}`)
    process.exit(2)
  }
  throw error
}

const {
  EMQX_API_URL = "",
  EMQX_API_KEY: key = "",
  EMQX_API_SECRET: secret = "",
} = credentials.values
const baseUrl = EMQX_API_URL.replace(/\/$/, "")
const headers = () => ({ authorization: `Basic ${btoa(`${key}:${secret}`)}` })

try {
  await parity({
    provider: "emqx",
    spec: document,
    env: process.env,
    includeUnsafe: process.argv.includes("--include-unsafe"),
    real: { baseUrl, allowedHosts: [new URL(baseUrl).host], headers, minIntervalMs: 50 },
    mock: { create: () => new EmqxAPI(), headers },
    redact: createRedactor(credentials.secrets),
  })
} catch (error) {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
