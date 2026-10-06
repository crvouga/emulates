import { describe, expect, test } from "bun:test"
import { ParityError, parity } from "@emulators/parity"
import { fcParameters } from "@emulators/testing"
import fc from "fast-check"
import { document, PlaneAPI, supportedOperationIds } from "./src/index.js"

const params = fcParameters(process.env)
const MOCK_HOST = "mock.plane.local"
const now = () => 1_700_000_000_000
const auth = { "x-api-key": "plane_api_parity" }
const seedTypes = (api: PlaneAPI) =>
  api.seedWorkItemTypes("acme", "33333333-3333-4333-8333-333333333333", [
    { name: "Bug" },
    { name: "Feature" },
    { name: "Task", is_default: true },
  ])
const fixture = () => {
  const api = new PlaneAPI({ now })
  seedTypes(api)
  return api
}

describe("PlaneAPI", () => {
  test(
    "self-parity: independent instances agree on every random walk and conform to the spec",
    async () => {
      // The reported workflow starts with configured types. Their list supplies real UUID
      // references to random create/patch commands instead of exercising only invalid IDs.
      const reference = fixture()
      const report = await parity({
        provider: "plane",
        spec: document,
        real: {
          baseUrl: `https://${MOCK_HOST}`,
          allowedHosts: [MOCK_HOST],
          headers: () => auth,
          fetch: (request) => reference.fetch(request),
        },
        mock: {
          create: fixture,
          baseUrl: `https://${MOCK_HOST}`,
          headers: () => auth,
        },
        cleanup: async () => {
          await reference.reset()
          seedTypes(reference)
        },
        includeUnsafe: true,
        numRuns: Math.max(params.numRuns ?? 60, 60),
        maxCommands: 30,
        coverageBias: 4,
        latencyToleranceMs: 1_000,
        // This test asserts whole-spec coverage, so keep its default walk reproducible. FC_SEED
        // still overrides it when investigating another generated path.
        seed: params.seed ?? 1,
        env: process.env,
        sleep: async () => {},
        log: () => {},
      })
      expect(report.walks).toBeGreaterThan(0)
      expect(Object.keys(report.exercised).sort()).toEqual([...supportedOperationIds].sort())
    },
    { timeout: 120_000 },
  )

  test(
    "a deliberately divergent instance is caught and shrunk",
    async () => {
      await fc.assert(
        fc.asyncProperty(fc.integer(), async (seed) => {
          const reference = new PlaneAPI({ now })
          const faulty = () => {
            const api = new PlaneAPI({ now })
            return {
              fetch: async (request: Request) => {
                const response = await api.fetch(request)
                if (response.status !== 200) return response
                const body = (await response.json()) as { total_count: number }
                return Response.json(
                  { ...body, total_count: body.total_count + 1 },
                  { status: 200 },
                )
              },
            }
          }
          const failure = await parity({
            provider: "plane",
            spec: document,
            real: {
              baseUrl: `https://${MOCK_HOST}`,
              allowedHosts: [MOCK_HOST],
              headers: () => auth,
              fetch: (r) => reference.fetch(r),
            },
            mock: { create: faulty, baseUrl: `https://${MOCK_HOST}`, headers: () => auth },
            cleanup: async () => {
              await reference.reset()
            },
            only: ["ListStates"],
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
