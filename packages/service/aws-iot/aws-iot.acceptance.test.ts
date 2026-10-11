/**
 * The numbered behaviours of the AWS IoT Core service request, each driven through
 * `test/consumer.ts`: the SigV4-signing fetch publisher and `mqtt@5.16.0` over real TCP and
 * WebSocket listeners on OS-assigned ports. Time only moves through `POST /__admin/clock`.
 */
import { describe, expect, test } from "bun:test"
import type { MqttClient } from "mqtt"
import { type PolicyDocument, ReasonCode, type SettingsPatch } from "./src/index.js"
import { type AwsIotServer, createServer } from "./src/server.js"
import {
  type AuthCallback,
  connackOf,
  connect,
  event,
  type IotHttpConfig,
  inbox,
  publish,
  publishBytes,
  refusalCode,
  signRequest,
  subscribe,
} from "./test/consumer.js"

const REGION = "us-east-1"
const ACCOUNT = "123456789012"
const PUBLISHER = {
  accessKeyId: "fixture-publisher-key",
  secretAccessKey: "fixture-publisher-secret",
}
/** The frozen instant every scenario starts at. */
const T0 = Date.parse("2026-01-01T00:00:00.000Z")

const arn = (kind: "client" | "topic" | "topicfilter", name: string) =>
  `arn:aws:iot:${REGION}:${ACCOUNT}:${kind}/${name}`

/** What the consumer's authorizer returns for a signed-in user: their own topic, nothing else. */
const userPolicy = (user: string): PolicyDocument => ({
  Version: "2012-10-17",
  Statement: [
    { Effect: "Allow", Action: "iot:Connect", Resource: arn("client", `${user}-*`) },
    { Effect: "Allow", Action: "iot:Subscribe", Resource: arn("topicfilter", `user/${user}`) },
    { Effect: "Allow", Action: "iot:Receive", Resource: arn("topic", `user/${user}`) },
  ],
})

const SETTINGS: SettingsPatch = {
  credentials: [
    {
      ...PUBLISHER,
      policyDocuments: [
        {
          Version: "2012-10-17",
          Statement: [
            {
              Effect: "Allow",
              Action: "iot:Publish",
              Resource: [arn("topic", "user/*"), arn("topic", "system/*")],
            },
            { Effect: "Deny", Action: "iot:Publish", Resource: arn("topic", "user/locked") },
          ],
        },
      ],
    },
  ],
  authorizers: [
    {
      username: "alice",
      password: "alice-token",
      principalId: "alice",
      policyDocuments: [userPolicy("alice")],
    },
    {
      username: "bob",
      password: "bob-token",
      principalId: "bob",
      policyDocuments: [userPolicy("bob")],
    },
  ],
}

const as =
  (user: "alice" | "bob"): AuthCallback =>
  () => ({ username: user, password: `${user}-token` })

type Harness = {
  server: AwsIotServer
  http: IotHttpConfig
  open(clientId: string, auth: AuthCallback, transport?: "tcp" | "websocket"): Promise<MqttClient>
  admin(method: string, path: string, body?: unknown): Promise<Response>
  advance(duration: string): Promise<void>
  published(): Promise<{ total: number; publishes: { topic: string; bytes: number }[] }>
}

const withIot = async (
  settings: SettingsPatch,
  run: (harness: Harness) => Promise<void>,
): Promise<void> => {
  const server = await createServer({ settings })
  const clients: MqttClient[] = []
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
      http: { endpoint: server.url, region: REGION, credentials: PUBLISHER },
      admin,
      open: async (clientId, auth, transport = "tcp") => {
        const client = await connect(
          transport === "tcp" ? server.mqttUrl : server.wsUrl,
          clientId,
          auth,
        )
        clients.push(client)
        return client
      },
      advance: async (duration) => {
        await admin("POST", "/clock", { advance: duration })
      },
      published: async () => (await (await admin("GET", "/publishes")).json()) as never,
    })
  } finally {
    for (const client of clients) client.end(true)
    await server.close()
  }
}

/** The reason code an operation was refused with, or `undefined` when it went through. */
const refusal = (attempt: Promise<unknown>): Promise<number | undefined> =>
  attempt.then(() => undefined, refusalCode)

