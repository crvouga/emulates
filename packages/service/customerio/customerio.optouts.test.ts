import { describe, expect, test } from "bun:test"
import { createRuntime } from "./src/index.js"
import { readCustomerIoOptOutPage } from "./test/consumer.js"

const harness = () => {
  const runtime = createRuntime()
  runtime.clock.freeze()
  const call = (path: string, body?: unknown, method = body === undefined ? "GET" : "POST") =>
    runtime.fetch(
      new Request(`http://mock.test${path}`, {
        method,
        headers: { authorization: "Bearer fixture-key", "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    )
  const profile = (id: string, preferences = {}) =>
    call(`/__admin/profiles/${id}`, { preferences }, "PUT")
  const optout = (customerId: string, from: string, optout = true) =>
    call("/__admin/optouts", { customerId, from, channel: "sms", optout })
  const page = async (path = "/v1/optouts") => {
    const url = new URL(path, "http://mock.test")
    const params = url.searchParams
    return readCustomerIoOptOutPage(
      (request) => runtime.fetch(request),
      url.origin,
      "fixture-key",
      {
        ...(params.has("limit") ? { limit: Number(params.get("limit")) } : {}),
        ...(params.has("start") ? { start: params.get("start") as string } : {}),
        ...(params.has("from") ? { from: params.get("from") as string } : {}),
      },
    )
  }
  return { runtime, call, profile, optout, page }
}

describe("sender opt-out reconciliation (#258)", () => {
  test("a scripted sender STOP appears in workspace and customer reads", async () => {
    const { profile, optout, page, call } = harness()
    await profile("fixture-person")
    expect((await optout("fixture-person", "+12025550123")).ok).toBe(true)
    expect((await page()).optouts).toMatchObject([
      { customer_id: "fixture-person", optouts: [{ channel: "sms", from: "+12025550123" }] },
    ])
    expect(await (await call("/v1/customers/fixture-person/optouts")).json()).toEqual({
      optouts: [{ channel: "sms", from: "+12025550123" }],
    })
  })

  test("start follows next until every opted-out customer is visited exactly once", async () => {
    const { profile, optout, page } = harness()
    for (let i = 0; i < 3; i++) {
      await profile(`fixture-${i}`)
      await optout(`fixture-${i}`, "+12025550123")
    }
    const seen: string[] = []
    let start: string | undefined
    for (let i = 0; i < 3; i++) {
      const result = await page(
        `/v1/optouts?limit=1${start ? `&start=${encodeURIComponent(start)}` : ""}`,
      )
      expect(result.optouts).toHaveLength(1)
      const row = result.optouts[0]
      if (!row) throw new Error("missing opt-out row")
      seen.push(row.customer_id)
      start = result.next
    }
    expect(start).toBeFalsy()
    expect(seen.sort()).toEqual(["fixture-0", "fixture-1", "fixture-2"])
  })

  test("START clears only its sender and preserves marketing preferences", async () => {
    const { profile, optout, page, call } = harness()
    await profile("fixture-person", { channels: { sms: false }, topics: { "1": false } })
    await optout("fixture-person", "+12025550123")
    await optout("fixture-person", "+12025550124")
    await optout("fixture-person", "+12025550123", false)
    expect((await page()).optouts[0]?.optouts).toEqual([{ channel: "sms", from: "+12025550124" }])
    expect(await (await call("/__admin/profiles/fixture-person")).json()).toMatchObject({
      preferences: { channels: { sms: false }, topics: { "1": false } },
    })
  })

  test("a page-two transient failure is retryable without changing opt-outs", async () => {
    const { profile, optout, page, call } = harness()
    for (const id of ["fixture-first", "fixture-second"]) {
      await profile(id)
      await optout(id, "+12025550123")
    }
    const first = await page("/v1/optouts?limit=1")
    if (!first.next) throw new Error("missing next cursor")
    const path = `/v1/optouts?limit=1&start=${encodeURIComponent(first.next)}`
    expect(
      (
        await call("/__admin/faults", {
          method: "GET",
          pathPrefix: "/v1/optouts",
          status: 500,
          body: { meta: { error: "synthetic failure" } },
          count: 1,
        })
      ).status,
    ).toBe(201)
    expect((await call(path)).status).toBe(500)
    const second = await page(path)
    expect(second.optouts[0]?.customer_id).not.toBe(first.optouts[0]?.customer_id)
    expect(second.next).toBeFalsy()
    expect((await page()).optouts).toHaveLength(2)
  })
  test("sender filtering, identity reads, validation and authentication", async () => {
    const { runtime, call, profile, optout, page } = harness()
    await profile("fixture-person")
    const person = (await (await call("/__admin/profiles/fixture-person")).json()) as {
      cioId: string
    }
    await optout("fixture-person", " SyntheticSender ")
    await optout("fixture-person", "+12025550124")
    expect((await page("/v1/optouts?from=SYNTHETICSENDER")).optouts[0]?.optouts).toEqual([
      { channel: "sms", from: "syntheticsender" },
    ])
    expect(
      await (await call(`/v1/customers/${person.cioId}/optouts?id_type=cio_id`)).json(),
    ).toEqual(await (await call("/v1/customers/fixture-person/optouts")).json())
    expect((await call("/v1/customers/missing/optouts")).status).toBe(404)
    for (const path of ["/v1/optouts", "/v1/customers/fixture-person/optouts"]) {
      expect((await runtime.fetch(new Request(`http://mock.test${path}`))).status).toBe(401)
    }
    for (const query of ["limit=0", "limit=1001", "limit=1.5", "start=invalid"])
      expect((await call(`/v1/optouts?${query}`)).status).toBe(400)
    expect(
      (await call("/__admin/optouts", { customerId: "missing", from: "sender", optout: true }))
        .status,
    ).toBe(404)
    expect(
      (
        await call("/__admin/optouts", {
          customerId: "fixture-person",
          from: "sender",
          optout: true,
          channel: "invalid",
        })
      ).status,
    ).toBe(400)
    await call("/__admin/settings", { keys: ["accepted-fixture"] }, "PUT")
    expect((await call("/v1/optouts")).status).toBe(401)
  })

  test("namespace clock, snapshot restore, reset and throttling preserve isolation", async () => {
    const { runtime, call, profile, optout, page } = harness()
    await profile("fixture-person")
    await optout("fixture-person", "+12025550123")
    const original = await page()
    const snapshot = (await (await call("/__admin/snapshots", {})).json()) as { id: string }
    await optout("fixture-person", "+12025550123", false)
    expect((await page()).optouts).toEqual([])
    await call("/__admin/namespace-clock", { advance: 3600000 })
    expect((await call(`/__admin/snapshots/${snapshot.id}/restore`, {})).status).toBe(200)
    expect(await page()).toEqual(original)
    expect(await (await call("/__admin/ns/other/v1/optouts")).json()).toEqual({ optouts: [] })
    await call("/__admin/ns/other/__admin/profiles/fixture-other", {}, "PUT")
    await call("/__admin/ns/other/__admin/optouts", {
      customerId: "fixture-other",
      from: "+12025550124",
      optout: true,
    })
    await call("/__admin/faults", {
      method: "GET",
      pathPrefix: "/v1/optouts",
      status: 429,
      count: 1,
      headers: { "retry-after": "1" },
    })
    const throttled = await call("/v1/optouts")
    expect(throttled.status).toBe(429)
    expect(throttled.headers.get("retry-after")).toBe("1")
    expect(await page()).toEqual(original)
    await call("/__admin/reset", {})
    expect((await page()).optouts).toEqual([])
    expect(
      ((await (await call("/__admin/ns/other/v1/optouts")).json()) as { optouts: unknown[] })
        .optouts,
    ).toHaveLength(1)
    await runtime.reset()
  })
})
