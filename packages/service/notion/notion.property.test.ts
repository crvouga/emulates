import { expect, test } from "bun:test"
import { ParityError, parity } from "@emulators/parity"
import { fcParameters } from "@emulators/testing"
import { document, NotionAPI, supportedOperationIds } from "./src/index.js"

const baseUrl = "https://notion.test",
  now = () => Date.UTC(2026, 0, 1),
  headers = () => ({ authorization: "Bearer mock_notion_token", "notion-version": "2022-06-28" })
test(
  "all Notion operations agree between independent instances",
  async () => {
    const reference = new NotionAPI({ now }),
      params = fcParameters(process.env)
    const report = await parity({
      provider: "notion",
      spec: document,
      real: {
        baseUrl,
        allowedHosts: ["notion.test"],
        headers,
        fetch: (request) => reference.fetch(request),
      },
      mock: { baseUrl, headers, create: () => new NotionAPI({ now }) },
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
    const reference = new NotionAPI({ now })
    await expect(
      parity({
        provider: "notion",
        spec: document,
        real: {
          baseUrl,
          allowedHosts: ["notion.test"],
          headers,
          fetch: (request) => reference.fetch(request),
        },
        mock: {
          baseUrl,
          headers,
          create: () => ({ fetch: async () => Response.json({ unexpected: true }) }),
        },
        only: ["Search"],
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
