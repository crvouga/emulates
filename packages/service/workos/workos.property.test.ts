import { expect, test } from "bun:test"
import { ParityError, parity } from "@emulators/parity"
import { fcParameters } from "@emulators/testing"
import { document, WorkOSAPI } from "./src/index.js"

const baseUrl = "https://mock.workos.local"
const headers = () => ({ authorization: "Bearer mock_workos_key" })
const now = () => 1_800_000_000_000
test("independent random walks agree and cover every parity-enabled operation", async () => {
  const reference = new WorkOSAPI({ now })
  const report = await parity({
    provider: "workos",
    spec: document,
    real: {
      baseUrl,
      allowedHosts: ["mock.workos.local"],
      headers,
      fetch: (r) => reference.fetch(r),
    },
    mock: { baseUrl, headers, create: () => new WorkOSAPI({ now }) },
    cleanup: () => reference.reset(),
    includeUnsafe: true,
    ...fcParameters(process.env),
    numRuns: 40,
    maxCommands: 15,
    latencyToleranceMs: 1_000,
    sleep: async () => {},
    log: () => {},
  })
  expect(Object.keys(report.exercised).sort()).toEqual(["Authenticate", "GetJwks", "ListUsers"])
}, 30_000)
test("a deliberately divergent list is detected", async () => {
  const reference = new WorkOSAPI({ now })
  await expect(
    parity({
      provider: "workos",
      spec: document,
      real: {
        baseUrl,
        allowedHosts: ["mock.workos.local"],
        headers,
        fetch: (r) => reference.fetch(r),
      },
      mock: {
        baseUrl,
        headers,
        create: () => ({
          fetch: async () =>
            Response.json({
              object: "list",
              data: [],
              list_metadata: { before: null, after: null },
            }),
        }),
      },
      only: ["ListUsers"],
      numRuns: 10,
      maxCommands: 3,
      invalidProbability: 0,
      sleep: async () => {},
      log: () => {},
    }),
  ).rejects.toBeInstanceOf(ParityError)
})
