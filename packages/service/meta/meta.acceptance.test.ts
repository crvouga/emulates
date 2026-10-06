import { describe, expect, test } from "bun:test"
import { createClock } from "@emulates/service"
import { createRuntime, META_PRESETS } from "./src/index.js"
import { createServer } from "./src/server.js"
import {
  type ConversionEvent,
  getMarketingObject,
  listInsights,
  MetaGraphError,
  sendConversionEvents,
} from "./test/consumer.js"

const API = "http://meta.mock"
const TOKEN = "meta_test_token"
const NOW = Date.UTC(2026, 0, 4, 12) / 1000
const HASH = "a".repeat(64)

const event = (patch: Partial<ConversionEvent> = {}): ConversionEvent => ({
  event_name: "Purchase",
  event_time: NOW,
  event_id: "order_42",
  action_source: "website",
  event_source_url: "https://example.test/checkout",
  user_data: { em: [HASH], external_id: [HASH], fbc: "fb.1.1760000000000.synthetic" },
  custom_data: { currency: "USD", value: 42 },
  ...patch,
})

const harness = () => {
  const runtime = createRuntime({ clock: createClock(() => NOW * 1000) })
  const fetchImpl = (input: string, init?: RequestInit) => runtime.fetch(new Request(input, init))
  const send = (events: ConversionEvent[], accessToken = TOKEN) =>
    sendConversionEvents({
      baseUrl: API,
      pixelId: "pixel_emulators",
      accessToken,
      events,
      testEventCode: "TEST42",
      fetchImpl,
    })
  return { runtime, fetchImpl, send }
}

describe("Meta acceptance", () => {
  test("CAPI preserves the Geviti event contract and deduplicates event_id", async () => {
    const { runtime, send } = harness()
    expect(await send([event()])).toMatchObject({ events_received: 1, messages: [] })
    expect(await send([event()])).toMatchObject({ events_received: 1, messages: [] })
    expect(runtime.instance().events()).toHaveLength(1)
    expect(runtime.instance().events()[0]).toMatchObject({
      pixelId: "pixel_emulators",
      event_name: "Purchase",
      event_id: "order_42",
      action_source: "website",
      user_data: { em: [HASH], fbc: "fb.1.1760000000000.synthetic" },
      custom_data: { currency: "USD", value: 42 },
      test_event_code: "TEST42",
    })
  })

  test("event age, hashes, auth, rate limits, and partial batches use Graph envelopes", async () => {
    const { runtime, send } = harness()
    await expect(send([event({ event_time: NOW - 604_801 })])).rejects.toMatchObject({
      status: 400,
      code: 100,
    })
    await expect(send([event({ user_data: { em: ["not-hashed"] } })])).rejects.toBeInstanceOf(
      MetaGraphError,
    )
    await runtime.fetch(
      new Request(`${API}/__admin/settings`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ accessTokens: [TOKEN] }),
      }),
    )
    await expect(send([event()], "wrong")).rejects.toMatchObject({ status: 401, code: 190 })
    runtime.applyPreset("rate_limited", "default", { count: 1 })
    await expect(send([event({ event_id: "limited" })])).rejects.toMatchObject({
      status: 429,
      transient: true,
    })
    runtime.applyPreset("partial_event_acceptance", "default", { count: 1 })
    const partial = await send([event({ event_id: "first" }), event({ event_id: "second" })])
    expect(partial.events_received).toBe(1)
    expect(partial.messages).toHaveLength(1)
  })

  test("ambiguous timeout persists once and retry deduplicates", async () => {
    const { runtime, send } = harness()
    runtime.applyPreset("accepted_then_drop", "default", { count: 1 })
    await expect(send([event()])).rejects.toBeInstanceOf(TypeError)
    expect(runtime.instance().events()).toHaveLength(1)
    await send([event()])
    expect(runtime.instance().events()).toHaveLength(1)
  })

  test("insights filter inclusively, paginate, and include requested breakdowns", async () => {
    const { fetchImpl } = harness()
    const first = await listInsights({
      baseUrl: API,
      accountId: "act_emulators",
      accessToken: TOKEN,
      since: "2026-01-01",
      until: "2026-01-03",
      limit: 2,
      breakdowns: ["country"],
      fetchImpl,
    })
    expect(first.data).toHaveLength(2)
    expect(first.data[0]).toMatchObject({ date_start: "2026-01-01", country: "US" })
    expect(first.paging.next).toContain("after=2")
    const second = await listInsights({
      baseUrl: API,
      accountId: "act_emulators",
      accessToken: TOKEN,
      since: "2026-01-01",
      until: "2026-01-03",
      limit: 2,
      after: first.paging.cursors.after,
      fetchImpl,
    })
    expect(second.data.map((row) => row.date_start)).toEqual(["2026-01-03"])
  })

  test("campaign reads and namespaces are isolated", async () => {
    const { runtime, fetchImpl, send } = harness()
    expect(
      await getMarketingObject({
        baseUrl: API,
        id: "cmp_emulators",
        accessToken: TOKEN,
        fetchImpl,
      }),
    ).toMatchObject({ id: "cmp_emulators", status: "ACTIVE" })
    const namespaced = (namespace: string, id: string) =>
      runtime.fetch(
        new Request(`${API}/v26.0/pixel_emulators/events?access_token=${TOKEN}`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-emulates-namespace": namespace },
          body: JSON.stringify({ data: [event({ event_id: id })] }),
        }),
      )
    await namespaced("a", "a1")
    await namespaced("b", "b1")
    expect(
      runtime
        .instance("a")
        .events()
        .map((entry) => entry.event_id),
    ).toEqual(["a1"])
    expect(
      runtime
        .instance("b")
        .events()
        .map((entry) => entry.event_id),
    ).toEqual(["b1"])
    expect(runtime.instance().events()).toHaveLength(0)
    await send([event({ event_id: "default" })])
    expect(runtime.instance().events()).toHaveLength(1)
  })

  test("presets are registered and the served Node adapter accepts plain fetch", async () => {
    expect(Object.keys(META_PRESETS)).toEqual(
      expect.arrayContaining([
        "expired_token",
        "rate_limited",
        "server_error",
        "accepted_then_drop",
      ]),
    )
    const server = await createServer({ clock: createClock(() => NOW * 1000) })
    try {
      const response = await sendConversionEvents({
        baseUrl: server.url,
        pixelId: "pixel_emulators",
        accessToken: TOKEN,
        events: [event()],
        fetchImpl: fetch,
      })
      expect(response.events_received).toBe(1)
      expect((await fetch(`${server.url}/__admin/health`)).headers.get("x-emulates")).toMatch(
        /^meta@/,
      )
    } finally {
      await server.close()
    }
  })
})
