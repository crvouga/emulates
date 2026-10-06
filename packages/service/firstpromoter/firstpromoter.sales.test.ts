import { describe, expect, test } from "bun:test"
import { createRuntime } from "./src/index.js"
import { createServer } from "./src/server.js"

const harness = () => {
  const runtime = createRuntime({ settings: { autoConvert: false } })
  runtime.clock.freeze()
  runtime.clock.set(Date.parse("2026-10-04T12:00:00Z"))
  const send = (path: string, body?: unknown, namespace = "default", auth = true) =>
    runtime.fetch(
      new Request(`http://firstpromoter.test${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          "content-type": "application/json",
          "x-emulators-namespace": namespace,
          ...(auth ? { authorization: "Bearer fixture", "account-id": "fixture" } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    )
  const json = async (path: string, body?: unknown, status = 200) => {
    const response = await send(path, body)
    expect(response.status).toBe(status)
    return response.json()
  }
  const seed = async () => {
    const promoter = (await json("/v2/company/promoters", {
      email: "sale-promoter@example.test",
    })) as { id: number; promoter_campaigns: { id: number; ref_token: string }[] }
    const referral = (await json("/v2/track/signup", {
      email: "sale-customer@example.test",
      uid: "sale-customer",
      promoter_id: promoter.id,
    })) as { id: number }
    return { promoter, referral }
  }
  return { runtime, send, json, seed }
}

describe("FirstPromoter sale tracking", () => {
  test("sale attributes minor-unit revenue and a commission to the existing referral", async () => {
    const { runtime, json, seed } = harness()
    const { promoter, referral } = await seed()
    runtime.clock.advance(2000)
    const sale = (await json("/v2/track/sale", {
      event_id: "sale-one",
      amount: 1000,
      currency: "USD",
      uid: "sale-customer",
      skip_email_notification: true,
    })) as { commissions: { id: number; amount: number }[] }
    expect(sale).toMatchObject({
      etype: "sale",
      event_id: "sale-one",
      sale_amount: 1000,
      original_sale_amount: 1000,
      original_sale_currency: "USD",
      created_at: "2026-10-04T12:00:02.000Z",
      referral: { id: referral.id, email: "sale-customer@example.test", uid: "sale-customer" },
      commissions: [
        {
          status: "approved",
          amount: 100,
          unit: "cash",
          sale_amount: 1000,
          event_id: "sale-one",
          promoter_campaign: { promoter_id: promoter.id },
        },
      ],
    })
    expect(await json("/v2/company/commissions")).toEqual(sale.commissions)
    expect(await json(`/v2/company/referrals/${referral.id}`)).toMatchObject({
      state: "active",
      customer_since: "2026-10-04T12:00:02.000Z",
    })
    expect(runtime.instance("default").state.byId(promoter.id)).toMatchObject({
      earnings_cash: 100,
      customers: 1,
    })
    const events = (await json("/__admin/webhooks/events")) as { events: unknown[] }
    expect(events.events).toHaveLength(1)
  })

  test("same event ID yields the documented conflict without a second commission, credit or webhook", async () => {
    const { runtime, send, json, seed } = harness()
    const { promoter } = await seed()
    const body = { event_id: "sale-replay", amount: 1000, email: "sale-customer@example.test" }
    await json("/v2/track/sale", body)
    const before = runtime.instance("default").state.byId(promoter.id)
    const response = await send("/v2/track/sale", { ...body, amount: 2000 })
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({
      message: "The 'sale' event with the id 'sale-replay' already exists.",
    })
    expect(runtime.instance("default").state.byId(promoter.id)).toEqual(before)
    expect(await json("/v2/company/commissions")).toHaveLength(1)
    expect(((await json("/__admin/webhooks/events")) as { events: unknown[] }).events).toHaveLength(
      1,
    )
    await json("/v2/track/sale", { ...body, event_id: "sale-renewal" })
    expect(runtime.instance("default").state.byId(promoter.id)).toMatchObject({
      customers: 1,
      earnings_cash: 200,
    })
  })

  test("unknown attribution, validation and HTTP faults do not record a sale or alter its referral", async () => {
    const { runtime, send, json, seed } = harness()
    const { promoter } = await seed()
    const body = { event_id: "sale-retry", amount: 1000, uid: "sale-customer" }
    const before = runtime.instance("default").state.byId(promoter.id)
    for (const extra of [
      { uid: "unknown" },
      { ref_id: "unknown" },
      { tid: "unknown" },
      { promo_code: "unknown" },
    ]) {
      const response = await send("/v2/track/sale", { ...body, ...extra })
      expect(response.status).toBe(404)
      expect(await response.json()).toEqual({
        message:
          "Referral corresponding to email or uid parameter not found or promoter is banned.",
        code: "not_found",
      })
    }
    expect((await send("/v2/track/sale", { ...body, amount: -1 })).status).toBe(400)
    expect((await send("/v2/track/sale", body, "default", false)).status).toBe(401)
    for (const [preset, status] of [
      ["rate_limited", 429],
      ["server_error", 500],
    ] as const) {
      runtime.applyPreset(preset, "default", { count: 1 })
      expect((await send("/v2/track/sale", body)).status).toBe(status)
    }
    expect(runtime.instance("default").state.byId(promoter.id)).toEqual(before)
    expect(await json("/v2/company/commissions")).toEqual([])
    await json("/v2/track/sale", body)
    expect(await json("/v2/company/commissions")).toHaveLength(1)
  })

  test("valid seeded promo codes share attribution; namespaces, reset and snapshots include deduplication", async () => {
    const { runtime, send, json, seed } = harness()
    const { promoter } = await seed()
    await json(
      "/__admin/promo-codes",
      { promo_code: "FIXTURE-CODE", promoter_campaign_id: promoter.promoter_campaigns[0]?.id },
      201,
    )
    const snapshot = (await json("/__admin/snapshots", {}, 201)) as { id: string }
    const body = {
      event_id: "sale-snapshot",
      amount: 1230,
      uid: "sale-customer",
      promo_code: "FIXTURE-CODE",
    }
    const sale = await json("/v2/track/sale", body)
    expect((await send("/v2/track/sale", body, "other")).status).toBe(404)
    await json(`/__admin/snapshots/${snapshot.id}/restore`, {})
    expect(await json("/v2/company/commissions")).toEqual([])
    expect(await json("/v2/track/sale", body)).toEqual(sale)
    await json("/__admin/reset", {})
    const next = await seed()
    await json("/v2/track/sale", { ...body, promo_code: undefined })
    expect(runtime.instance("default").state.byId(next.promoter.id)).toMatchObject({
      earnings_cash: 123,
    })
  })

  test("served raw-fetch client tracks, lists and rejects replay with namespace-preserving URLs", async () => {
    const server = await createServer({ settings: { autoConvert: false } })
    try {
      const post = (path: string, body: unknown) =>
        fetch(`${server.url}/__admin/ns/sales${path}`, {
          method: "POST",
          headers: {
            authorization: "Bearer fixture",
            "account-id": "fixture",
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
        })
      const promoterResponse = await post("/v2/company/promoters", {
        email: "served-promoter@example.test",
      })
      expect(promoterResponse.status).toBe(200)
      const promoter = (await promoterResponse.json()) as { id: number }
      expect(
        (
          await post("/v2/track/signup", {
            email: "served-customer@example.test",
            promoter_id: promoter.id,
          })
        ).status,
      ).toBe(200)
      const body = { email: "served-customer@example.test", event_id: "served-sale", amount: 1000 }
      const sale = await post("/v2/track/sale", body)
      expect(sale.status).toBe(200)
      expect(await sale.json()).toMatchObject({ commissions: [{ amount: 100 }] })
      expect((await post("/v2/track/sale", body)).status).toBe(409)
      expect(server.runtime.instance("default").state.commissions.count()).toBe(0)
      expect(server.runtime.instance("sales").state.commissions.count()).toBe(1)
    } finally {
      await server.close()
    }
  })
})
