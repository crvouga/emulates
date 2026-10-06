import { expect, test } from "bun:test"
import { ParityError, parity } from "@emulates/parity"
import { fcParameters } from "@emulates/testing"
import { document, OuraAPI, supportedOperationIds } from "./src/index.js"

const baseUrl = "https://oura.test",
  now = () => Date.UTC(2026, 0, 1),
  headers = () => ({ authorization: "Bearer mock_oura_token" })
test(
  "all Oura operations agree between independent instances",
  async () => {
    const reference = new OuraAPI({ now }),
      params = fcParameters(process.env)
    const report = await parity({
      provider: "oura",
      spec: document,
      real: {
        baseUrl,
        allowedHosts: ["oura.test"],
        headers,
        fetch: (request) => reference.fetch(request),
      },
      mock: { baseUrl, headers, create: () => new OuraAPI({ now }) },
      cleanup: () => reference.reset(),
      includeUnsafe: true,
      numRuns: params.numRuns ?? 40,
      maxCommands: 20,
      latencyToleranceMs: 1000,
      ...(params.seed === undefined ? {} : { seed: params.seed }),
      sleep: async () => {},
      log: () => {},
    })
    expect(Object.keys(report.exercised).sort()).toEqual([...supportedOperationIds].sort())
  },
  { timeout: 60_000 },
)
test(
  "incorrect successful lookup is caught",
  async () => {
    const reference = new OuraAPI({ now })
    await expect(
      parity({
        provider: "oura",
        spec: document,
        real: {
          baseUrl,
          allowedHosts: ["oura.test"],
          headers,
          fetch: (request) => reference.fetch(request),
        },
        mock: {
          baseUrl,
          headers,
          create: () => ({ fetch: async () => Response.json({ unexpected: true }) }),
        },
        only: ["ListWorkout"],
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
