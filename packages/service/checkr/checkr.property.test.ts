import { expect, test } from "bun:test"
import { ParityError, parity } from "@emulators/parity"
import { fcParameters } from "@emulators/testing"
import { CheckrAPI, document, supportedOperationIds } from "./src/index.js"

const baseUrl = "https://checkr.mock"
const headers = () => ({ authorization: `Basic ${btoa("mock_checkr_key:")}` })
const now = () => 1_800_000_000_000
test("independent walks cover all operations and match the contract", async () => {
  const reference = new CheckrAPI({ now })
  const report = await parity({
    provider: "checkr",
    spec: document,
    real: {
      baseUrl,
      allowedHosts: ["checkr.mock"],
      headers,
      fetch: (request) => reference.fetch(request),
    },
    mock: { baseUrl, headers, create: () => new CheckrAPI({ now }) },
    cleanup: () => reference.reset(),
    includeUnsafe: true,
    ...fcParameters(process.env),
    numRuns: 40,
    maxCommands: 30,
    latencyToleranceMs: 1000,
    sleep: async () => {},
    log: () => {},
  })
  expect(Object.keys(report.exercised).sort()).toEqual([...supportedOperationIds].sort())
}, 30_000)
test("deliberate list divergence is caught", async () => {
  const reference = new CheckrAPI({ now })
  await expect(
    parity({
      provider: "checkr",
      spec: document,
      real: {
        baseUrl,
        allowedHosts: ["checkr.mock"],
        headers,
        fetch: (request) => reference.fetch(request),
      },
      mock: {
        baseUrl,
        headers,
        create: () => ({
          fetch: async () => Response.json({ error: "deliberate divergence" }, { status: 503 }),
        }),
      },
      only: ["ListPackages"],
      numRuns: 5,
      maxCommands: 3,
      latencyToleranceMs: 1000,
      sleep: async () => {},
      log: () => {},
    }),
  ).rejects.toBeInstanceOf(ParityError)
})
