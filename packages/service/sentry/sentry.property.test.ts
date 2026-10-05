import { expect, test } from "bun:test"
import { ParityError, parity } from "@crvouga/mockingbird-parity"
import { fcParameters } from "@crvouga/mockingbird-testing"
import { document, SentryAPI, supportedOperationIds } from "./src/index.js"

const params = fcParameters(process.env)
const now = () => 1_700_000_000_000
const headers = () => ({ authorization: "Bearer fixture-rest-token" })
const disabled = new Set(["IngestEnvelope", "IngestMinidump"])

test(
  "self-parity: independent Sentry instances conform and exercise every enabled operation",
  async () => {
    const reference = new SentryAPI({ now })
    const report = await parity({
      provider: "sentry",
      spec: document,
      includeUnsafe: true,
      real: {
        baseUrl: "https://sentry.fixture",
        allowedHosts: ["sentry.fixture"],
        headers,
        fetch: (r) => reference.fetch(r),
      },
      mock: { baseUrl: "https://sentry.fixture", headers, create: () => new SentryAPI({ now }) },
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
      supportedOperationIds.filter((id) => !disabled.has(id)).sort(),
    )
  },
  { timeout: 120_000 },
)

test("a divergent event list is detected", async () => {
  const reference = new SentryAPI({ now })
  const failure = await parity({
    provider: "sentry",
    spec: document,
    only: ["ListProjectEvents"],
    numRuns: 10,
    maxCommands: 3,
    seed: 0,
    invalidProbability: 0,
    real: {
      baseUrl: "https://sentry.fixture",
      allowedHosts: ["sentry.fixture"],
      headers,
      fetch: (r) => reference.fetch(r),
    },
    mock: {
      baseUrl: "https://sentry.fixture",
      headers,
      create: () => ({
        fetch: async () => Response.json({ error: "Deliberately divergent" }, { status: 503 }),
      }),
    },
    sleep: async () => {},
    log: () => {},
  }).then(
    () => undefined,
    (error: unknown) => error,
  )
  expect(failure).toBeInstanceOf(ParityError)
})
