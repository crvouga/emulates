import { expect, test } from "bun:test"
import { ParityError, parity } from "@crvouga/mockingbird-parity"
import { fcParameters } from "@crvouga/mockingbird-testing"
import { document, UnsplashAPI } from "./src/index.js"

const baseUrl = "https://unsplash.test",
  now = () => Date.UTC(2026, 0, 1),
  headers = () => ({ authorization: "Client-ID mock_unsplash_key" })
test(
  "all search and download operations agree between independent instances",
  async () => {
    const reference = new UnsplashAPI({ now }),
      params = fcParameters(process.env)
    const report = await parity({
      provider: "unsplash",
      spec: document,
      real: {
        baseUrl,
        allowedHosts: ["unsplash.test"],
        headers,
        fetch: (request) => reference.fetch(request),
      },
      mock: { baseUrl, headers, create: () => new UnsplashAPI({ now }) },
      cleanup: () => reference.reset(),
      includeUnsafe: true,
      numRuns: params.numRuns ?? 40,
      maxCommands: 20,
      latencyToleranceMs: 1000,
      ...(params.seed === undefined ? {} : { seed: params.seed }),
      sleep: async () => {},
      log: () => {},
    })
    expect(Object.keys(report.exercised).sort()).toEqual(["SearchPhotos", "TrackDownload"].sort())
  },
  { timeout: 60_000 },
)
test(
  "incorrect successful lookup is caught",
  async () => {
    const reference = new UnsplashAPI({ now })
    await expect(
      parity({
        provider: "unsplash",
        spec: document,
        real: {
          baseUrl,
          allowedHosts: ["unsplash.test"],
          headers,
          fetch: (request) => reference.fetch(request),
        },
        mock: {
          baseUrl,
          headers,
          create: () => ({ fetch: async () => Response.json({ unexpected: true }) }),
        },
        only: ["SearchPhotos"],
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
