import { expect, test } from "bun:test"
import type { OperationObject } from "@emulators/openapi"
import { ParityError, parity } from "@emulators/parity"
import { fcParameters } from "@emulators/testing"
import { document, InfisicalAPI, supportedOperationIds } from "./src/index.js"

const headers = () => ({ authorization: "Bearer fixture-service-token" })
const now = () => 1_700_000_000_000
const params = fcParameters(process.env)
// Bound inputs to the seeded fixture tree without restricting the public contract.
const spec = structuredClone(document)
for (const item of Object.values(spec.paths ?? {}))
  for (const candidate of Object.values(item)) {
    if (!candidate || typeof candidate !== "object" || !("operationId" in candidate)) continue
    const op = candidate as OperationObject
    for (const p of op.parameters ?? []) {
      if (!("schema" in p) || !p.schema) continue
      const choices: Record<string, string[]> = {
        workspaceId: ["fixture-project", "missing-project"],
        workspaceSlug: ["fixture-project"],
        environment: ["dev", "missing"],
        secretPath: ["/", "/app", "/sibling", "/missing"],
        secretName: ["ROOT_VALUE", "APP_VALUE", "NEW_VALUE"],
      }
      const values = choices[p.name]
      if (values) p.schema = { type: "string", enum: values }
    }
    if (op.requestBody && "content" in op.requestBody) {
      const schema = op.requestBody.content?.["application/json"]?.schema
      if (schema && "properties" in schema) {
        const props = schema.properties ?? {}
        if (props.environment) props.environment = { type: "string", enum: ["dev"] }
        if (props.secretPath) props.secretPath = { type: "string", enum: ["/", "/app"] }
        if (props.workspaceId) props.workspaceId = { type: "string", enum: ["fixture-project"] }
        if (props.projectSlug) props.projectSlug = { type: "string", enum: ["fixture-project"] }
        if (props.clientId)
          props.clientId = { type: "string", enum: ["fixture-machine", "missing-machine"] }
        if (props.clientSecret)
          props.clientSecret = {
            type: "string",
            enum: ["fixture-client-secret", "fixture-invalid"],
          }
      }
    }
  }
test(
  "self-parity: independent Infisical instances conform and exercise every enabled operation",
  async () => {
    const reference = new InfisicalAPI({ now })
    const report = await parity({
      provider: "infisical",
      spec,
      includeUnsafe: true,
      real: {
        baseUrl: "https://infisical.fixture",
        allowedHosts: ["infisical.fixture"],
        headers,
        fetch: (r) => reference.fetch(r),
      },
      mock: {
        baseUrl: "https://infisical.fixture",
        headers,
        create: () => new InfisicalAPI({ now }),
      },
      cleanup: () => reference.reset(),
      numRuns: params.numRuns ?? 40,
      maxCommands: 30,
      ...(params.seed === undefined ? {} : { seed: params.seed }),
      sleep: async () => {},
      log: () => {},
      latencyToleranceMs: 1000,
      env: process.env,
    })
    expect(report.walks).toBeGreaterThan(0)
    expect(Object.keys(report.exercised).sort()).toEqual([...supportedOperationIds].sort())
  },
  { timeout: 120_000 },
)
test("a deliberately divergent secret list is detected", async () => {
  const reference = new InfisicalAPI({ now })
  const failure = await parity({
    provider: "infisical",
    spec,
    only: ["ListSecrets"],
    numRuns: 10,
    maxCommands: 3,
    seed: 0,
    invalidProbability: 0,
    real: {
      baseUrl: "https://infisical.fixture",
      allowedHosts: ["infisical.fixture"],
      headers,
      fetch: (r) => reference.fetch(r),
    },
    mock: {
      baseUrl: "https://infisical.fixture",
      headers,
      create: () => ({
        fetch: async () => Response.json({ error: "Deliberately divergent" }, { status: 503 }),
      }),
    },
    sleep: async () => {},
    log: () => {},
  }).then(
    () => undefined,
    (error: unknown) => error,
  )
  expect(failure).toBeInstanceOf(ParityError)
})
