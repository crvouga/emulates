/** Read-only live parity. Never submit telemetry or mutate real Sentry issues. */
import { CredentialError, createRedactor, loadCredentials } from "@emulates/credentials"
import { parity } from "@emulates/parity"
import { DEFAULT_PROJECT, document, SentryAPI } from "../src/index.js"

let credentials: Awaited<ReturnType<typeof loadCredentials>>
try {
  credentials = await loadCredentials(
    {
      provider: "sentry",
      fields: {
        SENTRY_API_URL: "SENTRY_API_URL",
        SENTRY_AUTH_TOKEN: "SENTRY_AUTH_TOKEN",
        SENTRY_ORGANIZATION_SLUG: "SENTRY_ORGANIZATION_SLUG",
        SENTRY_PROJECT_ID: "SENTRY_PROJECT_ID",
        SENTRY_PROJECT_SLUG: "SENTRY_PROJECT_SLUG",
      },
    },
    { env: process.env },
  )
} catch (error) {
  if (error instanceof CredentialError) {
    console.error(`sentry parity: no sandbox credentials. ${error.message}`)
    process.exit(2)
  }
  throw error
}
const values = credentials.values
const baseUrl = values.SENTRY_API_URL.replace(/\/$/, "")
const auth = { authorization: `Bearer ${values.SENTRY_AUTH_TOKEN}` }
// Reads compare a fixture-empty test project; never clear or mutate an existing vendor project.
const preflight = await fetch(
  `${baseUrl}/api/0/projects/${encodeURIComponent(values.SENTRY_ORGANIZATION_SLUG)}/${encodeURIComponent(values.SENTRY_PROJECT_SLUG)}/events/`,
  { headers: auth },
)
const existing: unknown = await preflight.json()
if (!preflight.ok || !Array.isArray(existing) || existing.length > 0) {
  console.error(
    `sentry parity: requires an accessible empty test project (preflight status ${preflight.status}); no vendor state was modified`,
  )
  process.exit(2)
}
const spec = structuredClone(document)
for (const path of Object.values(spec.paths ?? {})) {
  for (const operation of Object.values(path)) {
    if (!operation || typeof operation !== "object" || !("parameters" in operation)) continue
    for (const parameter of operation.parameters ?? []) {
      if (!("name" in parameter) || !("schema" in parameter) || !parameter.schema) continue
      if (parameter.name === "organization")
        parameter.schema = { type: "string", enum: [values.SENTRY_ORGANIZATION_SLUG] }
      if (parameter.name === "project")
        parameter.schema = { type: "string", enum: [values.SENTRY_PROJECT_ID] }
    }
  }
}
try {
  await parity({
    provider: "sentry",
    spec,
    env: process.env,
    includeUnsafe: false,
    only: ["ListProjectEvents", "ListProjectIssues"],
    real: {
      baseUrl,
      allowedHosts: [new URL(baseUrl).host],
      headers: () => auth,
      minIntervalMs: 250,
    },
    mock: {
      create: () =>
        new SentryAPI({
          projects: [
            {
              ...DEFAULT_PROJECT,
              id: values.SENTRY_PROJECT_ID,
              slug: values.SENTRY_PROJECT_SLUG,
              organization: {
                id: "fixture-org",
                slug: values.SENTRY_ORGANIZATION_SLUG,
                name: "Fixture organization",
              },
            },
          ],
          restTokens: [values.SENTRY_AUTH_TOKEN],
        }),
      headers: () => auth,
    },
    redact: createRedactor(credentials.secrets),
  })
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
}
