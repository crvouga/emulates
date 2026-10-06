import { describe, expect, test } from "bun:test"
import { runInNewContext } from "node:vm"
import { createClock } from "@emulates/service"
import { createRuntime } from "./src/index.js"
import { createServer } from "./src/server.js"
import { accepted, verify } from "./test/consumer.js"

const ORIGIN = "http://recaptcha.mock"
const NOW = Date.UTC(2026, 0, 1)
const harness = (adminPrefix = "/__admin") => {
  const clock = createClock(() => NOW)
  const runtime = createRuntime({ clock, adminPrefix })
  const fetchImpl = ((input: RequestInfo | URL, init?: RequestInit) =>
    runtime.fetch(new Request(input, init))) as typeof fetch
  const issue = async (namespace = "default", action = "login") => {
    const result = await fetchImpl(`${ORIGIN}${adminPrefix}/issue?namespace=${namespace}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ siteKey: "mock_site", action, hostname: "app.example" }),
    })
    expect(result.status).toBe(200)
    return ((await result.json()) as { token: string }).token
  }
  return { clock, runtime, fetchImpl, issue }
}
describe("reCAPTCHA v3", () => {
  test("browser ready/execute, concurrent distinct tokens and form verification", async () => {
    const { fetchImpl } = harness("/_control/mock")
    const preflight = await fetchImpl(`${ORIGIN}/_control/mock/issue`, {
      method: "OPTIONS",
      headers: {
        origin: "http://app.example",
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type",
      },
    })
    expect(preflight.status).toBe(204)
    expect(preflight.headers.get("access-control-allow-origin")).toBe("*")
    const script = await (await fetchImpl(`${ORIGIN}/recaptcha/api.js?render=mock_site`)).text()
    const window: {
      grecaptcha?: {
        ready: (callback: () => void) => void
        execute: (site: string, options: { action: string }) => Promise<string>
      }
    } = {}
    runInNewContext(script, { window, fetch: fetchImpl, location: { hostname: "app.example" } })
    const grecaptcha = window.grecaptcha
    if (!grecaptcha) throw new Error("Browser shim did not install grecaptcha")
    await new Promise<void>((resolve) => grecaptcha.ready(resolve))
    const tokens = await Promise.all(
      Array.from({ length: 8 }, () => grecaptcha.execute("mock_site", { action: "login" })),
    )
    expect(new Set(tokens).size).toBe(8)
    const result = await verify(fetchImpl, ORIGIN, tokens[0] ?? "")
    expect(result).toEqual({
      success: true,
      score: 0.9,
      action: "login",
      hostname: "app.example",
      challenge_ts: "2026-01-01T00:00:00.000Z",
    })
    expect(accepted(result, "login", "app.example")).toBe(true)
    expect(accepted(result, "checkout", "app.example")).toBe(false)
    expect(accepted(result, "login", "elsewhere.example")).toBe(false)
  })
  test("expiry boundary, replay, wrong secret and invalid/missing input", async () => {
    const { clock, fetchImpl, issue } = harness()
    const token = await issue()
    expect(await verify(fetchImpl, ORIGIN, token, "wrong")).toMatchObject({
      success: false,
      "error-codes": ["invalid-input-secret"],
    })
    expect((await verify(fetchImpl, ORIGIN, token)).success).toBe(true)
    expect(await verify(fetchImpl, ORIGIN, token)).toMatchObject({
      success: false,
      "error-codes": ["timeout-or-duplicate"],
    })
    const expiring = await issue()
    clock.advance(120_000)
    expect(await verify(fetchImpl, ORIGIN, expiring)).toMatchObject({
      success: false,
      "error-codes": ["timeout-or-duplicate"],
    })
    expect(await verify(fetchImpl, ORIGIN, "", "")).toMatchObject({
      success: false,
      "error-codes": ["missing-input-secret", "missing-input-response"],
    })
    expect(await verify(fetchImpl, ORIGIN, "bad-token")).toMatchObject({
      success: false,
      "error-codes": ["invalid-input-response"],
    })
  })
  test("human, bot, exact threshold, expiry/replay and transport presets", async () => {
    const { runtime, fetchImpl, issue } = harness()
    for (const [preset, score] of [
      ["human", 0.9],
      ["bot", 0.1],
      ["threshold_boundary", 0.5],
    ] as const) {
      const token = await issue()
      runtime.applyPreset(preset, "default", { count: 1 })
      const result = await verify(fetchImpl, ORIGIN, token)
      expect(result.score).toBe(score)
      expect(accepted(result, "login", "app.example")).toBe(score >= 0.5)
    }
    for (const preset of ["expired", "replayed"]) {
      runtime.applyPreset(preset, "default", { count: 1 })
      expect((await verify(fetchImpl, ORIGIN, await issue()))["error-codes"]).toEqual([
        "timeout-or-duplicate",
      ])
    }
    runtime.applyPreset("script_failure", "default", { count: 1 })
    expect((await fetchImpl(`${ORIGIN}/recaptcha/api.js`)).status).toBe(503)
    for (const preset of ["rate_limited", "server_error"]) {
      runtime.applyPreset(preset, "default", { count: 1 })
      await expect(verify(fetchImpl, ORIGIN, await issue())).rejects.toThrow("Verification HTTP")
    }
  })
  test("namespace boundaries, reset and metadata-only attempt inspection", async () => {
    const { runtime, fetchImpl, issue } = harness()
    const token = await issue("a")
    const other = await issue("b")
    expect(other).not.toBe(token)
    expect((await verify(fetchImpl, ORIGIN, token)).success).toBe(false)
    const inA = ((input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init)
      request.headers.set("x-emulates-namespace", "a")
      return runtime.fetch(request)
    }) as typeof fetch
    expect((await verify(inA, ORIGIN, token)).success).toBe(true)
    const attempts = await (await fetchImpl(`${ORIGIN}/__admin/attempts?namespace=a`)).text()
    expect(attempts).not.toContain(token)
    expect(attempts).not.toContain("mock_secret")
    await runtime.reset("a")
    expect((await verify(inA, ORIGIN, token)).success).toBe(false)
  })
  test("per-action scores, execution rejection, settings validation and served HTTP", async () => {
    const { runtime, fetchImpl, issue } = harness()
    const settings = (body: unknown) =>
      fetchImpl(`${ORIGIN}/__admin/settings`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      })
    expect((await settings({ score: 2 })).status).toBe(400)
    expect((await settings({ scores: { login: 0.3 } })).status).toBe(200)
    expect((await verify(fetchImpl, ORIGIN, await issue())).score).toBe(0.3)
    await settings({ executeError: true })
    expect(
      runtime.instance().issue({ siteKey: "mock_site", action: "login", hostname: "app.example" })
        .status,
    ).toBe(503)
    expect(
      runtime.instance().issue({ siteKey: "unknown", action: "login", hostname: "app.example" })
        .status,
    ).toBe(400)
    const server = await createServer()
    try {
      expect(
        (await fetch(`${server.url}/recaptcha/api.js?render=mock_site`)).headers.get(
          "content-type",
        ),
      ).toContain("javascript")
      expect((await verify(fetch, server.url, "bad-token")).success).toBe(false)
    } finally {
      await server.close()
    }
  })
})
