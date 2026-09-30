import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { request as httpRequest } from "node:http"
import { synthesizeWav } from "./src/index.js"
import { createServer, type TwilioServer } from "./src/server.js"
import {
  isDefiniteDeliveryFailure,
  MockRequestClient,
  memoryDelivery,
  SMS_DELIVERY_UNKNOWN_OUTCOME_MESSAGE,
  SmsChannel,
  TwilioRecordingHttpAdapter,
  TwilioWebhookReceiver,
  UnrecoverableError,
} from "./test/consumer.js"
import { Twilio, validateRequest } from "./test/twilio-sdk.js"

/**
 * The official twilio-node SDK (5.10.0, the version our consumer pins) pointed at the served
 * mock through the G-T1 seam: its own axios `RequestClient`, with hosts rewritten.
 */
const ACCOUNT = "AC44444444444444444444444444444444"
const TOKEN = "sdk-auth-token"
const VERIFY_SERVICE = "VA0123456789abcdef0123456789abcdef"
const CALLER_ID = "+13105550100"
const PUBLIC_BASE = "https://api.acme.example"
const PHONE = "+12025550123"

let server: TwilioServer
let sink: ReturnType<typeof Bun.serve>
const captured: { url: string; signature: string | null; params: Record<string, string> }[] = []
const receiver = new TwilioWebhookReceiver({
  authToken: TOKEN,
  webhookBaseUrl: PUBLIC_BASE,
  callerId: CALLER_ID,
})

beforeAll(async () => {
  sink = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const copy = request.clone()
      captured.push({
        url: new URL(request.url).pathname,
        signature: request.headers.get("x-twilio-signature"),
        params: Object.fromEntries(new URLSearchParams(await copy.text())),
      })
      return receiver.fetch(request)
    },
  })
  server = await createServer({
    app: {
      url: `http://127.0.0.1:${sink.port}`,
      publicBaseUrl: PUBLIC_BASE,
      authToken: TOKEN,
      accountSid: ACCOUNT,
      callerId: CALLER_ID,
    },
    accounts: { [ACCOUNT]: TOKEN },
  })
})

afterAll(async () => {
  await server.close()
  sink.stop(true)
})

const sdk = (token = TOKEN) =>
  new Twilio(ACCOUNT, token, { httpClient: new MockRequestClient(server.url) })

