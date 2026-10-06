import { expect, test } from "bun:test"
import { ParityError, type ParityOptions, parity } from "@emulators/parity"
import { fcParameters } from "@emulators/testing"
import { document, SentryAPI, supportedOperationIds } from "./src/index.js"

const params = fcParameters(process.env)
const now = () => 1_700_000_000_000
const headers = () => ({ authorization: "Bearer fixture-rest-token" })
const disabled = new Set(["IngestEnvelope", "IngestMinidump"])

test(
  "self-parity: independent Sentry instances conform and exercise every enabled operation",
  async () => {
    const reference = new SentryAPI({ now })
    const options: ParityOptions = {
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
      sleep: async () => {},
      log: () => {},
      latencyToleranceMs: 1000,
      env: process.env,
    }
    // REST event creation cannot create attachments (envelope ingestion is outside this
    // walk). Exercise the missing-attachment contract explicitly rather than relying on
    // the random walk's rare missing reference to make this operation eligible.
    const attachment = await parity({
      ...options,
      only: ["GetEventAttachment"],
      missingProbability: 1,
      numRuns: 5,
      maxCommands: 1,
      seed: 0,
    })
    expect(attachment.exercised.GetEventAttachment).toBeGreaterThan(0)
    const report = await parity({
      ...options,
      numRuns: params.numRuns ?? 40,
      maxCommands: 30,
      ...(params.seed === undefined ? {} : { seed: params.seed }),
    })
    expect(report.walks).toBeGreaterThan(0)
    expect(Object.keys({ ...report.exercised, ...attachment.exercised }).sort()).toEqual(
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
