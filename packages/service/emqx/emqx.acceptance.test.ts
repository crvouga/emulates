/**
 * The numbered behaviours of the EMQX service request, each driven through `test/consumer.ts`:
 * `mqtt@5.16.0` over real TCP and WebSocket listeners on OS-assigned ports, and the fetch-only
 * REST publisher. Time only moves through `POST /__admin/clock`.
 */
import { describe, expect, test } from "bun:test"
import { SignJWT } from "jose"
import type { MqttClient } from "mqtt"
import { ReasonCode, type SettingsPatch } from "./src/index.js"
import { createServer, type EmqxServer } from "./src/server.js"
import {
  connackOf,
  connect,
  type EmqxConfig,
  event,
  inbox,
  kickClient,
  type MqttCredentials,
  publishHttp,
  publishMqtt,
  refusalCode,
  subscribe,
} from "./test/consumer.js"

const API_KEY = "fixture-api-key"
const API_SECRET = "fixture-api-secret"
const JWT_SECRET = "fixture-jwt-signing-secret"
const SERVICE: MqttCredentials = { username: "service", password: "fixture-service-password" }
/** The frozen instant every scenario starts at. */
const T0 = Date.parse("2026-01-01T00:00:00.000Z")

/** The consumer's production-style broker: a service user, JWT clients, deny by default. */
const SECURED: SettingsPatch = {
  users: [{ username: "service", password: SERVICE.password as string, superuser: true }],
  jwt: { secret: JWT_SECRET },
  authorization: { noMatch: "deny" },
}

type Harness = {
  server: EmqxServer
  config: EmqxConfig
  /** A consumer connection, closed with the harness. */
  open(
    clientId: string,
    credentials?: MqttCredentials,
    transport?: "tcp" | "websocket",
  ): Promise<MqttClient>
  admin(method: string, path: string, body?: unknown): Promise<Response>
  advance(duration: string): Promise<void>
}