const admin = async (path: string, body?: unknown, method = body === undefined ? "GET" : "POST") =>
  (await (
    await fetch(`${server.url}/__admin${path}`, {
      method,
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  ).json()) as Record<string, unknown>

describe("twilio-node 5.10.0 against the served mock", () => {
  test("verify: verifications.create → code from admin → verificationChecks.create approved", async () => {
    const client = sdk()
    const verification = await client.verify.v2
      .services(VERIFY_SERVICE)
      .verifications.create({ to: PHONE, channel: "sms" })
    expect(verification.sid).toMatch(/^VE[0-9a-f]{32}$/)
    expect(verification.status).toBe("pending")
    expect(verification.accountSid).toBe(ACCOUNT)
    expect(verification.sendCodeAttempts).toHaveLength(1)
    const { code } = (await admin(`/verify/${encodeURIComponent(PHONE)}/latest`)) as {
      code: string
    }
    const wrong = await client.verify.v2.services(VERIFY_SERVICE).verificationChecks.create({
      verificationSid: verification.sid,
      code: code === "000000" ? "111111" : "000000",
    })
    expect(wrong.status).toBe("pending")
    expect(wrong.valid).toBe(false)
    const check = await client.verify.v2
      .services(VERIFY_SERVICE)
      .verificationChecks.create({ to: PHONE, code })
    expect(check.status).toBe("approved")
    expect(check.valid).toBe(true)
    const again = await client.verify.v2
      .services(VERIFY_SERVICE)
      .verificationChecks.create({ verificationSid: verification.sid, code })
      .catch((error: unknown) => error)
    expect(again).toMatchObject({
      status: 404,
      code: 20404,
      moreInfo: "https://www.twilio.com/docs/errors/20404",
    })
  })

  test("lookups.v2.phoneNumbers(...).fetch() maps every field the SDK exposes", async () => {
    const valid = await sdk().lookups.v2.phoneNumbers("+1 (202) 555-0123").fetch()
    expect(valid).toMatchObject({
      callingCountryCode: "1",
      countryCode: "US",
      phoneNumber: PHONE,
      nationalFormat: "(202) 555-0123",
      valid: true,
      validationErrors: [],
      lineTypeIntelligence: null,
    })
    const invalid = await sdk().lookups.v2.phoneNumbers("+15550100").fetch()
    expect(invalid).toMatchObject({
      valid: false,
      validationErrors: ["INVALID_BUT_POSSIBLE"],
      callingCountryCode: null,
    })
    const national = await sdk().lookups.v2.phoneNumbers("02079460123").fetch({ countryCode: "GB" })
    expect(national).toMatchObject({ valid: true, phoneNumber: "+442079460123", countryCode: "GB" })
  })

  test("messages.create returns an SM sid; messages(sid).fetch() reads it back", async () => {
    const client = sdk()
    const message = await client.messages.create({ to: PHONE, from: CALLER_ID, body: "Hello" })
    expect(message.sid).toMatch(/^SM[0-9a-f]{32}$/)
    expect(message.status).toBe("queued")
    expect(message.numSegments).toBe("1")
    expect(message.dateCreated).toBeInstanceOf(Date)
    const fetched = await client.messages(message.sid).fetch()
    expect(fetched.body).toBe("Hello")
    const outbox = (await admin(`/outbox?to=${encodeURIComponent(PHONE)}&kind=sms`))
      .messages as unknown[]
    expect(outbox.length).toBeGreaterThan(0)
  })

  test("a wrong auth token is RestException 401 20003", async () => {
    const error = await sdk("wrong-token")
      .lookups.v2.phoneNumbers(PHONE)
      .fetch()
      .catch((e: unknown) => e)
    expect(error).toMatchObject({ status: 401, code: 20003 })
  })

  test("twilio.validateRequest accepts the mock's inbound SMS signature for the public URL", async () => {
    captured.length = 0
    const result = await admin("/inbound/sms", { from: "+12025550188", body: "Hi there" })
    expect((result.deliveries as { status: number }[])[0]?.status).toBe(200)
    const delivery = captured.find((c) => c.url === "/messaging/inbound/sms")
    expect(delivery?.signature).toBeTruthy()
    expect(
      validateRequest(
        TOKEN,
        delivery?.signature as string,
        `${PUBLIC_BASE}/messaging/inbound/sms`,
        delivery?.params ?? {},
      ),
    ).toBe(true)
    // Against the localhost URL it was posted to, the signature does not verify.
    expect(
      validateRequest(
        TOKEN,
        delivery?.signature as string,
        `http://127.0.0.1:${sink.port}/messaging/inbound/sms`,
        delivery?.params ?? {},
      ),
    ).toBe(false)
    expect(receiver.inbound.some((event) => event.body === "Hi there")).toBe(true)
  })

  test("sms_socket_drop destroys the socket: axios fails and the dispatcher reports an unknown outcome", async () => {
    await admin("/faults", { preset: "sms_socket_drop", count: 1 })
    const channel = new SmsChannel(sdk(), { from: CALLER_ID })
    const delivery = memoryDelivery()
    await expect(
      channel.send(
        { to: PHONE, body: "Reminder", templateId: "appointment.reminder_24h" },
        delivery,
      ),
    ).rejects.toThrow(SMS_DELIVERY_UNKNOWN_OUTCOME_MESSAGE)
    expect(delivery.state?.status).toBe("pending")
  })

  test("a raw WAV upload is served back to the recording adapter over HTTP", async () => {
    const sid = "RE00112233445566778899aabbccddeeff"
    const upload = await fetch(`${server.url}/__admin/recordings/${sid}`, {
      method: "PUT",
      headers: { "content-type": "audio/wav" },
      body: synthesizeWav({ channels: 2, seconds: 0.5 }),
    })
    expect(upload.status).toBe(200)
    const adapter = new TwilioRecordingHttpAdapter({
      accountSid: ACCOUNT,
      authToken: TOKEN,
      apiBaseUrl: server.url,
    })
    const wav = await adapter.download({
      recordingSid: sid,
      recordingUrl: `https://api.twilio.com/2010-04-01/Accounts/${ACCOUNT}/Recordings/${sid}`,
    })
    expect(wav.byteLength).toBe(44 + 8000 * 0.5 * 2 * 2)
    const metadata = await sdk().recordings(sid).fetch()
    expect(metadata.channels).toBe(2)
    expect(await sdk().recordings(sid).remove()).toBe(true)
  })

  test("a request carrying the real Twilio Host header is routed without a prefix", async () => {
    const url = new URL(server.url)
    const response = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = httpRequest(
        {
          host: url.hostname,
          port: url.port,
          path: `/v2/PhoneNumbers/${encodeURIComponent(PHONE)}`,
          headers: {
            host: "lookups.twilio.com",
            authorization: `Basic ${btoa(`${ACCOUNT}:${TOKEN}`)}`,
          },
        },
        (res) => {
          let body = ""
          res.on("data", (chunk) => {
            body += chunk
          })
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body }))
        },
      )
      req.on("error", reject)
      req.end()
    })
    expect(response.status).toBe(200)
    expect(JSON.parse(response.body)).toMatchObject({ phone_number: PHONE, valid: true })
  })
})

