import { describe, expect, test } from "bun:test"
import { createRuntime, type Delivery, type Profile, REPORTING_WEBHOOK_PATH } from "./src/index.js"
import {
  CustomerIoTransactionalError,
  listTransactionalTriggerNames,
  sendCustomerIoTransactional,
} from "./test/consumer.js"

const API = "http://customerio.mock"
const APP_KEY = "app_key"
const SIGNING_KEY = "cio-reporting-signing-key-0123456789abcdef"

const harness = () => {
  const webhooks: { metric: string; timestamp: number; header: string | null }[] = []
  const runtime = createRuntime({
    webhooks: {
      url: `http://backend.local${REPORTING_WEBHOOK_PATH}`,
      secret: SIGNING_KEY,
      fetch: async (request) => {
        const body = (await request.json()) as { metric: string; timestamp: number }
        webhooks.push({
          metric: body.metric,
          timestamp: body.timestamp,
          header: request.headers.get("x-cio-timestamp"),
        })
        return new Response(null, { status: 200 })
      },
    },
  })
  const admin = async <T>(path: string, body?: unknown, method = body ? "POST" : "GET") =>
    (await (
      await runtime.fetch(
        new Request(`${API}/__admin${path}`, {
          method,
          headers: { "content-type": "application/json" },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
      )
    ).json()) as T
  const outbox = async (query = "") =>
    (await admin<{ messages: Delivery[] }>(`/outbox${query}`)).messages
  const app = (path: string, body?: unknown, method = "POST", key = APP_KEY) =>
    runtime.fetch(
      new Request(`${API}${path}`, {
        method,
        headers: {
          ...(key ? { authorization: `Bearer ${key}` } : {}),
          "content-type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    )
  const cdp = (path: string, body: unknown, key = "write_key") =>
    runtime.fetch(
      new Request(`${API}${path}`, {
        method: "POST",
        headers: {
          authorization: `Basic ${btoa(`${key}:`)}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      }),
    )
  const processor = (overrides: Partial<Parameters<typeof sendCustomerIoTransactional>[0]> = {}) =>
    sendCustomerIoTransactional({
      appApiHost: API,
      apiKey: APP_KEY,
      channel: "email",
      transactionalMessageId: "acme_welcome",
      identifier: "42",
      to: "ada@example.com",
      messageData: { note: "hello" },
      tracked: false,
      disableMessageRetention: false,
      fetchImpl: (request) => runtime.fetch(request),
      ...overrides,
    })
  const failure = (promise: Promise<unknown>) =>
    promise.then(
      () => {
        throw new Error("expected a failure")
      },
      (error: unknown) => error as CustomerIoTransactionalError,
    )
  return { runtime, admin, outbox, app, cdp, processor, failure, webhooks }
}

const read = async (response: Response) => ({
  status: response.status,
  body: (await response.json()) as Record<string, unknown>,
  retryAfter: response.headers.get("retry-after"),
})

describe("Customer.io notification contract", () => {
  test("1. identify creates a profile and attribute reads return identifiers plus traits", async () => {
    const { cdp, app, admin } = harness()
    expect(
      (
        await cdp("/v1/identify", {
          userId: "42",
          traits: { email: "ada@example.com", phone: "+15550001111", plan: "pro" },
        })
      ).status,
    ).toBe(200)
    const byId = await read(await app("/v1/customers/42/attributes", undefined, "GET"))
    expect(byId.status).toBe(200)
    expect(byId.body).toMatchObject({
      customer: {
        identifiers: { id: "42", email: "ada@example.com" },
        attributes: { email: "ada@example.com", phone: "+15550001111", plan: "pro", id: "42" },
        devices: [],
      },
    })
    const profile = await admin<Profile>("/profiles/42")
    const byEmail = await read(
      await app(
        `/v1/customers/${encodeURIComponent("ada@example.com")}/attributes?id_type=email`,
        undefined,
        "GET",
      ),
    )
    const byCio = await read(
      await app(
        `/v1/customers/${encodeURIComponent(profile.cioId)}/attributes?id_type=cio_id`,
        undefined,
        "GET",
      ),
    )
    expect(byEmail.status).toBe(200)
    expect(byCio.status).toBe(200)
    expect(
      await read(await app("/v1/customers/missing/attributes", undefined, "GET")),
    ).toMatchObject({ status: 404 })
  })

  test("2. a later identify keeps omitted traits and explicit false preferences", async () => {
    const { cdp, app } = harness()
    await cdp("/v1/identify", {
      userId: "42",
      traits: {
        plan: "pro",
        city: "Tempe",
        cio_subscription_preferences: {
          channels: { email: false, sms: true },
          topics: { news: false },
        },
      },
    })
    await cdp("/v1/identify", {
      userId: "42",
      traits: {
        timezone: "America/Phoenix",
        cio_subscription_preferences: { channels: { sms: false }, topics: { labs: true } },
      },
    })
    const { body } = await read(await app("/v1/customers/42/attributes", undefined, "GET"))
    const attributes = (body.customer as { attributes: Record<string, unknown> }).attributes
    expect(attributes.plan).toBe("pro")
    expect(attributes.city).toBe("Tempe")
    expect(attributes.timezone).toBe("America/Phoenix")
    expect(attributes.cio_subscription_preferences).toEqual({
      channels: { email: false, sms: false },
      topics: { news: false, labs: true },
    })
    expect(attributes.unsubscribed).toBe(false)
  })

  test("3. concurrent identifies keep every non-conflicting trait and finish in handler order", async () => {
    const { cdp, admin } = harness()
    const [left, right] = await Promise.all([
      cdp("/v1/identify", {
        userId: "42",
        messageId: "left",
        traits: {
          left: true,
          cio_subscription_preferences: { channels: { email: false }, topics: { a: true } },
        },
      }),
      cdp("/v1/identify", {
        userId: "42",
        messageId: "right",
        traits: {
          right: true,
          cio_subscription_preferences: { channels: { sms: false }, topics: { b: false } },
        },
      }),
    ])
    expect([left.status, right.status]).toEqual([200, 200])
    const profile = await admin<Profile>("/profiles/42")
    expect(profile.traits.left).toBe(true)
    expect(profile.traits.right).toBe(true)
    expect(profile.traits.cio_subscription_preferences).toEqual({
      channels: { email: false, sms: false },
      topics: { a: true, b: false },
    })
    const events = (await admin<{ events: { messageId: string }[] }>("/cdp/events")).events
    const journal = (
      await admin<{ requests: { operationId: string; ids?: { messageIds?: string } }[] }>(
        "/requests",
      )
    ).requests.filter((entry) => entry.operationId === "CdpIdentify")
    expect(journal.map((entry) => entry.ids?.messageIds)).toEqual(
      events.map((event) => event.messageId),
    )
  })

  test("4. a repeated messageId is accepted and not applied again", async () => {
    const { cdp, admin } = harness()
    await cdp("/v1/identify", { userId: "42", messageId: "same", traits: { plan: "a" } })
    const again = await read(
      await cdp("/v1/identify", { userId: "42", messageId: "same", traits: { plan: "b" } }),
    )
    expect(again.status).toBe(200)
    const events = (await admin<{ events: { duplicate: boolean }[] }>("/cdp/events")).events
    expect(events.map((event) => event.duplicate)).toEqual([false, true])
    expect((await admin<Profile>("/profiles/42")).traits.plan).toBe("a")
  })

  test("5. an invalid batch is 400 and applies nothing", async () => {
    const { cdp, admin } = harness()
    const response = await read(
      await cdp("/v1/batch", {
        batch: [{ type: "identify", userId: "42", traits: { plan: "pro" } }, { type: "track" }],
      }),
    )
    expect(response.status).toBe(400)
    expect(response.body).toEqual({ error: expect.any(String) })
    expect((await admin<{ events: unknown[] }>("/cdp/events")).events).toHaveLength(0)
    expect((await admin<{ profiles: unknown[] }>("/profiles")).profiles).toHaveLength(0)
  })

  test("6. a catalog id and its trigger name each queue one delivery", async () => {
    const { admin, app, outbox } = harness()
    const existing = (
      await admin<{ messages: { id: number; trigger_name: string; name: string }[] }>(
        "/transactional",
      )
    ).messages
    await admin(
      "/transactional",
      {
        messages: [
          ...existing,
          { id: 101, trigger_name: "supplement_upcoming_order_email", name: "Supplement" },
        ],
      },
      "PUT",
    )
    const byId = await read(
      await app("/v1/send/email", {
        transactional_message_id: 101,
        identifiers: { id: "42" },
        to: "ada@example.com",
      }),
    )
    const byName = await read(
      await app("/v1/send/email", {
        transactional_message_id: "Supplement_Upcoming_Order_Email",
        identifiers: { id: "42" },
        to: "ada@example.com",
      }),
    )
    expect(byId.status).toBe(200)
    expect(byName.status).toBe(200)
    expect(byId.body.delivery_id).toEqual(expect.any(String))
    expect(byId.body.queued_at).toEqual(expect.any(Number))
    expect(byName.body.delivery_id).not.toBe(byId.body.delivery_id)
    const rows = await outbox("?transactional_message_id=101")
    expect(rows).toHaveLength(1)
    expect((await outbox()).filter((row) => row.messageId === 101)).toHaveLength(2)
  })

  test("7. an unknown trigger is a definite 400, and the missing-message presets queue nothing", async () => {
    const strict = harness()
    await strict.admin("/settings", { strictMessages: true }, "PUT")
    const missing = await read(
      await strict.app("/v1/send/email", {
        transactional_message_id: "not_a_trigger",
        identifiers: { id: "42" },
        to: "ada@example.com",
      }),
    )
    expect(missing).toMatchObject({
      status: 400,
      body: { meta: { error: "transactional_message_id not found" } },
    })
    expect(await strict.outbox()).toHaveLength(0)
    for (const preset of ["transactional_message_missing", "transactional_404"]) {
      const { runtime, failure, processor, outbox } = harness()
      runtime.applyPreset(preset, "default", { count: 1 })
      const error = await failure(processor())
      expect(error).toBeInstanceOf(CustomerIoTransactionalError)
      expect(error.ambiguous).toBe(false)
      expect(error.reason).toBe("trigger_name_missing")
      expect(await outbox()).toHaveLength(0)
    }
  })

  test("8. identifiers.id with no profile creates a minimal one and keeps the literal recipient", async () => {
    const { app, admin, outbox } = harness()
    const queued = await read(
      await app("/v1/send/email", {
        transactional_message_id: "acme_welcome",
        identifiers: { id: "99" },
        to: "ada@example.com",
      }),
    )
    expect(queued.status).toBe(200)
    const profile = await admin<Profile>("/profiles/99")
    expect(profile.email).toBeNull()
    expect(profile.traits).toEqual({})
    expect((await outbox())[0]).toMatchObject({ to: "ada@example.com", identifiers: { id: "99" } })
  })

  test("9. unsubscribed and channel-off profiles are suppressed unless send_to_unsubscribed", async () => {
    const { cdp, app, outbox } = harness()
    await cdp("/v1/identify", {
      userId: "42",
      traits: {
        email: "ada@example.com",
        unsubscribed: true,
        cio_subscription_preferences: { channels: { email: false, sms: true } },
      },
    })
    await app("/v1/send/email", {
      transactional_message_id: "acme_welcome",
      identifiers: { id: "42" },
      to: "ada@example.com",
      send_to_unsubscribed: false,
    })
    await cdp("/v1/identify", {
      userId: "7",
      traits: {
        email: "bea@example.com",
        cio_subscription_preferences: { channels: { email: false } },
      },
    })
    await app("/v1/send/email", {
      transactional_message_id: "acme_welcome",
      identifiers: { id: "7" },
      to: "bea@example.com",
      send_to_unsubscribed: false,
    })
    await app("/v1/send/email", {
      transactional_message_id: "acme_welcome",
      identifiers: { id: "7" },
      to: "bea@example.com",
      send_to_unsubscribed: true,
    })
    const rows = await outbox()
    expect(rows.map((row) => [row.identifiers.id, row.state, row.reason])).toEqual([
      ["42", "suppressed", "unsubscribed"],
      ["7", "suppressed", "channel_off"],
      ["7", "pending", null],
    ])
    const suppressed = await read(await app(`/v1/messages/${rows[0]?.id}`, undefined, "GET"))
    expect(suppressed.body).toMatchObject({
      message: { state: "suppressed", status: "suppressed", failure_message: "unsubscribed" },
    })
  })

  test("10. tracked false keeps the original URL; tracked true rewrites, redirects, and counts clicks", async () => {
    const { admin, app, outbox } = harness()
    await admin("/settings", { trackingBase: API }, "PUT")
    await app("/v1/send/email", {
      transactional_message_id: "acme_welcome",
      identifiers: { id: "42" },
      to: "ada@example.com",
      tracked: false,
      message_data: { url: "https://app.example/plain" },
    })
    expect((await outbox())[0]?.links).toEqual(["https://app.example/plain"])
    await app("/v1/send/email", {
      transactional_message_id: "acme_welcome",
      identifiers: { id: "42" },
      to: "ada@example.com",
      tracked: true,
      message_data: { url: "https://app.example/tracked" },
    })
    const tracked = (await outbox())[1]?.links[0] as string
    expect(tracked).toMatch(new RegExp(`^${API}/click/`))
    const follow = await app(new URL(tracked).pathname, undefined, "GET", "")
    expect(follow.status).toBe(302)
    expect(follow.headers.get("location")).toBe("https://app.example/tracked")
    const linkId = tracked.split("/").at(-1) as string
    expect((await app(`/click/${linkId}`, undefined, "POST", "")).status).toBe(200)
    expect((await outbox())[1]?.clicks).toBe(2)
  })

  test("11. retention drops message data publicly, and the journal stores no body or secret", async () => {
    const { admin, app, outbox } = harness()
    const secret = "super-secret-app-key"
    await app(
      "/v1/send/email",
      {
        transactional_message_id: "acme_welcome",
        identifiers: { id: "42" },
        to: "ada@example.com",
        disable_message_retention: true,
        message_data: { note: "TSH 2.1", phone: "+15551212000" },
      },
      "POST",
      secret,
    )
    const [hidden] = await outbox()
    expect(hidden).toMatchObject({ messageData: null, links: [], originalLinks: [] })
    const message = await read(await app(`/v1/messages/${hidden?.id}`, undefined, "GET", secret))
    expect(JSON.stringify(message.body)).not.toContain("message_data")
    expect(JSON.stringify(message.body)).not.toContain("TSH 2.1")
    await admin("/settings", { retainMessageDataForTests: true }, "PUT")
    await app(
      "/v1/send/sms",
      {
        transactional_message_id: "acme_welcome",
        identifiers: { id: "42" },
        to: "+15551212000",
        disable_message_retention: true,
        message_data: { note: "TSH 2.1" },
      },
      "POST",
      secret,
    )
    expect((await outbox("?channel=sms"))[0]?.messageData).toEqual({ note: "TSH 2.1" })
    const sms = (await outbox("?channel=sms"))[0]
    const pub = await read(await app(`/v1/messages/${sms?.id}`, undefined, "GET", secret))
    expect(JSON.stringify(pub.body)).not.toContain("TSH 2.1")
    const journal = JSON.stringify(await admin("/requests"))
    expect(journal).not.toContain("TSH 2.1")
    expect(journal).not.toContain("ada@example.com")
    expect(journal).not.toContain("+15551212000")
    expect(journal).not.toContain(secret)
  })

  test("12. email, SMS, and inbox share the rules and inbox has no to field", async () => {
    const { cdp, app, outbox } = harness()
    await cdp("/v1/identify", {
      userId: "42",
      traits: { cio_subscription_preferences: { channels: { email: false, sms: false } } },
    })
    await app("/v1/send/email", {
      transactional_message_id: "acme_welcome",
      identifiers: { id: "42" },
      to: "ada@example.com",
      send_to_unsubscribed: false,
    })
    await app("/v1/send/sms", {
      transactional_message_id: "acme_welcome",
      identifiers: { id: "42" },
      to: "+16025550100",
      send_to_unsubscribed: false,
    })
    await app("/v1/send/inbox_message", {
      transactional_message_id: "acme_inbox_message",
      identifiers: { id: "42" },
      message_data: { title: "Hello" },
      send_to_unsubscribed: false,
    })
    const rows = await outbox()
    expect(new Set(rows.map((row) => row.id)).size).toBe(3)
    expect(rows.map((row) => [row.channel, row.state])).toEqual([
      ["email", "suppressed"],
      ["sms", "suppressed"],
      ["inbox", "pending"],
    ])
    expect(rows[2]?.to).toBe("42")
    const inbox = await read(await app(`/v1/messages/${rows[2]?.id}`, undefined, "GET"))
    expect(inbox.body).toMatchObject({
      message: { type: "in_app", recipient: null, state: "pending" },
    })
  })

  test("13. the catalog lists every row, omits selected trigger names, and details cover 25", async () => {
    const { admin, app, runtime } = harness()
    const many = Array.from({ length: 200 }, (_, index) => ({
      id: index + 1,
      name: `Row ${index}`,
      trigger_name: `Supplement_Order_${index}`,
    }))
    await admin("/transactional", { messages: many }, "PUT")
    const listed = await read(await app("/v1/transactional", undefined, "GET"))
    expect((listed.body.messages as unknown[]).length).toBe(200)
    const found = await read(await app("/v1/transactional/supplement_order_50", undefined, "GET"))
    expect(found.body).toMatchObject({ message: { id: 51, trigger_name: "Supplement_Order_50" } })
    await admin("/faults", {
      operationId: "ListTransactionalMessages",
      effect: "omit_trigger_names",
      params: { ids: [1, 2] },
      count: 1,
    })
    const partial = await read(await app("/v1/transactional", undefined, "GET"))
    const messages = partial.body.messages as { id: number; trigger_name?: string }[]
    expect(messages.find((row) => row.id === 1)?.trigger_name).toBeUndefined()
    expect(messages.find((row) => row.id === 3)?.trigger_name).toBe("Supplement_Order_2")
    const thirty = Array.from({ length: 30 }, (_, index) => ({
      id: index + 1,
      name: `N ${index}`,
      trigger_name: `name_${index}`,
    }))
    await admin("/transactional", { messages: thirty }, "PUT")
    await admin("/settings", { transactionalListKey: "transactional" }, "PUT")
    runtime.applyPreset("omit_trigger_names", "default", { count: 1 })
    const names = await listTransactionalTriggerNames({
      appApiHost: API,
      appApiKey: APP_KEY,
      fetchImpl: (request) => runtime.fetch(request),
    })
    expect(names.size).toBe(25)
  })

  test("14. deliveries start pending and an admin transition stamps the metric", async () => {
    const { app, admin, outbox } = harness()
    await app("/v1/send/email", {
      transactional_message_id: "acme_welcome",
      identifiers: { id: "42" },
      to: "ada@example.com",
    })
    const [created] = await outbox()
    expect(created?.state).toBe("pending")
    const before = await read(await app(`/v1/messages/${created?.id}`, undefined, "GET"))
    expect(before.body).toMatchObject({
      message: { state: "pending", status: "pending", metrics: {} },
    })
    expect(before.body.message).not.toHaveProperty("failure_message")
    await admin(`/deliveries/${created?.id}`, { state: "delivered" })
    const delivered = await read(await app(`/v1/messages/${created?.id}`, undefined, "GET"))
    expect(delivered.body).toMatchObject({
      message: { state: "delivered", status: "delivered" },
    })
    expect(
      (delivered.body.message as { metrics: { delivered: number } }).metrics.delivered,
    ).toEqual(expect.any(Number))
    expect(delivered.body.message).not.toHaveProperty("failure_message")
    await admin(`/deliveries/${created?.id}`, { state: "bounced" })
    const bounced = await read(await app(`/v1/messages/${created?.id}`, undefined, "GET"))
    expect(bounced.body).toMatchObject({
      message: { state: "bounced", status: "bounced", failure_message: "bounced" },
    })
    const rejected = await admin<{ error?: { message: string } }>(`/deliveries/${created?.id}`, {
      state: "nope",
    })
    expect(rejected.error?.message).toContain("state")
  })

  test("15. a visibility delay hides the message until the namespace clock advances", async () => {
    const { admin, app, outbox } = harness()
    await admin("/settings", { statusVisibleAfterMs: 60_000 }, "PUT")
    await app("/v1/send/email", {
      transactional_message_id: "acme_welcome",
      identifiers: { id: "42" },
      to: "ada@example.com",
    })
    const [row] = await outbox()
    expect((await app(`/v1/messages/${row?.id}`, undefined, "GET")).status).toBe(404)
    await admin("/namespace-clock", { advance: 60_000 })
    expect((await app(`/v1/messages/${row?.id}`, undefined, "GET")).status).toBe(200)
  })

  test("16. definite 400, 401, 403, 404, and 429 responses create no delivery", async () => {
    const bad = harness()
    const twoIds = await read(
      await bad.app("/v1/send/email", {
        transactional_message_id: "acme_welcome",
        identifiers: { id: "42", email: "ada@example.com" },
        to: "ada@example.com",
      }),
    )
    expect(twoIds.status).toBe(400)
    const sms = await read(
      await bad.app("/v1/send/sms", {
        transactional_message_id: "acme_welcome",
        identifiers: { id: "42" },
        to: "5551234",
      }),
    )
    expect(sms).toMatchObject({
      status: 400,
      body: { meta: { error: "to: must be an E.164 phone number" } },
    })
    const anon = await read(
      await bad.app(
        "/v1/send/email",
        {
          transactional_message_id: "acme_welcome",
          identifiers: { id: "42" },
          to: "ada@example.com",
        },
        "POST",
        "",
      ),
    )
    expect(anon).toMatchObject({ status: 401, body: { meta: { error: "Unauthorized request" } } })
    expect(await bad.outbox()).toHaveLength(0)

    const forbidden = harness()
    await forbidden.admin("/faults", {
      operationId: "SendEmail",
      status: 403,
      body: { meta: { error: "forbidden" } },
      count: 1,
    })
    const denied = await forbidden.failure(forbidden.processor())
    expect(denied.ambiguous).toBe(false)
    expect(denied.status).toBe(403)
    expect(await forbidden.outbox()).toHaveLength(0)

    const missing = harness()
    missing.runtime.applyPreset("transactional_404", "default", { count: 1 })
    expect((await missing.failure(missing.processor())).status).toBe(404)
    expect(await missing.outbox()).toHaveLength(0)

    const limited = harness()
    limited.runtime.applyPreset("rate_limited", "default", { count: 1 })
    const preset = await limited.app("/v1/send/email", {
      transactional_message_id: "acme_welcome",
      identifiers: { id: "42" },
      to: "ada@example.com",
    })
    expect(preset.status).toBe(429)
    expect(preset.headers.get("retry-after")).toBe("1")
    expect(await limited.outbox()).toHaveLength(0)

    const dated = harness()
    await dated.admin("/faults", {
      operationId: "SendEmail",
      status: 429,
      headers: { "retry-after": "Wed, 21 Oct 2015 07:28:00 GMT" },
      body: { meta: { error: "rate limit exceeded" } },
      count: 1,
    })
    const httpDate = await dated.app("/v1/send/email", {
      transactional_message_id: "acme_welcome",
      identifiers: { id: "42" },
      to: "ada@example.com",
    })
    expect(httpDate.status).toBe(429)
    expect(httpDate.headers.get("retry-after")).toBe("Wed, 21 Oct 2015 07:28:00 GMT")
    expect(await dated.outbox()).toHaveLength(0)
  })

  test("17. ambiguous failures queue nothing unless the send was accepted first", async () => {
    for (const preset of ["request_timeout_408", "server_error", "send_drop_before_accept"]) {
      const { runtime, failure, processor, outbox } = harness()
      runtime.applyPreset(preset, "default", { count: 1 })
      const error = await failure(processor())
      expect(error.ambiguous).toBe(true)
      expect(await outbox()).toHaveLength(0)
    }
    const unavailable = harness()
    await unavailable.admin("/faults", {
      operationId: "SendEmail",
      status: 503,
      body: { meta: { error: "unavailable" } },
      count: 1,
    })
    expect((await unavailable.failure(unavailable.processor())).ambiguous).toBe(true)
    expect(await unavailable.outbox()).toHaveLength(0)

    const accepted = harness()
    accepted.runtime.applyPreset("accepted_but_500", "default", { count: 1 })
    expect((await accepted.failure(accepted.processor())).ambiguous).toBe(true)
    expect(await accepted.outbox()).toHaveLength(1)

    const dropped = harness()
    dropped.runtime.applyPreset("send_drop_after_accept", "default", { count: 1 })
    const lost = await dropped.failure(dropped.processor())
    expect(lost).toBeInstanceOf(CustomerIoTransactionalError)
    expect(lost.ambiguous).toBe(true)
    expect(lost.status).toBeUndefined()
    expect(await dropped.outbox()).toHaveLength(1)
  })

  test("18. outbox filters find a lost delivery, and a second send is a second delivery", async () => {
    const { app, outbox } = harness()
    const first = await read(
      await app("/v1/send/email", {
        transactional_message_id: "acme_welcome",
        identifiers: { id: "42" },
        to: "Ada@Example.com",
      }),
    )
    const since = Date.now() - 60_000
    const found = await outbox(
      `?userId=42&channel=email&transactional_message_id=acme_welcome&recipient=ada@example.com&deliveryId=${first.body.delivery_id}&since=${since}`,
    )
    expect(found).toHaveLength(1)
    await app("/v1/send/email", {
      transactional_message_id: "acme_welcome",
      identifiers: { id: "42" },
      to: "Ada@Example.com",
    })
    expect(await outbox("?userId=42")).toHaveLength(2)
  })

  test("19. missing keys are 401, and one namespace shares CDP and App API state", async () => {
    const { cdp, app, admin } = harness()
    const cdpDenied = await read(
      await cdp("/v1/identify", { userId: "42", traits: { email: "ada@example.com" } }, ""),
    )
    expect(cdpDenied).toMatchObject({ status: 401, body: { error: "Unauthorized" } })
    expect((await admin<{ profiles: unknown[] }>("/profiles")).profiles).toHaveLength(0)
    await admin(
      "/credentials",
      { credentials: { write_shared: "shared", app_shared: "shared" } },
      "PUT",
    )
    expect(
      (
        await cdp(
          "/v1/identify",
          { userId: "42", traits: { email: "ada@example.com", plan: "pro" } },
          "write_shared",
        )
      ).status,
    ).toBe(200)
    const queued = await read(
      await app(
        "/v1/send/email",
        {
          transactional_message_id: "acme_welcome",
          identifiers: { id: "42" },
          to: "ada@example.com",
        },
        "POST",
        "app_shared",
      ),
    )
    expect(queued.status).toBe(200)
    const profile = await admin<Profile>("/profiles/42?namespace=shared")
    expect(profile.traits.plan).toBe("pro")
    expect(
      (await admin<{ messages: unknown[] }>("/outbox?namespace=shared")).messages,
    ).toHaveLength(1)
    expect((await admin<{ messages: unknown[] }>("/outbox")).messages).toHaveLength(0)
  })

  test("20. namespaces isolate state, faults, and clock offsets, and reset leaves the other", async () => {
    const { admin, cdp, app, runtime } = harness()
    await admin(
      "/credentials",
      { credentials: { write_a: "ns_a", app_a: "ns_a", write_b: "ns_b", app_b: "ns_b" } },
      "PUT",
    )
    await cdp("/v1/identify", { userId: "1", traits: { side: "a" } }, "write_a")
    await cdp("/v1/identify", { userId: "1", traits: { side: "b" } }, "write_b")
    await admin(
      "/transactional?namespace=ns_a",
      { messages: [{ id: 1, trigger_name: "only_a", name: "A" }] },
      "PUT",
    )
    await admin("/settings?namespace=ns_a", { statusVisibleAfterMs: 60_000 }, "PUT")
    await app(
      "/v1/send/email",
      { transactional_message_id: "only_a", identifiers: { id: "1" }, to: "a@example.com" },
      "POST",
      "app_a",
    )
    await app(
      "/v1/send/email",
      { transactional_message_id: "acme_welcome", identifiers: { id: "1" }, to: "b@example.com" },
      "POST",
      "app_b",
    )
    runtime.applyPreset("server_error", "ns_a", { count: 1 })
    await admin("/namespace-clock?namespace=ns_b", { advance: 5_000 })
    const aDelivery = (await admin<{ messages: Delivery[] }>("/outbox?namespace=ns_a")).messages[0]
    expect((await app(`/v1/messages/${aDelivery?.id}`, undefined, "GET", "app_a")).status).toBe(404)
    await admin("/namespace-clock?namespace=ns_a", { advance: 60_000 })
    expect((await app(`/v1/messages/${aDelivery?.id}`, undefined, "GET", "app_a")).status).toBe(200)
    const broken = await app(
      "/v1/send/email",
      { transactional_message_id: "only_a", identifiers: { id: "1" }, to: "a@example.com" },
      "POST",
      "app_a",
    )
    expect(broken.status).toBe(500)
    const healthy = await app(
      "/v1/send/email",
      { transactional_message_id: "acme_welcome", identifiers: { id: "2" }, to: "b@example.com" },
      "POST",
      "app_b",
    )
    expect(healthy.status).toBe(200)
    await admin("/reset?namespace=ns_a", undefined, "POST")
    expect(
      (await admin<{ profiles: unknown[] }>("/profiles?namespace=ns_a")).profiles,
    ).toHaveLength(0)
    expect((await admin<{ messages: unknown[] }>("/outbox?namespace=ns_a")).messages).toHaveLength(
      0,
    )
    expect((await admin<Profile>("/profiles/1?namespace=ns_b")).traits.side).toBe("b")
    expect(
      (await admin<{ messages: Delivery[] }>("/outbox?namespace=ns_b")).messages.length,
    ).toBeGreaterThan(0)
    const clock = await admin<{ clockOffsetMs: number }>("/settings?namespace=ns_b")
    expect(clock.clockOffsetMs).toBe(5_000)
    expect((await admin<{ clockOffsetMs: number }>("/settings?namespace=ns_a")).clockOffsetMs).toBe(
      0,
    )
  })

  test("reporting events reorder, and the signature timestamp follows the wall clock", async () => {
    const { admin, runtime, webhooks } = harness()
    await admin("/clock", { set: 1_000_000_000_000 })
    runtime.applyPreset("webhook_reorder", "default")
    await admin("/reporting-events", { metric: "delivered", userId: "42" })
    await admin("/reporting-events", { metric: "opened", userId: "42" })
    await runtime.webhooks.idle()
    expect(webhooks.map((event) => event.metric)).toEqual(["opened", "delivered"])
    const now = Math.floor(Date.now() / 1000)
    for (const event of webhooks) {
      expect(event.timestamp).toBeGreaterThan(now - 30)
      expect(Math.abs(Number(event.header) - event.timestamp)).toBeLessThan(5)
    }
  })
})
