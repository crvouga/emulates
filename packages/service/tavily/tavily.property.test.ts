import { expect, test } from "bun:test"
import { ParityError, parity } from "@emulates/parity"
import { fcParameters } from "@emulates/testing"
import { document, supportedOperationIds, TavilyAPI } from "./src/index.js"

const params = fcParameters(process.env)
const run = (divergent = false) => {
  const reference = new TavilyAPI()
  const headers = () => ({ authorization: "Bearer mock_tavily_key" })
  return parity({
    provider: "tavily",
    spec: document,
    real: {
      baseUrl: "http://mock.local",
      allowedHosts: ["mock.local"],
      headers,
      fetch: (r) => reference.fetch(r),
    },
    mock: {
      baseUrl: "http://mock.local",
      headers,
      create: () =>
        divergent
          ? {
              fetch: async () => Response.json({ detail: { error: "divergent" } }, { status: 401 }),
            }
          : new TavilyAPI(),
    },
    cleanup: () => reference.reset(),
    includeUnsafe: true,
    latencyToleranceMs: 1000,
    numRuns: params.numRuns ?? 25,
    maxCommands: 20,
    ...(params.seed === undefined ? {} : { seed: params.seed }),
    sleep: async () => {},
    log: () => {},
  })
}
test("all operations conform and agree across independent instances", async () => {
  const report = await run()
  expect(Object.keys(report.exercised).sort()).toEqual([...supportedOperationIds].sort())
}, 60000)
test("deliberate divergence is detected", async () => {
  await expect(run(true)).rejects.toBeInstanceOf(ParityError)
}, 60000)
