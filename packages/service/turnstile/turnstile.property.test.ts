import { expect, test } from "bun:test"
import { ParityError, parity } from "@crvouga/mockingbird-parity"
import { fcParameters } from "@crvouga/mockingbird-testing"
import { document, supportedOperationIds, TurnstileAPI } from "./src/index.js"

const baseUrl = "https://turnstile.test",
  now = () => Date.UTC(2026, 0, 1),
  headers = () => ({ "content-type": "application/json" })
test(
  "Siteverify operations agree between independent instances",
  async () => {
    const reference = new TurnstileAPI({ now }),
      params = fcParameters(process.env)
    const report = await parity({
      provider: "turnstile",
      spec: document,
      real: {
        baseUrl,
        allowedHosts: ["turnstile.test"],
        headers,
        fetch: (request) => reference.fetch(request),
      },
      mock: { baseUrl, headers, create: () => new TurnstileAPI({ now }) },
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
    const reference = new TurnstileAPI({ now })
    await expect(
      parity({
        provider: "turnstile",
        spec: document,
        real: {
          baseUrl,
          allowedHosts: ["turnstile.test"],
          headers,
          fetch: (request) => reference.fetch(request),
        },
        mock: {
          baseUrl,
          headers,
          create: () => ({ fetch: async () => Response.json({ unexpected: true }) }),
        },
        only: ["Siteverify"],
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
