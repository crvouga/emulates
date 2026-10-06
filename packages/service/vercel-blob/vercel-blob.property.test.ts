import { expect, test } from "bun:test"
import type { OperationObject } from "@emulators/openapi"
import { ParityError, parity } from "@emulators/parity"
import { fcParameters } from "@emulators/testing"
import { DEFAULT_TOKEN, document, VercelBlobAPI } from "./src/index.js"

const headers = () => ({
  authorization: `Bearer ${DEFAULT_TOKEN}`,
  "x-vercel-blob-access": "public",
})
const now = () => 1700000000000
const fixtures = [
  { pathname: "seed.txt", bytes: "fixture" },
  { pathname: "folder/a.bin", bytes: [0, 255] },
]
const params = fcParameters(process.env)
const spec = structuredClone(document)
for (const item of Object.values(spec.paths ?? {}))
  for (const candidate of Object.values(item)) {
    if (!candidate || typeof candidate !== "object" || !("operationId" in candidate)) continue
    const op = candidate as OperationObject
    for (const p of op.parameters ?? []) {
      if (!("schema" in p) || !p.schema) continue
      const choices: Record<string, string[]> = {
        url: ["seed.txt", "missing.txt"],
        prefix: ["", "seed", "folder/"],
        cursor: ["", "seed.txt"],
        pathname: ["copy.txt", "copy2.txt"],
        fromUrl: ["seed.txt", "missing.txt"],
      }
      const values = choices[p.name]
      if (values) p.schema = { type: "string", enum: values }
    }
  }
test(
  "self-parity conforms and exercises every JSON operation including head/list dispatch",
  async () => {
    const reference = new VercelBlobAPI({ now, fixtures })
    const report = await parity({
      provider: "vercel-blob",
      spec,
      includeUnsafe: true,
      real: {
        baseUrl: "http://mock.local",
        allowedHosts: ["mock.local"],
        headers,
        fetch: (r) => reference.fetch(r),
      },
      mock: {
        baseUrl: "http://mock.local",
        headers,
        create: () => new VercelBlobAPI({ now, fixtures }),
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
    expect(Object.keys(report.exercised).sort()).toEqual(
      ["CopyBlob", "DeleteBlobs", "ReadBlobStore"].sort(),
    )
  },
  { timeout: 120000 },
)
test("self-parity catches a deliberately divergent store", async () => {
  const reference = new VercelBlobAPI({ now, fixtures })
  const failure = await parity({
    provider: "vercel-blob",
    spec,
    only: ["ReadBlobStore"],
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
      create: () => ({ fetch: async () => Response.json({ error: "diverged" }, { status: 500 }) }),
    },
    sleep: async () => {},
    log: () => {},
  }).then(
    () => undefined,
    (e: unknown) => e,
  )
  expect(failure).toBeInstanceOf(ParityError)
})
