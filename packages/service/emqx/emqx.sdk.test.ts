/**
 * SDK drop-in: the exact `mqtt` version the consumer pins, pointed at the emulator over both
 * transports it listens on. What the library does with the broker's packets (parsed CONNACK
 * properties, promise rejections, auto-reconnect) is asserted, not the bytes.
 */
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import type { IPublishPacket, MqttClient } from "mqtt"
import { ReasonCode } from "./src/index.js"
import { createServer, type EmqxServer } from "./src/server.js"
import { connackOf, connect, event, inbox, refusalCode } from "./test/consumer.js"

const withServer = async (
  run: (
    server: EmqxServer,
    open: (...args: Parameters<typeof connect>) => Promise<MqttClient>,
  ) => Promise<void>,
): Promise<void> => {
  const server = await createServer()
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

const admin = async (server: EmqxServer, method: string, path: string, body?: unknown) =>
  (
    await fetch(`${server.url}/__admin${path}`, {
      method,
      headers: { "content-type": "application/json" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
  ).json()

test("the consumer's pinned mqtt version is installed", () => {
  const manifest = createRequire(import.meta.url).resolve("mqtt/package.json")
  expect(JSON.parse(readFileSync(manifest, "utf8")).version).toBe("5.16.0")
})

for (const transport of ["tcp", "websocket"] as const) {
  const urlOf = (server: EmqxServer) => (transport === "tcp" ? server.mqttUrl : server.wsUrl)

  describe(`mqtt@5.16.0 over ${transport}`, () => {
    test("CONNACK carries the properties the library reads", async () => {
      await withServer(async (server, open) => {
        const client = await open({ mqttUrl: urlOf(server) }, "device")
        expect(connackOf(client)).toMatchObject({
          cmd: "connack",
          sessionPresent: false,
          reasonCode: 0,
          properties: {
            maximumPacketSize: 1_048_576,
            topicAliasMaximum: 65_535,
            receiveMaximum: 32,
            maximumQoS: 1,
            retainAvailable: false,
            wildcardSubscriptionAvailable: true,
            subscriptionIdentifiersAvailable: true,
            sharedSubscriptionAvailable: false,
          },
        })
      })
    })

    test("QoS 0 and 1 publishes arrive with their properties and bytes intact", async () => {
      await withServer(async (server, open) => {
        const subscriber = await open({ mqttUrl: urlOf(server) }, "subscriber")
        const packets: IPublishPacket[] = []
        subscriber.on("message", (_topic, _payload, packet) => packets.push(packet))
        const granted = await subscriber.subscribeAsync(
          { "sensors/+/temperature": { qos: 1 }, "raw/#": { qos: 0 } },
          { properties: { subscriptionIdentifier: 7 } },
        )
        expect(granted.map((each) => [each.topic, each.qos])).toEqual([
          ["sensors/+/temperature", 1],
          ["raw/#", 0],
        ])

        const publisher = await open({ mqttUrl: urlOf(server) }, "publisher")
        // `publishAsync` resolves with the PUBLISH it sent; the PUBACKs are read off the wire.
        const acknowledgements: (number | undefined)[] = []
        publisher.on("packetreceive", (packet) => {
          if (packet.cmd === "puback") acknowledgements.push(packet.reasonCode)
        })
        const bytes = Buffer.from([0x00, 0xff, 0x10, 0x80])
        await publisher.publishAsync("raw/bytes", bytes, { qos: 1 })
        await publisher.publishAsync("sensors/a/temperature", "21.5", {
          qos: 1,
          properties: {
            contentType: "text/plain",
            responseTopic: "replies/a",
            correlationData: Buffer.from("id-1"),
            userProperties: { unit: "celsius" },
            payloadFormatIndicator: true,
          },
        })
        await publisher.publishAsync("sensors/a/temperature", "fire-and-forget", { qos: 0 })
        // Nobody listens: PUBACK 0x10, which the library does not treat as a failure.
        await publisher.publishAsync("nobody/home", "x", { qos: 1 })
        expect(acknowledgements).toEqual([0, 0, ReasonCode.NoMatchingSubscribers])

        await inbox(subscriber).received(3)
        expect(packets.map((each) => [each.topic, each.qos, each.retain, each.dup])).toEqual([
          ["raw/bytes", 0, false, false],
          ["sensors/a/temperature", 1, false, false],
          ["sensors/a/temperature", 0, false, false],
        ])
        expect(Buffer.from(packets[0]?.payload ?? "").equals(bytes)).toBe(true)
        expect(packets[1]?.properties).toMatchObject({
          contentType: "text/plain",
          responseTopic: "replies/a",
          correlationData: Buffer.from("id-1"),
          userProperties: { unit: "celsius" },
          payloadFormatIndicator: true,
          subscriptionIdentifier: 7,
        })

        await subscriber.unsubscribeAsync("raw/#")
        await publisher.publishAsync("raw/bytes", "after", { qos: 1 })
        await publisher.publishAsync("sensors/b/temperature", "last", { qos: 1 })
        await inbox(subscriber).received(4)
        expect(packets.at(-1)?.payload.toString()).toBe("last")
        expect(packets).toHaveLength(4)
      })
    })

    test("an empty client id is assigned one in the CONNACK", async () => {
      await withServer(async (server, open) => {
        const client = await open({ mqttUrl: urlOf(server) }, "", {}, { clean: true })
        const assigned = connackOf(client)?.properties?.assignedClientIdentifier
        expect(assigned).toMatch(/^[A-Za-z][A-Za-z0-9]{15}$/)
        expect(await admin(server, "GET", "/clients")).toMatchObject({
          clients: [{ clientId: assigned }],
        })
      })
    })

    test("auto-reconnect resumes the session and receives what queued up", async () => {
      await withServer(async (server, open) => {
        const client = await open({ mqttUrl: urlOf(server) }, "device", {}, { reconnectPeriod: 20 })
        await client.subscribeAsync("t", { qos: 1 })
        const offline = event(client, "close")
        await admin(server, "POST", "/transport/cut", { clientId: "device" })
        await offline
        await admin(server, "POST", "/inject", { topic: "t", payload: '{"type":"while-away"}' })
        const reconnected = new Promise<boolean>((resolve) => {
          client.once("connect", (packet) => resolve(packet.sessionPresent))
        })
        await admin(server, "POST", "/transport/restore", { clientId: "device" })
        expect(await reconnected).toBe(true)
        await inbox(client).received(1)
        expect(inbox(client).messages).toEqual([{ topic: "t", envelope: { type: "while-away" } }])
      })
    })

    test("a clean end leaves the session to its expiry; PINGREQ is answered", async () => {
      await withServer(async (server, open) => {
        const client = await open({ mqttUrl: urlOf(server) }, "device")
        await client.subscribeAsync("t", { qos: 1 })
        const pong = new Promise<string>((resolve) => {
          client.on("packetreceive", (packet) => {
            if (packet.cmd === "pingresp") resolve(packet.cmd)
          })
        })
        client.sendPing()
        expect(await pong).toBe("pingresp")
        await client.endAsync()
        expect(await admin(server, "GET", "/clients")).toMatchObject({
          clients: [{ clientId: "device", connected: false, subscriptions: 1 }],
        })
      })
    })

    test("what the emulator does not model is refused the way MQTT 5 provides for", async () => {
      await withServer(async (server, open) => {
        // MQTT 3.1.1: refused with that protocol's own return code 1.
        const legacy = connect({ mqttUrl: urlOf(server) }, "legacy", {}, { protocolVersion: 4 })
        expect(await legacy.then(() => undefined, refusalCode)).toBe(1)

        // QoS 2 and RETAIN: the CONNACK said Maximum QoS 1 and Retain Available 0.
        const client = await open({ mqttUrl: urlOf(server) }, "device")
        const refused = event(client, "disconnect")
        client.publish("t", "x", { qos: 2 })
        expect(((await refused) as [{ reasonCode?: number }])[0].reasonCode).toBe(
          ReasonCode.QoSNotSupported,
        )
        const second = await open({ mqttUrl: urlOf(server) }, "device-2")
        const retained = event(second, "disconnect")
        second.publish("t", "x", { qos: 0, retain: true })
        expect(((await retained) as [{ reasonCode?: number }])[0].reasonCode).toBe(
          ReasonCode.RetainNotSupported,
        )
        // A shared subscription: Shared Subscription Available was 0.
        const third = await open({ mqttUrl: urlOf(server) }, "device-3")
        expect(
          await third.subscribeAsync("$share/group/t", { qos: 1 }).then(() => 0, refusalCode),
        ).toBe(ReasonCode.SharedSubscriptionsNotSupported)
      })
    })
  })
}
