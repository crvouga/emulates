import { expect, test } from "bun:test"
import { type JsonValue, listOperations } from "@emulates/openapi"
import { operationMetadata } from "@emulates/openapi-metadata"
import { ParityError, parity } from "@emulates/parity"
import { fcParameters } from "@emulates/testing"
import { DEFAULT_TOKEN, document, OpenAIAPI } from "./src/index.js"

const headers = () => ({ authorization: `Bearer ${DEFAULT_TOKEN}` })
const now = () => 1700000000000
const params = fcParameters(process.env)
const spec = structuredClone(document)
const bodies: Record<string, JsonValue[]> = {
  CreateChatCompletion: [
    {
      model: "fixture-chat",
      messages: [{ role: "user", content: "fixture prompt" }],
      store: true,
      stream: false,
    },
  ],
  CreateEmbeddings: [
    { model: "fixture-embedding", input: "fixture input", encoding_format: "float" },
    { model: "fixture-embedding", input: ["one", "two"], encoding_format: "base64" },
  ],
  CreateUpload: [
    { filename: "fixture.jsonl", purpose: "batch", mime_type: "application/jsonl", bytes: 0 },
  ],
  CompleteUpload: [{ part_ids: [] }],
}
for (const operation of listOperations(spec)) {
  const values = bodies[operation.operationId ?? ""]
  if (values)
    operation.operation.requestBody = {
      required: true,
      content: { "application/json": { schema: { enum: values } } },
    }
  for (const parameter of operation.operation.parameters ?? []) {
    if (!("schema" in parameter)) continue
    if (parameter.name === "model")
      parameter.schema = { type: "string", enum: ["fixture-chat", "fixture-embedding", "missing"] }
    if (parameter.name === "limit") parameter.schema = { type: "integer", enum: [1, 2, 10] }
  }
}
const enabled = listOperations(document)
  .filter((o) => operationMetadata(o.operation).parity.enabled)
  .map((o) => o.operationId)
  .filter((id): id is string => !!id)
const create = () =>
  new OpenAIAPI({
    now,
    files: [{ id: "file_fixture", filename: "fixture.jsonl", purpose: "batch", bytes: "fixture" }],
  })
test(
  "self-parity covers all enabled JSON operations and validates documented response schemas",
  async () => {
    const reference = create()
    const report = await parity({
      provider: "openai",
      spec,
      includeUnsafe: true,
      real: {
        baseUrl: "http://mock.local",
        allowedHosts: ["mock.local"],
        headers,
        fetch: (r) => reference.fetch(r),
      },
      mock: { baseUrl: "http://mock.local", headers, create },
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
    expect(Object.keys(report.exercised).sort()).toEqual(enabled.sort())
  },
  { timeout: 120000 },
)
test("a deliberately divergent instance is detected for every possible random operation", async () => {
  const reference = create()
  const failure = await parity({
    provider: "openai",
    spec,
    includeUnsafe: true,
    numRuns: 10,
    maxCommands: 3,
    seed: 0,
    invalidProbability: 0,
    real: {
      baseUrl: "http://mock.local",
      allowedHosts: ["mock.local"],
      headers,
      fetch: (r) => reference.fetch(r),
    },
    mock: {
      baseUrl: "http://mock.local",
      headers,
      create: () => ({
        fetch: async () =>
          Response.json(
            {
              error: {
                message: "Deliberately divergent",
                type: "server_error",
                param: null,
                code: "divergent",
              },
            },
            { status: 503 },
          ),
      }),
    },
    sleep: async () => {},
    log: () => {},
  }).then(
    () => undefined,
    (e: unknown) => e,
  )
  expect(failure).toBeInstanceOf(ParityError)
})
