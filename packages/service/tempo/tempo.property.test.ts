import { describe, expect, test } from "bun:test"
import { ParityError, parity } from "@crvouga/mockingbird-parity"
import { fcParameters } from "@crvouga/mockingbird-testing"
import fc from "fast-check"
import { document, supportedOperationIds, TempoAPI } from "./src/index.js"

const params = fcParameters(process.env)
const MOCK_HOST = "mock.tempo.local"
const now = () => 1_700_000_000_000

describe("TempoAPI", () => {
  test(
    "self-parity: independent instances agree on every random walk and conform to the spec",
    async () => {
      const reference = new TempoAPI({ now })
      const report = await parity({
        provider: "tempo",
        spec: document,
        real: {
          baseUrl: `https://${MOCK_HOST}`,
          allowedHosts: [MOCK_HOST],
          fetch: (request) => reference.fetch(request),
        },
        mock: {
          create: () => new TempoAPI({ now }),
          baseUrl: `https://${MOCK_HOST}`,
        },
        cleanup: async () => {
          await reference.reset()
        },
        includeUnsafe: true,
        numRuns: params.numRuns ?? 30,
        maxCommands: 25,
        latencyToleranceMs: 1_000,
        ...(params.seed === undefined ? {} : { seed: params.seed }),
        env: process.env,
        sleep: async () => {},
        log: () => {},
      })
      expect(report.walks).toBeGreaterThan(0)
      // Ingest, search, lookup and tags are all reached by the walks.
      expect(Object.keys(report.exercised).sort()).toEqual([...supportedOperationIds].sort())
    },
    { timeout: 120_000 },
  )

  test(
    "self-parity holds under multi-tenancy, where the walks mix tenants and missing headers",
    async () => {
      const settings = { multitenancy: true }
      const reference = new TempoAPI({ now, settings })
      const report = await parity({
        provider: "tempo",
        spec: document,
        real: {
          baseUrl: `https://${MOCK_HOST}`,
          allowedHosts: [MOCK_HOST],
          fetch: (request) => reference.fetch(request),
        },
        mock: {
          create: () => new TempoAPI({ now, settings }),
          baseUrl: `https://${MOCK_HOST}`,
        },
        cleanup: async () => {
          await reference.reset()
        },
        includeUnsafe: true,
        numRuns: params.numRuns ?? 15,
        maxCommands: 20,
        latencyToleranceMs: 1_000,
        ...(params.seed === undefined ? {} : { seed: params.seed }),
        env: process.env,
        sleep: async () => {},
        log: () => {},
      })
      expect(report.walks).toBeGreaterThan(0)
    },
    { timeout: 120_000 },
  )

  test(
    "a deliberately divergent instance is caught and shrunk",
    async () => {
      await fc.assert(
        fc.asyncProperty(fc.integer(), async (seed) => {
          const reference = new TempoAPI({ now })
          const faulty = () => {
            const api = new TempoAPI({ now })
            return {
              fetch: async (request: Request) => {
                const response = await api.fetch(request)
                if (!new URL(request.url).pathname.endsWith("/search/tags")) return response
                if (response.status !== 200) return response
                const body = (await response.json()) as { scopes: { tags: string[] }[] }
                body.scopes.push({ tags: ["diverged"] })
                return Response.json(body, { status: response.status })
              },
            }
          }
          const failure = await parity({
            provider: "tempo",
            spec: document,
            real: {
              baseUrl: `https://${MOCK_HOST}`,
              allowedHosts: [MOCK_HOST],
              fetch: (r) => reference.fetch(r),
            },
            mock: { create: faulty, baseUrl: `https://${MOCK_HOST}` },
            cleanup: async () => {
              await reference.reset()
            },
            only: ["SearchTagsV2"],
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
