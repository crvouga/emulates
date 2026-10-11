/**
 * SDK drop-in. HTTP: AWS's own `@aws-sdk/client-iot-data-plane` and `aws4fetch`, whose signers
 * are the reference the emulator's SigV4 verifier is held to. MQTT: the exact `mqtt` version
 * the consumer pins, over both transports.
 */
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import {
  InvalidRequestException,
  IoTDataPlaneClient,
  PublishCommand,
  UnauthorizedException,
} from "@aws-sdk/client-iot-data-plane"
import { AwsClient } from "aws4fetch"
import type { MqttClient } from "mqtt"
import { type PolicyDocument, ReasonCode } from "./src/index.js"
import { type AwsIotServer, createServer } from "./src/server.js"
import { connackOf, connect, event, inbox, refusalCode } from "./test/consumer.js"

const CREDENTIALS = { accessKeyId: "fixture-sdk-key", secretAccessKey: "fixture-sdk-secret" }
const TEMPORARY = {
  accessKeyId: "fixture-temporary-key",
  secretAccessKey: "fixture-temporary-secret",
  sessionToken: "fixture-session-token",
}
const ONLY_USER_TOPICS: PolicyDocument = {
  Statement: [
    {
      Effect: "Allow",
      Action: "iot:Publish",
      Resource: "arn:aws:iot:us-east-1:123456789012:topic/user/*",
    },
  ],
}

const withServer = async (
  run: (
    server: AwsIotServer,
    open: (...args: Parameters<typeof connect>) => Promise<MqttClient>,
  ) => Promise<void>,
): Promise<void> => {
  const server = await createServer({
    settings: {
      credentials: [{ ...CREDENTIALS, policyDocuments: [ONLY_USER_TOPICS] }, TEMPORARY],
    },
  })
  const clients: MqttClient[] = []
  try {
    await run(server, async (...args) => {
      const client = await connect(...args)
      clients.push(client)
      return client
    })
  } finally {
    for (const client of clients) client.end(true)
    await server.close()
  }
}

const installed = (name: string): string =>
  JSON.parse(readFileSync(createRequire(import.meta.url).resolve(`${name}/package.json`), "utf8"))
    .version

