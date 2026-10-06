import { expect, test } from "bun:test"
import { ParityError, parity } from "@emulates/parity"
import { fcParameters } from "@emulates/testing"
import { AppStoreConnectAPI, document, supportedOperationIds } from "./src/index.js"
import { credentials } from "./test/consumer.js"

const baseUrl = "https://apple.mock"
const now = () => 1_800_000_000_000
test("signed independent walks cover the entire supported contract", async () => {
  const auth = await credentials(),
    token = await auth.token(now()),
    headers = () => ({ authorization: `Bearer ${token}` })
  const reference = new AppStoreConnectAPI({ now, keys: [auth.key] })
  const report = await parity({
    provider: "app-store-connect",
    spec: document,
    real: {
      baseUrl,
      allowedHosts: ["apple.mock"],
      headers,
      fetch: (request) => reference.fetch(request),
    },
    mock: { baseUrl, headers, create: () => new AppStoreConnectAPI({ now, keys: [auth.key] }) },
    cleanup: () => reference.reset(),
    includeUnsafe: true,
    ...fcParameters(process.env),
    numRuns: 40,
    maxCommands: 30,
    latencyToleranceMs: 1000,
    sleep: async () => {},
    log: () => {},
  })
  expect(Object.keys(report.exercised).sort()).toEqual([...supportedOperationIds].sort())
}, 30_000)
test("deliberate divergence is caught", async () => {
  const auth = await credentials(),
    token = await auth.token(now()),
    headers = () => ({ authorization: `Bearer ${token}` })
  const reference = new AppStoreConnectAPI({ now, keys: [auth.key] })
  await expect(
    parity({
      provider: "app-store-connect",
      spec: document,
      real: {
        baseUrl,
        allowedHosts: ["apple.mock"],
        headers,
        fetch: (request) => reference.fetch(request),
      },
      mock: {
        baseUrl,
        headers,
        create: () => ({ fetch: async () => Response.json({ errors: [] }, { status: 503 }) }),
      },
      only: ["ListApps"],
      numRuns: 5,
      maxCommands: 3,
      latencyToleranceMs: 1000,
      sleep: async () => {},
      log: () => {},
    }),
  ).rejects.toBeInstanceOf(ParityError)
})