const withBroker = async (
  settings: SettingsPatch,
  run: (harness: Harness) => Promise<void>,
): Promise<void> => {
  const server = await createServer({
    settings: { apiKeys: [{ key: API_KEY, secret: API_SECRET }], ...settings },
  })
  const clients: MqttClient[] = []
  const config: EmqxConfig = {
    mqttUrl: server.mqttUrl,
    apiOrigin: server.url,
    apiKey: API_KEY,
    apiSecret: API_SECRET,
  }
  const admin = (method: string, path: string, body?: unknown) =>
    fetch(`${server.url}/__admin${path}`, {
      method,
      headers: { "content-type": "application/json" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
  try {
    await admin("POST", "/clock", { freeze: true, set: T0 })
    await run({
      server,
      config,
      admin,
      open: async (clientId, credentials = {}, transport = "tcp") => {
        const client = await connect(
          { mqttUrl: transport === "tcp" ? server.mqttUrl : server.wsUrl },
          clientId,
          credentials,
        )
        clients.push(client)
        return client
      },
      advance: async (duration) => {
        await admin("POST", "/clock", { advance: duration })
      },
    })
  } finally {
    for (const client of clients) client.end(true)
    await server.close()
  }
}

/** A consumer token: HS256, expiring `ttlSeconds` after the frozen instant. */
const token = (acl: unknown, ttlSeconds = 300, secret = JWT_SECRET): Promise<string> =>
  new SignJWT({ acl })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setExpirationTime(T0 / 1000 + ttlSeconds)
    .sign(new TextEncoder().encode(secret))

/** The reason code an operation was refused with, or `undefined` when it went through. */
const refusal = (attempt: Promise<unknown>): Promise<number | undefined> =>
  attempt.then(() => undefined, refusalCode)

describe("EMQX service request", () => {
  test("1. MQTT and authenticated HTTP publishes deliver the exact payload at QoS 1 to matching subscriptions only", async () => {
    await withBroker({}, async ({ config, open }) => {
      const subscriber = await open("subscriber")
      const messages = inbox(subscriber)
      await subscribe(subscriber, "space:example")
      const bystander = await open("bystander")
      const others = inbox(bystander)
      await subscribe(bystander, "space:other")
      const publisher = await open("publisher")

      const overMqtt = { type: "move", text: "héllo ✓", nested: { n: 1 } }
      await publishMqtt(publisher, "space:example", overMqtt)
      const overHttp = { type: "state", text: "from the worker" }
      expect(await publishHttp(config, "space:example", overHttp)).toMatchObject({
        ok: true,
        status: 200,
        body: { id: expect.stringMatching(/^[0-9A-F]{32}$/) },
      })
      await messages.received(2)
      expect(
        messages.raw.map((each) => [each.topic, each.qos, each.payload.toString("utf8")]),
      ).toEqual([
        ["space:example", 1, JSON.stringify(overMqtt)],
        ["space:example", 1, JSON.stringify(overHttp)],
      ])

      // The other topic's subscriber sees its own message next, so nothing leaked before it.
      await publishMqtt(publisher, "space:other", { type: "sentinel" })
      await others.received(1)
      expect(others.messages).toEqual([{ topic: "space:other", envelope: { type: "sentinel" } }])
      expect(messages.raw).toHaveLength(2)
    })
  })

  test("2. a JWT granting one subscription allows it, denies other topics and publishes, and bad tokens are rejected", async () => {
    await withBroker(SECURED, async ({ config, open, server }) => {
      const jwt = await token({ sub: ["user:example"] })
      const device = await open("device-1", { username: "jwt", password: jwt })
      const messages = inbox(device)
      await subscribe(device, "user:example")

      // SUBACK and PUBACK 0x87 Not authorized: `authorization.deny_action = ignore`.
      expect(await refusal(subscribe(device, "user:other"))).toBe(ReasonCode.NotAuthorized)
      expect(await refusal(publishMqtt(device, "user:example", { type: "spoof" }))).toBe(
        ReasonCode.NotAuthorized,
      )
      expect(device.connected).toBe(true)

      // The service user is not bound by a token ACL.
      const service = await open("backend", SERVICE)
      await publishMqtt(service, "user:other", { type: "not-for-device" })
      await publishMqtt(service, "user:example", { type: "for-device" })
      await messages.received(1)
      expect(messages.messages).toEqual([
        { topic: "user:example", envelope: { type: "for-device" } },
      ])
      expect(await publishHttp(config, "user:example", { type: "http" })).toMatchObject({
        status: 200,
      })
      await messages.received(2)
      expect(messages.raw).toHaveLength(2)

      const attempt = (password: string, username = "jwt") =>
        refusal(connect({ mqttUrl: server.mqttUrl }, "device-2", { username, password }))
      // A token that does not verify is passed over by the authenticator, and nobody else
      // accepts it: CONNACK 0x87. A verified token past `exp` is refused outright: 0x86.
      expect(await attempt(await token({ sub: ["user:example"] }, 300, "another-secret"))).toBe(
        ReasonCode.NotAuthorized,
      )
      expect(await attempt("not-a-token")).toBe(ReasonCode.NotAuthorized)
      expect(await attempt(await token({ sub: ["user:example"] }, 0))).toBe(
        ReasonCode.BadUserNameOrPassword,
      )
      expect(await attempt(await token({ sub: ["user:example"] }, -60))).toBe(
        ReasonCode.BadUserNameOrPassword,
      )
      expect(await attempt("wrong-password", "service")).toBe(ReasonCode.BadUserNameOrPassword)
    })
  })

  test("3a. a transport outage keeps subscriptions and queues QoS 1; reconnecting before expiry drains the queue", async () => {
    await withBroker({}, async ({ config, open, admin, advance }) => {
      const first = await open("device-1")
      expect(connackOf(first)?.sessionPresent).toBe(false)
      await subscribe(first, "user:example")

      const lost = event(first, "close")
      expect(
        await (await admin("POST", "/transport/cut", { clientId: "device-1" })).json(),
      ).toEqual({
        cut: ["device-1"],
        dropped: 1,
      })
      await lost

      const queued = [{ type: "first" }, { type: "second" }]
      for (const each of queued) {
        expect(await publishHttp(config, "user:example", each)).toMatchObject({ status: 200 })
      }
      expect(await (await admin("GET", "/clients/device-1")).json()).toMatchObject({
        connected: false,
        queued: 2,
        sessionExpiryInterval: 600,
        expiresAt: new Date(T0 + 600_000).toISOString(),
        topics: [{ topicFilter: "user:example", qos: 1 }],
      })

      await advance("599s")
      await admin("POST", "/transport/restore", { clientId: "device-1" })
      const second = await open("device-1")
      const messages = inbox(second)
      expect(connackOf(second)?.sessionPresent).toBe(true)
      await messages.received(2)
      expect(messages.messages.map((each) => each.envelope)).toEqual(queued)
      expect(messages.raw.every((each) => each.qos === 1)).toBe(true)
    })
  })

  test("3b. reconnecting after the session expired finds no session and no queued messages", async () => {
    await withBroker({}, async ({ config, open, admin, advance }) => {
      const first = await open("device-1")
      await subscribe(first, "user:example")
      const lost = event(first, "close")
      await admin("POST", "/transport/cut", { clientId: "device-1" })
      await lost
      expect(await publishHttp(config, "user:example", { type: "lost" })).toMatchObject({
        status: 200,
      })

      await advance("600s")
      expect(await (await admin("GET", "/clients")).json()).toEqual({ clients: [] })
      await admin("POST", "/transport/restore", { clientId: "device-1" })
      const second = await open("device-1")
      const messages = inbox(second)
      expect(connackOf(second)?.sessionPresent).toBe(false)
      // No subscription survived: EMQX reports no matching subscribers.
      expect(await publishHttp(config, "user:example", { type: "nobody" })).toMatchObject({
        status: 202,
        body: { reason_code: 16, message: "no_matching_subscribers" },
      })
      await subscribe(second, "user:example")
      await publishHttp(config, "user:example", { type: "fresh" })
      await messages.received(1)
      expect(messages.messages.map((each) => each.envelope)).toEqual([{ type: "fresh" }])
    })
  })

  test("4. a new connection with a connected client id disconnects the old connection", async () => {
    await withBroker({}, async ({ config, open }) => {
      const first = await open("device-1")
      const stale = inbox(first)
      await subscribe(first, "user:example")
      const takenOver = event(first, "disconnect")
      const second = await open("device-1")
      const messages = inbox(second)
      const [packet] = (await takenOver) as [{ reasonCode?: number }]
      expect(packet.reasonCode).toBe(ReasonCode.SessionTakenOver)
      expect(connackOf(second)?.sessionPresent).toBe(true)

      await publishHttp(config, "user:example", { type: "after-takeover" })
      await messages.received(1)
      expect(messages.messages).toHaveLength(1)
      expect(stale.raw).toEqual([])
    })
  })

  test("5. DELETE disconnects a live client and answers success; an unknown client is 404; reconnect and re-subscribe work", async () => {
    await withBroker({}, async ({ config, open, admin }) => {
      const first = await open("device/1 with space")
      await subscribe(first, "user:example")
      const kicked = event(first, "disconnect")
      expect(await kickClient(config, "device/1 with space")).toBe(true)
      const [packet] = (await kicked) as [{ reasonCode?: number }]
      expect(packet.reasonCode).toBe(ReasonCode.AdministrativeAction)
      expect(await (await admin("GET", "/clients")).json()).toEqual({ clients: [] })

      expect(await kickClient(config, "device/1 with space")).toBe(false)
      const unknown = await fetch(`${config.apiOrigin}/api/v5/clients/nobody`, {
        method: "DELETE",
        headers: { authorization: `Basic ${btoa(`${API_KEY}:${API_SECRET}`)}` },
      })
      expect(unknown.status).toBe(404)
      expect(await unknown.json()).toEqual({
        code: "CLIENTID_NOT_FOUND",
        message: "Client ID not found",
      })

      // The kick discarded the session, so the client subscribes again.
      const second = await open("device/1 with space")
      const messages = inbox(second)
      expect(connackOf(second)?.sessionPresent).toBe(false)
      await subscribe(second, "user:example")
      await publishHttp(config, "user:example", { type: "back" })
      await messages.received(1)
      expect(messages.messages.map((each) => each.envelope)).toEqual([{ type: "back" }])
    })
  })

  test("6. unsubscribe stops deliveries; closing an instance closes listeners and clients; a fresh instance holds nothing", async () => {
    let mqttUrl = ""
    let apiOrigin = ""
    await withBroker({}, async ({ config, open, server }) => {
      mqttUrl = server.mqttUrl
      apiOrigin = server.url
      const client = await open("device-1")
      const messages = inbox(client)
      await subscribe(client, "user:example")
      await subscribe(client, "user:kept")
      await client.unsubscribeAsync("user:example")
      expect(await publishHttp(config, "user:example", { type: "unsubscribed" })).toMatchObject({
        status: 202,
      })
      await publishHttp(config, "user:kept", { type: "kept" })
      await messages.received(1)
      expect(messages.messages.map((each) => each.envelope)).toEqual([{ type: "kept" }])

      const overWebSocket = await open("device-2", {}, "websocket")
      const closed = [event(client, "close"), event(overWebSocket, "close")]
      await server.close()
      await Promise.all(closed)
      expect(client.connected).toBe(false)
      expect(overWebSocket.connected).toBe(false)
    })
    // Every listener is gone.
    const refused = (attempt: Promise<unknown>) =>
      attempt.then(
        () => "reachable",
        () => "refused",
      )
    expect(await refused(connect({ mqttUrl }, "device-1"))).toBe("refused")
    expect(await refused(fetch(`${apiOrigin}/__admin/health`))).toBe("refused")

    await withBroker({}, async ({ config, open, admin }) => {
      expect(await (await admin("GET", "/clients")).json()).toEqual({ clients: [] })
      expect(await (await admin("GET", "/publishes")).json()).toEqual({ total: 0, publishes: [] })
      const client = await open("device-1")
      const messages = inbox(client)
      expect(connackOf(client)?.sessionPresent).toBe(false)
      expect(await publishHttp(config, "user:kept", { type: "nobody" })).toMatchObject({
        status: 202,
      })
      await subscribe(client, "user:kept")
      await publishHttp(config, "user:kept", { type: "first-here" })
      await messages.received(1)
      expect(messages.messages.map((each) => each.envelope)).toEqual([{ type: "first-here" }])
    })
  })

  test("7. missing or wrong HTTP credentials are rejected, malformed publishes get the documented error, and raw malformed payloads reach the consumer's parser", async () => {
    await withBroker({}, async ({ config, open, admin }) => {
      const client = await open("device-1")
      const messages = inbox(client)
      await subscribe(client, "user:example")
      const post = (headers: Record<string, string>, body: string) =>
        fetch(`${config.apiOrigin}/api/v5/publish`, { method: "POST", headers, body })
      const good = {
        authorization: `Basic ${btoa(`${API_KEY}:${API_SECRET}`)}`,
        "content-type": "application/json",
      }
      const valid = JSON.stringify({ topic: "user:example", payload: "{}", qos: 1, retain: false })

      const missing = await post({ "content-type": "application/json" }, valid)
      expect(missing.status).toBe(401)
      expect(missing.headers.get("www-authenticate")).toBe('Basic Realm="emqx-dashboard"')
      expect(await missing.json()).toEqual({
        code: "AUTHORIZATION_HEADER_ERROR",
        message: "Support authorization: basic/bearer ",
      })
      const wrong = await post(
        { ...good, authorization: `Basic ${btoa(`${API_KEY}:nope`)}` },
        valid,
      )
      expect(wrong.status).toBe(401)
      expect(await wrong.json()).toEqual({
        code: "BAD_API_KEY_OR_SECRET",
        message: "Check api_key/api_secret",
      })
      expect(
        await publishHttp({ ...config, apiSecret: "nope" }, "user:example", { type: "x" }),
      ).toMatchObject({
        ok: false,
        status: 401,
      })

      const noTopic = await post(good, JSON.stringify({ payload: "{}" }))
      expect(noTopic.status).toBe(400)
      expect(await noTopic.json()).toMatchObject({ code: "BAD_REQUEST" })
      const objectPayload = await post(
        good,
        JSON.stringify({ topic: "user:example", payload: { a: 1 } }),
      )
      expect(objectPayload.status).toBe(400)
      expect(await objectPayload.json()).toMatchObject({ code: "BAD_REQUEST" })
      const qosOutOfRange = await post(
        good,
        JSON.stringify({ topic: "user:example", payload: "{}", qos: 3 }),
      )
      expect(qosOutOfRange.status).toBe(400)
      const wildcard = await post(good, JSON.stringify({ topic: "user/#", payload: "{}" }))
      expect(wildcard.status).toBe(400)
      expect(await wildcard.json()).toEqual({ reason_code: 144, message: "topic_name_invalid" })
      const notJson = await post(good, "{topic:")
      expect(notJson.status).toBe(400)
      expect(await notJson.json()).toEqual({
        code: "BAD_REQUEST",
        message: "Invalid json message received",
      })
      const wrongType = await post({ ...good, "content-type": "text/plain" }, valid)
      expect(wrongType.status).toBe(415)
      // Nothing above reached the subscriber.
      expect(await (await admin("GET", "/publishes")).json()).toMatchObject({ total: 0 })

      // A payload that is a string but not the JSON the app expects, through the vendor API…
      const text = await post(
        good,
        JSON.stringify({ topic: "user:example", payload: "{not json", qos: 1 }),
      )
      expect(text.status).toBe(200)
      // …and raw bytes that are not even UTF-8, through the test control.
      const raw = await admin("POST", "/inject", {
        topic: "user:example",
        payloadBase64: btoa(String.fromCharCode(0xff, 0xfe, 0x00, 0x7b)),
      })
      expect(await raw.json()).toEqual({ matched: 1 })
      await messages.received(2)
      expect(messages.malformed).toBe(2)
      expect(messages.messages).toEqual([])
      expect(messages.raw[0]?.payload.toString("utf8")).toBe("{not json")
      expect([...(messages.raw[1]?.payload ?? [])]).toEqual([0xff, 0xfe, 0x00, 0x7b])
    })
  })

  test("8. TCP and WebSocket subscribers share one broker's state and behaviour", async () => {
    await withBroker(SECURED, async ({ config, open, admin }) => {
      const jwt = await token({ sub: ["space:example"] })
      const overTcp = await open("tcp-device", { username: "jwt", password: jwt }, "tcp")
      const overWebSocket = await open("ws-device", { username: "jwt", password: jwt }, "websocket")
      const tcpMessages = inbox(overTcp)
      const wsMessages = inbox(overWebSocket)
      await subscribe(overTcp, "space:example")
      await subscribe(overWebSocket, "space:example")
      // The same ACL binds both transports.
      expect(await refusal(subscribe(overWebSocket, "space:other"))).toBe(ReasonCode.NotAuthorized)
      expect(await refusal(subscribe(overTcp, "space:other"))).toBe(ReasonCode.NotAuthorized)

      const service = await open("backend", SERVICE, "websocket")
      await publishMqtt(service, "space:example", { type: "from-websocket" })
      await publishHttp(config, "space:example", { type: "from-http" })
      await Promise.all([tcpMessages.received(2), wsMessages.received(2)])
      const expected = [{ type: "from-websocket" }, { type: "from-http" }]
      expect(tcpMessages.messages.map((each) => each.envelope)).toEqual(expected)
      expect(wsMessages.messages.map((each) => each.envelope)).toEqual(expected)

      const { clients } = (await (await admin("GET", "/clients")).json()) as {
        clients: { clientId: string; transport: string; connected: boolean }[]
      }
      expect(clients.map((each) => [each.clientId, each.transport, each.connected])).toEqual([
        ["tcp-device", "tcp", true],
        ["ws-device", "websocket", true],
        ["backend", "websocket", true],
      ])

      // A session opened over TCP is taken over, and resumed, over WebSocket.
      const takenOver = event(overTcp, "disconnect")
      const moved = await open("tcp-device", { username: "jwt", password: jwt }, "websocket")
      await takenOver
      expect(connackOf(moved)?.sessionPresent).toBe(true)
      const movedMessages = inbox(moved)
      await publishHttp(config, "space:example", { type: "after-move" })
      await movedMessages.received(1)
      expect(movedMessages.messages.map((each) => each.envelope)).toEqual([{ type: "after-move" }])
    })
  })
})