const TRACE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

describe("AWS IoT Core service request", () => {
  test("1. a correctly signed Publish answers the documented success and delivers the exact bytes to authorized matching subscribers", async () => {
    await withIot(SETTINGS, async ({ http, open }) => {
      const alice = await open("alice-phone", as("alice"))
      const bob = await open("bob-phone", as("bob"), "websocket")
      await subscribe(alice, "user:alice")
      await subscribe(bob, "user:bob")

      const envelope = { type: "match_found", text: "héllo ✓ 你好", n: 1 }
      const result = await publish(http, "user:alice", envelope)
      expect(result).toEqual({
        ok: true,
        status: 200,
        errorType: null,
        body: { message: "OK", traceId: expect.stringMatching(TRACE_ID) },
      })
      await inbox(alice).received(1)
      expect(inbox(alice).raw).toHaveLength(1)
      expect(inbox(alice).raw[0]).toMatchObject({ topic: "user/alice", qos: 1 })
      expect(inbox(alice).raw[0]?.payload.equals(Buffer.from(JSON.stringify(envelope)))).toBe(true)

      // Bob's own message arrives next, so alice's never reached him.
      await publish(http, "user:bob", { type: "sentinel" })
      await inbox(bob).received(1)
      expect(inbox(bob).messages).toEqual([{ topic: "user/bob", envelope: { type: "sentinel" } }])
      expect(inbox(alice).raw).toHaveLength(1)
    })
  })

  test("2. bad credentials, bad signatures and forbidden topics fail with the AWS error envelope and deliver nothing", async () => {
    await withIot(SETTINGS, async ({ http, open, server, published }) => {
      const alice = await open("alice-phone", as("alice"))
      await subscribe(alice, "user:alice")
      const envelope = { type: "never-delivered" }
      const forbidden = {
        ok: false,
        status: 403,
        errorType: "ForbiddenException",
        body: { message: "Forbidden", traceId: expect.stringMatching(TRACE_ID) },
      }

      const wrongSecret = {
        ...http,
        credentials: { ...PUBLISHER, secretAccessKey: "not-the-secret" },
      }
      expect(await publish(wrongSecret, "user:alice", envelope)).toEqual(forbidden)
      const unknownKey = { ...http, credentials: { ...PUBLISHER, accessKeyId: "somebody-else" } }
      expect(await publish(unknownKey, "user:alice", envelope)).toEqual(forbidden)
      // Signed for another service or region.
      expect(await publish({ ...http, region: "eu-west-1" }, "user:alice", envelope)).toEqual(
        forbidden,
      )

      const url = new URL(`${server.url}/topics/${encodeURIComponent("user/alice")}?qos=1`)
      const body = new TextEncoder().encode(JSON.stringify(envelope))
      const signed = signRequest(http, "POST", url, body)
      const send = (headers: Record<string, string>, sent: Uint8Array, target = url) =>
        fetch(target, { method: "POST", headers, body: sent as BodyInit })
      // No Authorization at all.
      const unsigned = await send({ "x-amz-date": signed["x-amz-date"] as string }, body)
      expect(unsigned.status).toBe(403)
      expect(unsigned.headers.get("x-amzn-errortype")).toBe("ForbiddenException")
      expect(await unsigned.json()).toEqual({ message: "Forbidden", traceId: expect.any(String) })
      // The signature covers the payload, the query string and the path.
      expect((await send(signed, new TextEncoder().encode('{"type":"tampered"}'))).status).toBe(403)
      expect((await send(signed, body, new URL(`${url.href}&retain=false`))).status).toBe(403)
      expect(
        (
          await send(
            signed,
            body,
            new URL(`${server.url}/topics/${encodeURIComponent("user/bob")}?qos=1`),
          )
        ).status,
      ).toBe(403)
      // The same signed request, untouched, is accepted: the refusals above were the tampering.
      expect((await send(signed, body)).status).toBe(200)
      await inbox(alice).received(1)

      // A valid signature whose identity may not publish to the topic.
      const unauthorized = {
        ok: false,
        status: 401,
        errorType: "UnauthorizedException",
        body: {
          message: "You are not authorized to perform this operation.",
          traceId: expect.stringMatching(TRACE_ID),
        },
      }
      expect(await publish(http, "telemetry:alice", envelope)).toEqual(unauthorized)
      // An explicit Deny overrides the Allow on user/*.
      expect(await publish(http, "user:locked", envelope)).toEqual(unauthorized)

      expect(inbox(alice).raw).toHaveLength(1)
      expect((await published()).total).toBe(1)
    })
  })

  test("3. encoded slash topics and Unicode payloads round-trip; malformed paths, qos and oversized bodies are InvalidRequestException", async () => {
    await withIot({ credentials: [PUBLISHER] }, async ({ http, open, server, published }) => {
      const subscriber = await open("subscriber", () => ({}))
      for (const filter of ["system/client_config", "user/#", "a%2Fb", "raw/+/topic"]) {
        await subscriber.subscribeAsync(filter, { qos: 1 })
      }
      const messages = inbox(subscriber)

      // `system:client_config` is the app's name for `system/client_config`.
      expect(
        (await publish(http, "system:client_config", { type: "config", emoji: "🛰️" })).status,
      ).toBe(200)
      const unicode = new TextEncoder().encode("ünïcödé → 日本語 🚀")
      expect((await publishBytes(http, "user/zoë/straße 1", unicode)).status).toBe(200)
      // Decoded once: `%252F` is the literal text `%2F`, not a level separator.
      const literal = new URL(`${server.url}/topics/a%252Fb?qos=1`)
      const post = (url: URL, body: Uint8Array = new Uint8Array(0)) =>
        fetch(url, {
          method: "POST",
          headers: signRequest(http, "POST", url, body),
          body: body as BodyInit,
        })
      expect((await post(literal, unicode)).status).toBe(200)
      // AWS's own examples also send the slashes unencoded.
      expect(
        (await post(new URL(`${server.url}/topics/raw/unencoded/topic?qos=1`), unicode)).status,
      ).toBe(200)
      // Binary that is not UTF-8, and an empty payload.
      const binary = Uint8Array.of(0xff, 0x00, 0xfe, 0x80)
      expect((await publishBytes(http, "user/binary", binary)).status).toBe(200)
      expect((await publishBytes(http, "user/empty", new Uint8Array(0))).status).toBe(200)

      await messages.received(6)
      expect(messages.raw.map((each) => each.topic)).toEqual([
        "system/client_config",
        "user/zoë/straße 1",
        "a%2Fb",
        "raw/unencoded/topic",
        "user/binary",
        "user/empty",
      ])
      expect(messages.messages[0]?.envelope).toEqual({ type: "config", emoji: "🛰️" })
      expect(messages.raw[1]?.payload.equals(Buffer.from(unicode))).toBe(true)
      expect(messages.raw[4]?.payload.equals(Buffer.from(binary))).toBe(true)
      expect(messages.raw[5]?.payload).toHaveLength(0)

      const invalid = {
        ok: false,
        status: 400,
        errorType: "InvalidRequestException",
        body: { message: "The request is not valid.", traceId: expect.stringMatching(TRACE_ID) },
      }
      const ok = new Uint8Array(1)
      expect(await publishBytes(http, "user/a", ok, { qos: "2" })).toEqual(invalid)
      expect(await publishBytes(http, "user/a", ok, { qos: "one" })).toEqual(invalid)
      expect(await publishBytes(http, "user/a", ok, { qos: "1", retain: "yes" })).toEqual(invalid)
      expect(await publishBytes(http, "user/+", ok)).toEqual(invalid)
      expect(await publishBytes(http, "user/#", ok)).toEqual(invalid)
      expect(await publishBytes(http, "$aws/things/x/shadow/update", ok)).toEqual(invalid)
      // 257 bytes of topic; and 8 forward slashes.
      expect(await publishBytes(http, `user/${"x".repeat(252)}`, ok)).toEqual(invalid)
      expect((await publishBytes(http, `user/${"x".repeat(251)}`, ok)).status).toBe(200)
      expect(await publishBytes(http, "1/2/3/4/5/6/7/8/9", ok)).toEqual(invalid)
      expect((await publishBytes(http, "user/2/3/4/5/6/7/8", ok)).status).toBe(200)
      // 128 KB is accepted, one byte more is not.
      expect((await publishBytes(http, "user/big", new Uint8Array(128 * 1024))).status).toBe(200)
      expect(await publishBytes(http, "user/big", new Uint8Array(128 * 1024 + 1))).toEqual(invalid)
      const malformed = await post(new URL(`${server.url}/topics/user%2Fbad%zz?qos=1`))
      expect(malformed.status).toBe(400)
      expect(malformed.headers.get("x-amzn-errortype")).toBe("InvalidRequestException")

      const wrongVerb = await fetch(`${server.url}/topics/user%2Fa`, { method: "GET" })
      expect(wrongVerb.status).toBe(405)
      expect(wrongVerb.headers.get("x-amzn-errortype")).toBe("MethodNotAllowedException")

      expect((await published()).total).toBe(9)
    })
  })

  test("4a. transport loss keeps authorized subscriptions and queues QoS 1; reconnecting before the session expires delivers them", async () => {
    await withIot(SETTINGS, async ({ http, open, admin, advance }) => {
      const first = await open("alice-phone", as("alice"))
      expect(connackOf(first)?.sessionPresent).toBe(false)
      await subscribe(first, "user:alice")

      const lost = event(first, "close")
      await admin("POST", "/transport/cut", { clientId: "alice-phone" })
      await lost

      const queued = [{ type: "first" }, { type: "second" }]
      for (const each of queued) expect((await publish(http, "user:alice", each)).status).toBe(200)
      // AWS IoT stores QoS 1 messages for a persistent session, and only those.
      const atMostOnce = new TextEncoder().encode('{"type":"qos0"}')
      expect((await publishBytes(http, "user/alice", atMostOnce, { qos: "0" })).status).toBe(200)
      expect(await (await admin("GET", "/clients/alice-phone")).json()).toMatchObject({
        connected: false,
        queued: 2,
        sessionExpiryInterval: 600,
        expiresAt: new Date(T0 + 600_000).toISOString(),
        topics: [{ topicFilter: "user/alice", qos: 1 }],
      })

      await advance("599s")
      await admin("POST", "/transport/restore", { clientId: "alice-phone" })
      const second = await open("alice-phone", as("alice"))
      expect(connackOf(second)?.sessionPresent).toBe(true)
      await inbox(second).received(2)
      expect(inbox(second).messages.map((each) => each.envelope)).toEqual(queued)
      expect(inbox(second).raw.every((each) => each.qos === 1)).toBe(true)
    })
  })

  test("4b. after the session expires its subscriptions and queued messages are gone; the account quota caps the expiry", async () => {
    await withIot(SETTINGS, async ({ http, open, admin, advance, server }) => {
      const first = await open("alice-phone", as("alice"))
      await subscribe(first, "user:alice")
      const lost = event(first, "close")
      await admin("POST", "/transport/cut", { clientId: "alice-phone" })
      await lost
      await publish(http, "user:alice", { type: "lost" })

      await advance("600s")
      expect(await (await admin("GET", "/clients")).json()).toEqual({ clients: [] })
      await admin("POST", "/transport/restore")
      const second = await open("alice-phone", as("alice"))
      expect(connackOf(second)?.sessionPresent).toBe(false)
      await subscribe(second, "user:alice")
      await publish(http, "user:alice", { type: "fresh" })
      await inbox(second).received(1)
      expect(inbox(second).messages.map((each) => each.envelope)).toEqual([{ type: "fresh" }])

      // A longer interval than the account allows (one hour by default) is adjusted, and the
      // CONNACK says so.
      const long = await connect(server.mqttUrl, "alice-tablet", as("alice"), {
        properties: { sessionExpiryInterval: 86_400 },
      })
      expect(connackOf(long)?.properties?.sessionExpiryInterval).toBe(3600)
      const gone = event(long, "close")
      await admin("POST", "/transport/cut", { clientId: "alice-tablet" })
      await gone
      expect(await (await admin("GET", "/clients/alice-tablet")).json()).toMatchObject({
        expiresAt: new Date(T0 + 600_000 + 3_600_000).toISOString(),
      })
      await advance("3599s")
      expect(
        ((await (await admin("GET", "/clients")).json()) as { clients: unknown[] }).clients,
      ).toHaveLength(2)
      await advance("1s")
      expect(
        (
          (await (await admin("GET", "/clients")).json()) as { clients: { clientId: string }[] }
        ).clients.map((each) => each.clientId),
      ).toEqual(["alice-phone"])
    })
  })

  test("5. the authorizer's policy denies subscriptions outside it, and simultaneous clients cannot take each other's sessions or messages", async () => {
    const settings: SettingsPatch = {
      ...SETTINGS,
      authorizers: [
        ...(SETTINGS.authorizers ?? []),
        {
          // May subscribe to every user's topic, and still only receive its own.
          username: "carol",
          password: "carol-token",
          policyDocuments: [
            {
              Statement: [
                { Effect: "Allow", Action: "iot:Connect", Resource: arn("client", "carol-*") },
                {
                  Effect: "Allow",
                  Action: "iot:Subscribe",
                  Resource: arn("topicfilter", "user/+"),
                },
                { Effect: "Allow", Action: "iot:Receive", Resource: arn("topic", "user/carol") },
              ],
            },
          ],
        },
      ],
    }
    await withIot(settings, async ({ http, open, server }) => {
      const alice = await open("alice-phone", as("alice"))
      const bob = await open("bob-phone", as("bob"), "websocket")
      await subscribe(alice, "user:alice")
      await subscribe(bob, "user:bob")

      // SUBACK 0x87 for anything the policy does not allow, including wildcards over it.
      for (const filter of ["user/bob", "user/+", "user/#", "#", "user/alice/extra"]) {
        expect(await refusal(alice.subscribeAsync(filter, { qos: 1 }))).toBe(
          ReasonCode.NotAuthorized,
        )
      }
      // A device may not publish at all here: PUBACK 0x87, and nothing is routed.
      expect(await refusal(bob.publishAsync("user/alice", "spoof", { qos: 1 }))).toBe(
        ReasonCode.NotAuthorized,
      )
      expect(alice.connected && bob.connected).toBe(true)

      // Bob cannot connect as alice's client id, so he cannot take her session over; nor can
      // anyone with wrong or missing credentials.
      const attempt = (clientId: string, auth: AuthCallback) =>
        refusal(connect(server.mqttUrl, clientId, auth))
      expect(await attempt("alice-phone", as("bob"))).toBe(ReasonCode.NotAuthorized)
      expect(await attempt("alice-phone", () => ({ username: "alice", password: "wrong" }))).toBe(
        ReasonCode.NotAuthorized,
      )
      expect(await attempt("mallory-phone", () => ({}))).toBe(ReasonCode.NotAuthorized)
      expect(alice.connected).toBe(true)

      // Carol holds a subscription that matches everyone's topic; iot:Receive still decides.
      const carol = await open("carol-laptop", () => ({
        username: "carol",
        password: "carol-token",
      }))
      await carol.subscribeAsync("user/+", { qos: 1 })
      await publish(http, "user:alice", { type: "for-alice" })
      await publish(http, "user:bob", { type: "for-bob" })
      await publish(http, "user:carol", { type: "for-carol" })
      await Promise.all([
        inbox(alice).received(1),
        inbox(bob).received(1),
        inbox(carol).received(1),
      ])
      expect(inbox(alice).messages).toEqual([
        { topic: "user/alice", envelope: { type: "for-alice" } },
      ])
      expect(inbox(bob).messages).toEqual([{ topic: "user/bob", envelope: { type: "for-bob" } }])
      expect(inbox(carol).messages).toEqual([
        { topic: "user/carol", envelope: { type: "for-carol" } },
      ])

      // The same user on a second device is a second client id: both stay connected.
      const tablet = await open("alice-tablet", as("alice"))
      expect(connackOf(tablet)?.sessionPresent).toBe(false)
      expect(alice.connected).toBe(true)
      // The same client id again is a takeover: the first connection is told 0x8E.
      const takenOver = event(alice, "disconnect")
      const again = await open("alice-phone", as("alice"))
      expect(((await takenOver) as [{ reasonCode?: number }])[0].reasonCode).toBe(
        ReasonCode.SessionTakenOver,
      )
      expect(connackOf(again)?.sessionPresent).toBe(true)
    })
  })
})
