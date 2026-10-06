import { expect, test } from "bun:test"
import { ParityError, parity } from "@emulates/parity"
import { fcParameters } from "@emulates/testing"
import { document, RecaptchaAPI } from "./src/index.js"

const baseUrl = "https://recaptcha.test"
const now = () => Date.UTC(2026, 0, 1)
test(
  "self-parity covers every enabled operation",
  async () => {
    const reference = new RecaptchaAPI({ now })
    const params = fcParameters(process.env)
    const report = await parity({
      provider: "recaptcha",
      spec: document,
      real: {
        baseUrl,
        allowedHosts: ["recaptcha.test"],
        fetch: (request) => reference.fetch(request),
      },
      mock: { baseUrl, create: () => new RecaptchaAPI({ now }) },
      cleanup: () => reference.reset(),
      includeUnsafe: true,
      numRuns: params.numRuns ?? 25,
      maxCommands: 10,
      latencyToleranceMs: 1_000,
      ...(params.seed === undefined ? {} : { seed: params.seed }),
      sleep: async () => {},
      log: () => {},
    })
    expect(Object.keys(report.exercised)).toEqual(["Siteverify"])
  },
  { timeout: 60_000 },
)
test(
  "divergent verification is detected",
  async () => {
    const reference = new RecaptchaAPI({ now })
    const failed = parity({
      provider: "recaptcha",
      spec: document,
      real: {
        baseUrl,
        allowedHosts: ["recaptcha.test"],
        fetch: (request) => reference.fetch(request),
      },
      mock: { baseUrl, create: () => ({ fetch: async () => Response.json({ success: true }) }) },
      cleanup: () => reference.reset(),
      numRuns: 5,
      maxCommands: 3,
      latencyToleranceMs: 1_000,
      seed: 42,
      sleep: async () => {},
      log: () => {},
    })
    await expect(failed).rejects.toBeInstanceOf(ParityError)
  },
  { timeout: 60_000 },
)