describe("@aws-sdk/client-iot-data-plane", () => {
  const sdk = (server: AwsIotServer, credentials: typeof CREDENTIALS = CREDENTIALS) =>
    new IoTDataPlaneClient({
      region: "us-east-1",
      endpoint: server.url,
      credentials,
      maxAttempts: 1,
    })

  test("PublishCommand is signed the way the emulator verifies, for plain, nested and Unicode topics", async () => {
    await withServer(async (server, open) => {
      const subscriber = await open(server.mqttUrl, "subscriber")
      await subscriber.subscribeAsync("user/#", { qos: 1 })
      const client = sdk(server)
      const topics = [
        "user/example",
        "user/a/b/c",
        "user/zoë straße/日本語",
        "user/literal%2Fpercent",
        "user/a&b=c d!(e)*",
      ]
      for (const topic of topics) {
        const output = await client.send(
          new PublishCommand({
            topic,
            qos: 1,
            payload: new TextEncoder().encode(`{"type":"sdk","topic":${JSON.stringify(topic)}}`),
            contentType: "application/json",
            responseTopic: "user/replies",
            messageExpiry: 60,
            payloadFormatIndicator: "UTF8_DATA",
            correlationData: btoa("id-1"),
            userProperties: JSON.stringify([{ deviceName: "alpha" }, { deviceCnt: "45" }]),
          }),
        )
        expect(output.$metadata.httpStatusCode).toBe(200)
      }
      await inbox(subscriber).received(topics.length)
      expect(inbox(subscriber).raw.map((each) => each.topic)).toEqual(topics)
      expect(inbox(subscriber).messages.map((each) => each.envelope.topic)).toEqual(topics)
    })
  })

  test("MQTT 5 properties set over HTTP reach the subscriber", async () => {
    await withServer(async (server, open) => {
      const subscriber = await open(server.wsUrl, "subscriber")
      const properties = new Promise<unknown>((resolve) => {
        subscriber.on("message", (_topic, _payload, packet) => resolve(packet.properties))
      })
      await subscriber.subscribeAsync("user/example", { qos: 1 })
      await sdk(server).send(
        new PublishCommand({
          topic: "user/example",
          qos: 1,
          payload: "{}",
          contentType: "application/json",
          responseTopic: "user/replies",
          messageExpiry: 0,
          payloadFormatIndicator: "UTF8_DATA",
          correlationData: btoa("id-1"),
          userProperties: JSON.stringify([{ deviceName: "alpha" }, { deviceCnt: "45" }]),
        }),
      )
      expect(await properties).toEqual({
        contentType: "application/json",
        responseTopic: "user/replies",
        // "If the interval is set to 0 from the client side, it will be adjusted to 1."
        messageExpiryInterval: 1,
        payloadFormatIndicator: true,
        correlationData: Buffer.from("id-1"),
        userProperties: { deviceName: "alpha", deviceCnt: "45" },
      })
    })
  })

  test("the SDK turns the emulator's error envelopes into its typed exceptions", async () => {
    await withServer(async (server) => {
      const unauthorized = await sdk(server)
        .send(new PublishCommand({ topic: "system/config", payload: "{}" }))
        .catch((error: unknown) => error)
      expect(unauthorized).toBeInstanceOf(UnauthorizedException)
      expect(unauthorized).toMatchObject({
        name: "UnauthorizedException",
        message: "You are not authorized to perform this operation.",
        $metadata: { httpStatusCode: 401 },
      })

      const invalid = await sdk(server)
        .send(new PublishCommand({ topic: "user/+", payload: "{}" }))
        .catch((error: unknown) => error)
      expect(invalid).toBeInstanceOf(InvalidRequestException)
      expect(invalid).toMatchObject({ $metadata: { httpStatusCode: 400 } })

      const forbidden = await sdk(server, { ...CREDENTIALS, secretAccessKey: "wrong" })
        .send(new PublishCommand({ topic: "user/example", payload: "{}" }))
        .catch((error: unknown) => error)
      expect(forbidden).toMatchObject({
        name: "ForbiddenException",
        message: "Forbidden",
        $metadata: { httpStatusCode: 403 },
      })
    })
  })

  test("temporary credentials must carry their session token", async () => {
    await withServer(async (server) => {
      const output = await sdk(server, TEMPORARY).send(
        new PublishCommand({ topic: "anything/at/all", qos: 1, payload: "{}" }),
      )
      expect(output.$metadata.httpStatusCode).toBe(200)
      const { sessionToken: _dropped, ...withoutToken } = TEMPORARY
      const refused = await sdk(server, withoutToken)
        .send(new PublishCommand({ topic: "anything/at/all", payload: "{}" }))
        .catch((error: unknown) => error)
      expect(refused).toMatchObject({ $metadata: { httpStatusCode: 403 } })
    })
  })
})

describe("aws4fetch", () => {
  test("a fetch signed for service iotdata is accepted; signed for another service it is not", async () => {
    expect(installed("aws4fetch")).toBe("1.0.20")
    await withServer(async (server, open) => {
      const subscriber = await open(server.mqttUrl, "subscriber")
      await subscriber.subscribeAsync("user/example", { qos: 1 })
      const url = `${server.url}/topics/${encodeURIComponent("user/example")}?qos=1`
      const body = new TextEncoder().encode('{"type":"aws4fetch"}')
      const signed = (service: string) =>
        new AwsClient({ ...CREDENTIALS, service, region: "us-east-1" }).fetch(url, {
          method: "POST",
          headers: { "content-type": "application/octet-stream" },
          body,
        })
      expect((await signed("iotdata")).status).toBe(200)
      expect((await signed("iot")).status).toBe(403)
      await inbox(subscriber).received(1)
      expect(inbox(subscriber).messages).toEqual([
        { topic: "user/example", envelope: { type: "aws4fetch" } },
      ])
    })
  })
})

test("the consumer's pinned mqtt version is installed", () => {
  expect(installed("mqtt")).toBe("5.16.0")
})

