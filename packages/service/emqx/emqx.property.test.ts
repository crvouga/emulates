import { describe, expect, test } from "bun:test"
import { ParityError, parity } from "@crvouga/mockingbird-parity"
import { fcParameters } from "@crvouga/mockingbird-testing"
import fc from "fast-check"
import { document, EmqxAPI, supportedOperationIds } from "./src/index.js"

const params = fcParameters(process.env)
const MOCK_HOST = "mock.emqx.local"
const now = () => 1_700_000_000_000
const auth = { authorization: `Basic ${btoa("parity-key:parity-secret")}` }

describe("EmqxAPI", () => {
  test(
    "self-parity: independent instances agree on every random walk and conform to the spec",
    async () => {
      const reference = new EmqxAPI({ now })
      const report = await parity({
        provider: "emqx",
        spec: document,
        real: {
          baseUrl: `http://${MOCK_HOST}`,
          allowedHosts: [MOCK_HOST],
          headers: () => auth,
          fetch: (request) => reference.fetch(request),
        },
        mock: {
          create: () => new EmqxAPI({ now }),
          baseUrl: `http://${MOCK_HOST}`,
          headers: () => auth,
        },
        cleanup: async () => {
          await reference.reset()
        },
        includeUnsafe: true,
        numRuns: params.numRuns ?? 25,
        maxCommands: 20,
        latencyToleranceMs: 1_000,
        ...(params.seed === undefined ? {} : { seed: params.seed }),
        env: process.env,
        sleep: async () => {},
        log: () => {},
      })
      expect(report.walks).toBeGreaterThan(0)
      // Both REST operations are reached by the walks.
      expect(Object.keys(report.exercised).sort()).toEqual([...supportedOperationIds].sort())
    },
    { timeout: 120_000 },
  )

  test(
    "a deliberately divergent instance is caught and shrunk",
    async () => {
      await fc.assert(
        fc.asyncProperty(fc.integer(), async (seed) => {
          const reference = new EmqxAPI({ now })
          // A broker that reports a different reason for a publish nobody subscribes to.
          const faulty = () => {
            const api = new EmqxAPI({ now })
            return {
              fetch: async (request: Request) => {
                const response = await api.fetch(request)
                if (response.status !== 202) return response
                return Response.json({ reason_code: 0, message: "diverged" }, { status: 202 })
              },
            }
          }
          const failure = await parity({
            provider: "emqx",
            spec: document,
            real: {
              baseUrl: `http://${MOCK_HOST}`,
              allowedHosts: [MOCK_HOST],
              headers: () => auth,
              fetch: (request) => reference.fetch(request),
            },
            mock: { create: faulty, baseUrl: `http://${MOCK_HOST}`, headers: () => auth },
            cleanup: async () => {
              await reference.reset()
            },
            only: ["PublishMessage"],
            includeUnsafe: true,
            numRuns: 10,
            maxCommands: 3,
            seed,
            invalidProbability: 0,
            sleep: async () => {},
            log: () => {},
          }).then(
            () => undefined,
            (error: unknown) => error,
          )
          expect(failure).toBeInstanceOf(ParityError)
        }),
        { ...params, numRuns: 3 },
      )
    },
    { timeout: 60_000 },
  )
})
