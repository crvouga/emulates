import { describe, expect, test } from "bun:test"
import { ParityError, parity } from "@crvouga/mockingbird-parity"
import { fcParameters } from "@crvouga/mockingbird-testing"
import fc from "fast-check"
import { document, FcmAPI, supportedOperationIds } from "./src/index.js"

const params = fcParameters(process.env)
const MOCK_HOST = "fcm.googleapis.com"
const now = () => 1_700_000_000_000

const authed = (api: { fetch: (request: Request) => Promise<Response> }) => ({
  fetch: (request: Request) => {
    const headers = new Headers(request.headers)
    if (!headers.has("authorization")) headers.set("authorization", "Bearer fixture-token")
    return api.fetch(new Request(request, { headers }))
  },
})

describe("FcmAPI", () => {
  test(
    "self-parity: independent instances agree on every random walk and conform to the spec",
    async () => {
      const reference = new FcmAPI({ now })
      const real = authed(reference)
      const report = await parity({
        provider: "fcm",
        spec: document,
        real: {
          baseUrl: `https://${MOCK_HOST}`,
          allowedHosts: [MOCK_HOST],
          fetch: (request) => real.fetch(request),
        },
        mock: { create: () => authed(new FcmAPI({ now })), baseUrl: `https://${MOCK_HOST}` },
        cleanup: async () => {
          await reference.reset()
        },
        includeUnsafe: true,
        numRuns: params.numRuns ?? 25,
        maxCommands: 20,
        latencyToleranceMs: 10_000,
        ...(params.seed === undefined ? {} : { seed: params.seed }),
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
          const reference = authed(new FcmAPI({ now }))
          const faulty = () => {
            const api = authed(new FcmAPI({ now }))
            return {
              fetch: async (request: Request) => {
                const response = await api.fetch(request)
                const body = (await response.json()) as {
                  name?: string
                  error?: { message?: string }
                }
                if (typeof body.name === "string") body.name = "diverged"
                if (body.error) body.error.message = "diverged"
                return Response.json(body, { status: response.status })
              },
            }
          }
          const failure = await parity({
            provider: "fcm",
            spec: document,
            real: {
              baseUrl: `https://${MOCK_HOST}`,
              allowedHosts: [MOCK_HOST],
              fetch: (request) => reference.fetch(request),
            },
            mock: { create: faulty, baseUrl: `https://${MOCK_HOST}` },
            only: ["SendMessage"],
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
