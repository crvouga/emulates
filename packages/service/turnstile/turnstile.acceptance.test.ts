import { expect, test } from "bun:test"
import { createClock } from "@emulators/service"
import { createRuntime } from "./src/index.js"
import { createServer } from "./src/server.js"
import { accepted, verify } from "./test/consumer.js"

const origin = "http://turnstile.test"
const setup = () => {
  const clock = createClock(() => Date.UTC(2026, 0, 1)),
    runtime = createRuntime({ clock })
  const fetchImpl = ((input: RequestInfo | URL, init?: RequestInit) =>
    runtime.fetch(new Request(input, init))) as typeof fetch
  const issue = async (namespace = "default") => {
    const response = await runtime
      .instance(namespace)
      .issue({ hostname: "app.example.test", action: "signup", cdata: "synthetic" })
      .json()
    return response.token as string
  }
  return { clock, runtime, fetchImpl, issue }
}
test("JSON and form verify retain token metadata and consume once", async () => {
  const { fetchImpl, issue } = setup()
  for (const form of [false, true]) {
    const token = await issue()
    const result = await verify(fetchImpl, origin, token, { form })
    expect(result).toEqual({
      success: true,
      "error-codes": [],
      hostname: "app.example.test",
      action: "signup",
      cdata: "synthetic",
      challenge_ts: "2026-01-01T00:00:00.000Z",
    })
    expect(await verify(fetchImpl, origin, token)).toEqual({
      success: false,
      "error-codes": ["timeout-or-duplicate"],
    })
  }
})
test("five minute boundary and invalid credentials do not grant success", async () => {
  const { clock, fetchImpl, issue } = setup()
  const first = await issue(),
    second = await issue()
  expect(await verify(fetchImpl, origin, first, { secret: "wrong" })).toMatchObject({
    "error-codes": ["invalid-input-secret"],
  })
  clock.advance(299_999)
  expect((await verify(fetchImpl, origin, first)).success).toBe(true)
  clock.advance(1)
  expect(await verify(fetchImpl, origin, second)).toMatchObject({
    success: false,
    "error-codes": ["timeout-or-duplicate"],
  })
  expect(await verify(fetchImpl, origin, "", { secret: "" })).toMatchObject({
    "error-codes": ["missing-input-secret"],
  })
  expect(await verify(fetchImpl, origin, "")).toMatchObject({
    "error-codes": ["missing-input-response"],
  })
  expect(await verify(fetchImpl, origin, "unknown")).toMatchObject({
    "error-codes": ["invalid-input-response"],
  })
  expect(await verify(fetchImpl, origin, "x".repeat(2049))).toMatchObject({
    "error-codes": ["invalid-input-response"],
  })
  const malformed = await fetchImpl(`${origin}/turnstile/v0/siteverify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{",
  })
  expect(await malformed.json()).toEqual({ success: false, "error-codes": ["bad-request"] })
})
test("idempotency replays the same verification while a fresh request fails as duplicate", async () => {
  const { runtime, fetchImpl, issue } = setup(),
    token = await issue()
  const idempotencyKey = "00000000-0000-4000-8000-000000000001"
  const first = await verify(fetchImpl, origin, token, { idempotencyKey })
  expect(await verify(fetchImpl, origin, token, { idempotencyKey })).toEqual(first)
  expect(runtime.instance().attempts.count()).toBe(1)
  expect(await verify(fetchImpl, origin, token)).toMatchObject({
    success: false,
    "error-codes": ["timeout-or-duplicate"],
  })
})
test("namespaces, reset and attempt/journal inspection preserve isolation and redact bodies", async () => {
  const { runtime, fetchImpl, issue } = setup()
  const tokenA = await issue("a"),
    tokenB = await issue("b")
  expect(tokenA).not.toBe(tokenB)
  expect((await verify(fetchImpl, origin, tokenA)).success).toBe(false)
  expect((await verify(fetchImpl, `${origin}/__admin/ns/a`, tokenA)).success).toBe(true)
  await runtime.reset("a")
  expect((await verify(fetchImpl, `${origin}/__admin/ns/b`, tokenB)).success).toBe(true)
  expect(runtime.instance("a").tokens.count()).toBe(0)
  const journal = await (await fetchImpl(`${origin}/__admin/requests`)).text()
  expect(journal).not.toContain("mock_secret")
  expect(journal).not.toContain(tokenA)
  const attempts = await (await fetchImpl(`${origin}/__admin/attempts?namespace=b`)).text()
  expect(attempts).not.toContain(tokenB)
})
test("served HTTP client fails closed on transport errors and timeouts", async () => {
  const server = await createServer({ adminPrefix: "/_control/mock" })
  try {
    const token = (
      await (
        await fetch(`${server.url}/_control/mock/issue`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "signup" }),
        })
      ).json()
    ).token as string
    for (const preset of ["internal_error", "rate_limited", "server_error", "connection_drop"]) {
      server.runtime.applyPreset(preset, "default", { count: 1 })
      expect(await accepted(verify(fetch, server.url, token))).toBe(false)
    }
    await fetch(`${server.url}/_control/mock/faults`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ operationId: "Siteverify", latencyMs: 100, count: 1 }),
    })
    expect(
      await accepted(verify(fetch, server.url, token, { signal: AbortSignal.timeout(10) })),
    ).toBe(false)
    const fresh = (await server.runtime.instance().issue({}).json()).token as string
    expect(await accepted(verify(fetch, server.url, fresh))).toBe(true)
  } finally {
    await server.close()
  }
})