describe("twilio-node 5.10.0 served: SMS faults never reach api.twilio.com", () => {
  const body = "Served order\n\nManage: https://app.example.test/orders"
  let served: TwilioServer
  const client = () => new Twilio(ACCOUNT, TOKEN, { httpClient: new MockRequestClient(served.url) })
  const faults = (preset: string, extra: Record<string, unknown> = {}) =>
    fetch(`${served.url}/__admin/faults`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ preset, count: 1, ...extra }),
    })

  beforeAll(async () => {
    served = await createServer({ accounts: { [ACCOUNT]: TOKEN } })
  })
  afterAll(async () => {
    await served.close()
  })

  test("create, faults and the missing sid all settle against the mock", async () => {
    const sdk = client()
    const created = await sdk.messages.create({
      to: PHONE,
      body,
      messagingServiceSid: "MG0123456789abcdef0123456789abcdef",
    })
    expect(created.sid).toMatch(/^SM[0-9a-f]{32}$/)
    expect(created.status).toBe("accepted")
    expect(created.numSegments).toBe("0")
    expect(created.body).toBe(body)
    const queued = await sdk.messages.create({ to: PHONE, from: CALLER_ID, body: "From only" })
    expect(queued.status).toBe("queued")
    expect(queued.from).toBe(CALLER_ID)

    await faults("sms_drop_before_accept")
    const before = await sdk.messages
      .create({ to: PHONE, from: CALLER_ID, body: "before" })
      .catch((error: unknown) => error)
    expect(before).toBeInstanceOf(Error)
    expect(isDefiniteDeliveryFailure(before)).toBe(false)

    await faults("sms_accepted_then_socket_drop")
    const after = await sdk.messages
      .create({
        to: PHONE,
        messagingServiceSid: "MG0123456789abcdef0123456789abcdef",
        body: "after",
      })
      .catch((error: unknown) => error)
    expect(after).toBeInstanceOf(Error)
    expect(isDefiniteDeliveryFailure(after)).toBe(false)

    await faults("sms_4xx")
    const rejected = await sdk.messages
      .create({ to: PHONE, from: CALLER_ID, body: "nope" })
      .catch((error: unknown) => error)
    expect(rejected).toMatchObject({ status: 400, code: 21211 })

    await faults("sms_429")
    const limited = await sdk.messages
      .create({ to: PHONE, from: CALLER_ID, body: "slow" })
      .catch((error: unknown) => error)
    expect(limited).toMatchObject({ status: 429, code: 20429 })
    expect(isDefiniteDeliveryFailure(limited)).toBe(true)

    await faults("sms_5xx")
    const broken = await sdk.messages
      .create({ to: PHONE, from: CALLER_ID, body: "broken" })
      .catch((error: unknown) => error)
    expect(broken).toMatchObject({ status: 500, code: 20500 })

    await faults("sms_missing_sid")
    const missing = await sdk.messages.create({ to: PHONE, from: CALLER_ID, body: "missing" })
    expect(missing.sid).toBeFalsy()
    await faults("sms_missing_sid")
    const channel = new SmsChannel(sdk, { from: CALLER_ID })
    const delivery = memoryDelivery()
    const guarded = await channel
      .send({ to: PHONE, body: "guard", templateId: "appointment.reminder_24h" }, delivery)
      .catch((error: unknown) => error)
    expect(guarded).toBeInstanceOf(UnrecoverableError)
    expect(delivery.state?.status).toBe("pending")

    const outbox = (await (
      await fetch(`${served.url}/__admin/outbox?to=${encodeURIComponent(PHONE)}&kind=sms`)
    ).json()) as { messages: { body: string; sid: string }[] }
    expect(outbox.messages.map((item) => item.body)).toEqual(
      expect.arrayContaining([body, "after", "missing"]),
    )
    expect(outbox.messages.map((item) => item.body)).not.toContain("before")
    const accepted = outbox.messages.find((item) => item.body === "after")
    const fetched = await sdk.messages(accepted?.sid as string).fetch()
    expect(fetched.body).toBe("after")

    const journal = JSON.stringify(
      await (await fetch(`${served.url}/__admin/requests?operationId=CreateMessage`)).json(),
    )
    expect(journal).toContain("CreateMessage")
    expect(journal).toContain(created.sid)
    expect(journal).not.toContain("api.twilio.com")
    expect(journal).not.toContain("Served order")
    expect(journal).not.toContain("app.example.test")
    expect(journal).not.toContain(PHONE)
    expect(journal).not.toContain(TOKEN)
  }, 20_000)
})
