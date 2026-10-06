import { expect, test } from "bun:test"
import { ParityError, parity } from "@emulates/parity"
import { fcParameters } from "@emulates/testing"
import { document, ECSAPI, supportedOperationIds } from "./src/index.js"

const params = fcParameters(process.env)
const run = (divergent = false) => {
  const reference = new ECSAPI()
  return parity({
    provider: "ecs",
    spec: document,
    real: {
      baseUrl: "http://mock.local",
      allowedHosts: ["mock.local"],
      fetch: (request) => reference.fetch(request),
    },
    mock: {
      baseUrl: "http://mock.local",
      create: () =>
        divergent
          ? {
              fetch: async () =>
                Response.json(
                  { tasks: [], failures: [{ reason: "divergent" }] },
                  { headers: { "content-type": "application/x-amz-json-1.1" } },
                ),
            }
          : new ECSAPI(),
    },
    cleanup: () => reference.reset(),
    includeUnsafe: true,
    latencyToleranceMs: 1000,
    numRuns: params.numRuns ?? 20,
    maxCommands: 15,
    ...(params.seed === undefined ? {} : { seed: params.seed }),
    sleep: async () => {},
    log: () => {},
  })
}
test("all contract operations self-parity and response validation", async () => {
  const report = await run()
  expect(Object.keys(report.exercised).sort()).toEqual([...supportedOperationIds].sort())
}, 60000)
test("deliberate divergence is caught", async () => {
  await expect(run(true)).rejects.toBeInstanceOf(ParityError)
}, 60000)
