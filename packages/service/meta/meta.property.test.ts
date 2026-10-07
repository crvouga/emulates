import { describe, expect, test } from "bun:test"
import { ParityError, parity } from "@crvouga/mockingbird-parity"
import { fcParameters } from "@crvouga/mockingbird-testing"
import fc from "fast-check"
import { document, MetaAPI } from "./src/index.js"

const params = fcParameters(process.env)
const HOST = "mock.meta.local"
const headers = { authorization: "Bearer meta_parity_token" }
const now = () => Date.UTC(2026, 0, 4, 12)

describe("MetaAPI", () => {
  test(
    "self-parity: independent instances agree and every response conforms to the contract",
    async () => {
      const reference = new MetaAPI({ now })
      const report = await parity({
        provider: "meta",
        spec: document,
        real: {
          baseUrl: `https://${HOST}`,
          allowedHosts: [HOST],
          headers: () => headers,
          fetch: (request) => reference.fetch(request),
        },
        mock: {
          create: () => new MetaAPI({ now }),
          baseUrl: `https://${HOST}`,
          headers: () => headers,
        },
        cleanup: () => reference.reset(),
        numRuns: params.numRuns ?? 25,
        maxCommands: 15,
        latencyToleranceMs: 1_000,
        ...(params.seed === undefined ? {} : { seed: params.seed }),
        env: process.env,
        sleep: async () => {},
        log: () => {},
      })
      expect(report.walks).toBeGreaterThan(0)
      // CAPI ingestion is unsafe and disabled for random parity walks; the
      // acceptance suite covers that write surface directly.
      expect(Object.keys(report.exercised).sort()).toEqual(["GetInsights", "GetMarketingObject"])
    },
    { timeout: 120_000 },
  )

  test(
    "a deliberately divergent instance is caught and shrunk",
    async () => {
      await fc.assert(
        fc.asyncProperty(fc.integer(), async (seed) => {
          const reference = new MetaAPI({ now })
          const faulty = () => {
            const api = new MetaAPI({ now })
            return {
              fetch: async (request: Request) => {
                const response = await api.fetch(request)
                if (!request.url.includes("/insights") || response.status !== 200) return response
                const body = (await response.json()) as { data: unknown[]; paging: unknown }
                return Response.json({ ...body, data: [{ diverged: true }] })
              },
            }
          }
          const failure = await parity({
            provider: "meta",
            spec: document,
            real: {
              baseUrl: `https://${HOST}`,
              allowedHosts: [HOST],
              headers: () => headers,
              fetch: (request) => reference.fetch(request),
            },
            mock: { create: faulty, baseUrl: `https://${HOST}`, headers: () => headers },
            cleanup: () => reference.reset(),
            only: ["GetInsights"],
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
