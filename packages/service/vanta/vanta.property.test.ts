import { expect, test } from "bun:test"
import { ParityError, parity } from "@emulators/parity"
import { fcParameters } from "@emulators/testing"
import { document, supportedOperationIds, VantaAPI } from "./src/index.js"

const baseUrl = "https://vanta.test",
  now = () => Date.UTC(2026, 0, 1),
  headers = () => ({ authorization: "Bearer mock_vanta_token" })
test(
  "all Vanta operations agree between independent instances",
  async () => {
    const reference = new VantaAPI({ now }),
      params = fcParameters(process.env)
    const report = await parity({
      provider: "vanta",
      spec: document,
      real: {
        baseUrl,
        allowedHosts: ["vanta.test"],
        headers,
        fetch: (request) => reference.fetch(request),
      },
      mock: { baseUrl, headers, create: () => new VantaAPI({ now }) },
      cleanup: () => reference.reset(),
      includeUnsafe: true,
      numRuns: params.numRuns ?? 40,
      maxCommands: 20,
      latencyToleranceMs: 1000,
      ...(params.seed === undefined ? {} : { seed: params.seed }),
      sleep: async () => {},
      log: () => {},
    })
    expect(Object.keys(report.exercised).sort()).toEqual(
      supportedOperationIds.filter((id) => id !== "UploadFileForDocument").sort(),
    )
  },
  { timeout: 60_000 },
)
test(
  "incorrect successful lookup is caught",
  async () => {
    const reference = new VantaAPI({ now })
    await expect(
      parity({
        provider: "vanta",
        spec: document,
        real: {
          baseUrl,
          allowedHosts: ["vanta.test"],
          headers,
          fetch: (request) => reference.fetch(request),
        },
        mock: {
          baseUrl,
          headers,
          create: () => ({ fetch: async () => Response.json({ unexpected: true }) }),
        },
        only: ["ListPeople"],
        numRuns: 5,
        maxCommands: 2,
        latencyToleranceMs: 1000,
        seed: 42,
        sleep: async () => {},
        log: () => {},
      }),
    ).rejects.toBeInstanceOf(ParityError)
  },
  { timeout: 60_000 },
)
