import { CredentialError, createRedactor, loadCredentials } from "@emulators/credentials"
import type { OperationObject } from "@emulators/openapi"
import { parity } from "@emulators/parity"
import { document, InfisicalAPI, normalizePath, type ProjectTree } from "../src/index.js"

let credentials: Awaited<ReturnType<typeof loadCredentials>>
try {
  credentials = await loadCredentials(
    {
      provider: "infisical",
      fields: {
        INFISICAL_API_URL: "INFISICAL_API_URL",
        INFISICAL_TOKEN: "INFISICAL_TOKEN",
        INFISICAL_PROJECT_ID: "INFISICAL_PROJECT_ID",
        INFISICAL_ENVIRONMENT: "INFISICAL_ENVIRONMENT",
        INFISICAL_SECRET_PATH: "INFISICAL_SECRET_PATH",
      },
    },
    { env: process.env },
  )
} catch (error) {
  if (error instanceof CredentialError) {
    console.error(`infisical parity: no sandbox credentials. ${error.message}`)
    process.exit(2)
  }
  throw error
}
const values = credentials.values
const baseUrl = values.INFISICAL_API_URL.replace(/\/$/, "")
const path = normalizePath(values.INFISICAL_SECRET_PATH)
const auth = { authorization: `Bearer ${values.INFISICAL_TOKEN}` }
const query = new URLSearchParams({
  workspaceId: values.INFISICAL_PROJECT_ID,
  environment: values.INFISICAL_ENVIRONMENT,
  secretPath: path,
  viewSecretValue: "false",
  recursive: "true",
  include_imports: "true",
})
const preflight = await fetch(`${baseUrl}/api/v3/secrets/raw?${query}`, { headers: auth })
const result: unknown = await preflight.json()
const data = result as { secrets?: unknown[]; imports?: { secrets?: unknown[] }[] }
if (
  !preflight.ok ||
  !Array.isArray(data.secrets) ||
  data.secrets.length ||
  data.imports?.some((i) => !Array.isArray(i.secrets) || i.secrets.length)
) {
  console.error(
    `infisical parity: requires an accessible empty test folder (preflight status ${preflight.status}); no vendor state was modified`,
  )
  process.exit(2)
}
const tree: ProjectTree = {
  organization: { id: "fixture-org", slug: "fixture-org", name: "Fixture organization" },
  project: {
    id: values.INFISICAL_PROJECT_ID,
    slug: values.INFISICAL_PROJECT_ID,
    name: "Fixture project",
  },
  environments: [{ slug: values.INFISICAL_ENVIRONMENT, folders: [{ path }] }],
  serviceTokens: [
    {
      id: "fixture-live-token",
      token: values.INFISICAL_TOKEN,
      grants: [
        {
          projectId: values.INFISICAL_PROJECT_ID,
          environment: values.INFISICAL_ENVIRONMENT,
          path,
          recursive: true,
        },
      ],
    },
  ],
}
const spec = structuredClone(document)
const operation = spec.paths?.["/api/v3/secrets/raw"]?.get as OperationObject
for (const param of operation.parameters ?? []) {
  if (!("name" in param) || !("schema" in param)) continue
  const choices: Record<string, string[]> = {
    workspaceId: [values.INFISICAL_PROJECT_ID],
    workspaceSlug: [values.INFISICAL_PROJECT_ID],
    environment: [values.INFISICAL_ENVIRONMENT],
    secretPath: [path],
    tagSlugs: ["fixture-absent-tag"],
  }
  const choicesForParameter = choices[param.name]
  if (choicesForParameter) param.schema = { type: "string", enum: choicesForParameter }
}
// Do not send a guessed project slug; the caller supplies the authoritative ID.
operation.parameters = (operation.parameters ?? []).filter(
  (p) => !("name" in p) || p.name !== "workspaceSlug",
)
await parity({
  provider: "infisical",
  spec,
  env: process.env,
  only: ["ListSecrets"],
  invalidProbability: 0,
  includeUnsafe: false,
  real: { baseUrl, allowedHosts: [new URL(baseUrl).host], headers: () => auth, minIntervalMs: 250 },
  mock: { headers: () => auth, create: () => new InfisicalAPI({ trees: [tree] }) },
  redact: createRedactor(credentials.secrets),
})