for (const transport of ["tcp", "websocket"] as const) {
  const urlOf = (server: AwsIotServer) => (transport === "tcp" ? server.mqttUrl : server.wsUrl)

  describe(`mqtt@5.16.0 over ${transport}`, () => {
    test("CONNACK carries AWS IoT's properties", async () => {
      await withServer(async (server, open) => {
        const client = await open(urlOf(server), "device")
        expect(connackOf(client)).toMatchObject({
          cmd: "connack",
          sessionPresent: false,
          reasonCode: 0,
          properties: {
            maximumPacketSize: 149_504,
            topicAliasMaximum: 8,
            receiveMaximum: 100,
            maximumQoS: 1,
            retainAvailable: false,
            wildcardSubscriptionAvailable: true,
            subscriptionIdentifiersAvailable: false,
            sharedSubscriptionAvailable: false,
          },
        })
        // The library's default keep alive of 60 s is inside AWS's range: nothing is imposed.
        expect(connackOf(client)?.properties?.serverKeepAlive).toBeUndefined()
        const idle = await open(urlOf(server), "idle", () => ({}), { keepalive: 0 })
        expect(connackOf(idle)?.properties?.serverKeepAlive).toBe(1200)
        const eager = await open(urlOf(server), "eager", () => ({}), { keepalive: 5 })
        expect(connackOf(eager)?.properties?.serverKeepAlive).toBe(30)
      })
    })

    test("publish and subscribe at QoS 0 and 1, wildcards, unsubscribe", async () => {
      await withServer(async (server, open) => {
        const subscriber = await open(urlOf(server), "subscriber")
        const granted = await subscriber.subscribeAsync({
          "sensors/+/temperature": { qos: 1 },
          "raw/#": { qos: 0 },
        })
        expect(granted.map((each) => each.qos)).toEqual([1, 0])
        const publisher = await open(urlOf(server), "publisher")
        const acknowledgements: (number | undefined)[] = []
        publisher.on("packetreceive", (packet) => {
          if (packet.cmd === "puback") acknowledgements.push(packet.reasonCode)
        })
        await publisher.publishAsync("sensors/a/temperature", "21.5", { qos: 1 })
        await publisher.publishAsync("raw/bytes", Buffer.from([0xff, 0x00]), { qos: 1 })
        // AWS IoT acknowledges a publish nobody subscribes to with Success.
        await publisher.publishAsync("nobody/home", "x", { qos: 1 })
        expect(acknowledgements).toEqual([0, 0, 0])
        await inbox(subscriber).received(2)
        expect(inbox(subscriber).raw.map((each) => [each.topic, each.qos])).toEqual([
          ["sensors/a/temperature", 1],
          ["raw/bytes", 0],
        ])
        await subscriber.unsubscribeAsync("raw/#")
        await publisher.publishAsync("raw/bytes", "after", { qos: 1 })
        await publisher.publishAsync("sensors/b/temperature", "last", { qos: 1 })
        await inbox(subscriber).received(3)
        expect(inbox(subscriber).raw.at(-1)?.payload.toString()).toBe("last")
      })
    })

    test("auto-reconnect resumes the persistent session", async () => {
      await withServer(async (server, open) => {
        const client = await open(urlOf(server), "device", () => ({}), { reconnectPeriod: 20 })
        await client.subscribeAsync("t", { qos: 1 })
        const admin = (path: string, body: unknown) =>
          fetch(`${server.url}/__admin${path}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          })
        const offline = event(client, "close")
        await admin("/transport/cut", { clientId: "device" })
        await offline
        await admin("/inject", { topic: "t", payload: '{"type":"while-away"}' })
        const reconnected = new Promise<boolean>((resolve) => {
          client.once("connect", (packet) => resolve(packet.sessionPresent))
        })
        await admin("/transport/restore", { clientId: "device" })
        expect(await reconnected).toBe(true)
        await inbox(client).received(1)
        expect(inbox(client).messages).toEqual([{ topic: "t", envelope: { type: "while-away" } }])
      })
    })

    test("what AWS IoT and the emulator do not support is refused with its reason code", async () => {
      await withServer(async (server, open) => {
        const legacy = connect(urlOf(server), "legacy", () => ({}), { protocolVersion: 4 })
        expect(await legacy.then(() => undefined, refusalCode)).toBe(1)

        // "The client specified a QoS greater than the QoS specified in a Maximum QoS in the CONNACK."
        const client = await open(urlOf(server), "device")
        const refused = event(client, "disconnect")
        client.publish("t", "x", { qos: 2 })
        expect(((await refused) as [{ reasonCode?: number }])[0].reasonCode).toBe(
          ReasonCode.QoSNotSupported,
        )
        // Subscription Identifier Available is 0: DISCONNECT 0xA1.
        const second = await open(urlOf(server), "device-2")
        const identifiers = event(second, "disconnect")
        second.subscribe("t", { qos: 1, properties: { subscriptionIdentifier: 3 } }, () => {})
        expect(((await identifiers) as [{ reasonCode?: number }])[0].reasonCode).toBe(
          ReasonCode.SubscriptionIdentifiersNotSupported,
        )
      })
    })
  })
}
