import { expect, test } from "bun:test"
import { ParityError, parity } from "@crvouga/mockingbird-parity"
import { fcParameters } from "@crvouga/mockingbird-testing"
import { DockerAPI, document, supportedOperationIds } from "./src/index.js"

const host = "docker.mock.local"
const params = fcParameters(process.env)

test("self-parity exercises every implemented observation against the contract", async () => {
  const reference = new DockerAPI()
  const report = await parity({
    provider: "docker",
    spec: document,
    real: { baseUrl: `http://${host}`, allowedHosts: [host], fetch: (r) => reference.fetch(r) },
    mock: { create: () => new DockerAPI(), baseUrl: `http://${host}` },
    cleanup: () => reference.reset(),
    numRuns: params.numRuns ?? 25,
    maxCommands: 10,
    latencyToleranceMs: 1_000,
    ...(params.seed === undefined ? {} : { seed: params.seed }),
    env: process.env,
    sleep: async () => {},
    log: () => {},
  })
  expect(report.walks).toBeGreaterThan(0)
  expect(Object.keys(report.exercised).sort()).toEqual([...supportedOperationIds].sort())
})

test("the parity oracle rejects a divergent ping response", async () => {
  const reference = new DockerAPI()
  const result = parity({
    provider: "docker",
    spec: document,
    real: { baseUrl: `http://${host}`, allowedHosts: [host], fetch: (r) => reference.fetch(r) },
    mock: {
      create: () => ({ fetch: async () => new Response("BROKEN") }),
      baseUrl: `http://${host}`,
    },
    only: ["SystemPing"],
    numRuns: 10,
    maxCommands: 3,
    invalidProbability: 0,
    latencyToleranceMs: 1_000,
    seed: params.seed ?? 42,
    cleanup: () => reference.reset(),
    sleep: async () => {},
    log: () => {},
  })
  const failure: unknown = await result.then(
    () => undefined,
    (error: unknown) => error,
  )
  expect(failure).toBeInstanceOf(ParityError)
  if (!(failure instanceof ParityError)) throw new Error("Expected a parity failure")
  expect(failure.details.kind).toBe("mismatch")
})
