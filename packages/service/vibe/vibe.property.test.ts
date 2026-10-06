import { expect, test } from "bun:test"
import { ParityError, parity } from "@emulates/parity"
import { fcParameters } from "@emulates/testing"
import { document, supportedOperationIds, VibeAPI } from "./src/index.js"

const baseUrl = "https://vibe.test",
  now = () => Date.UTC(2026, 0, 1),
  headers = () => ({ authorization: "Bearer mock_vibe_token", "x-vibe-revision": "2026-06-01" })
test(
  "all Vibe operations agree between independent instances",
  async () => {
    const reference = new VibeAPI({ now }),
      params = fcParameters(process.env)
    const report = await parity({
      provider: "vibe",
      spec: document,
      real: {
        baseUrl,
        allowedHosts: ["vibe.test"],
        headers,
        fetch: (request) => reference.fetch(request),
      },
      mock: { baseUrl, headers, create: () => new VibeAPI({ now }) },
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
      supportedOperationIds.filter((id) => id !== "DownloadReport").sort(),
    )
  },
  { timeout: 60_000 },
)
test(
  "incorrect successful lookup is caught",
  async () => {
    const reference = new VibeAPI({ now })
    await expect(
      parity({
        provider: "vibe",
        spec: document,
        real: {
          baseUrl,
          allowedHosts: ["vibe.test"],
          headers,
          fetch: (request) => reference.fetch(request),
        },
        mock: {
          baseUrl,
          headers,
          create: () => ({ fetch: async () => Response.json({ unexpected: true }) }),
        },
        only: ["CreateReport"],
        includeUnsafe: true,
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
