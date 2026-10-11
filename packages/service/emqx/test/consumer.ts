/**
 * The consumer's EMQX client, as the service request describes it: `mqtt@5.16.0` speaking
 * MQTT 5 with a stable client id, `clean: false` and a 600-second session, subscribing and
 * publishing at QoS 1 without RETAIN; and a fetch-only publisher (a Worker cannot hold an MQTT
 * connection) calling the REST API with a Basic API key. Its payloads are JSON envelopes, and a
 * payload that does not parse is counted and dropped instead of crashing the handler.
 */
import mqtt, { type IClientOptions, type IConnackPacket, MqttClient } from "mqtt"
import { browserStreamBuilder } from "mqtt/lib/connect/ws"

export type EmqxConfig = {
  /** `mqtt://host:port` or `ws://host:port/mqtt`. */
  mqttUrl: string
  /** Origin of the REST API, e.g. `http://127.0.0.1:18083`. */
  apiOrigin: string
  apiKey: string
  apiSecret: string
  fetch?: (request: Request) => Promise<Response>
}

export type MqttCredentials = { username?: string; password?: string }

/** The session lifetime the consumer asks for. */
export const SESSION_EXPIRY_SECONDS = 600

export type Envelope = { type: string; [key: string]: unknown }

export type Inbox = {
  /** Every delivery, in arrival order, as the bytes that arrived. */
  raw: { topic: string; payload: Buffer; qos: number }[]
  /** Deliveries that parsed as an envelope. */
  messages: { topic: string; envelope: Envelope }[]
  /** Deliveries the parser refused. */
  malformed: number
  /** Resolves once `count` deliveries have arrived. */
  received(count: number): Promise<void>
}

/** The options every consumer connection uses. */
export const clientOptions = (
  clientId: string,
  credentials: MqttCredentials = {},
): IClientOptions => ({
  protocolVersion: 5,
  clientId,
  clean: false,
  properties: { sessionExpiryInterval: SESSION_EXPIRY_SECONDS },
  ...credentials,
  // Suites reconnect on purpose; the app's own back-off would race them.
  reconnectPeriod: 0,
  connectTimeout: 5_000,
})

const connacks = new WeakMap<MqttClient, IConnackPacket>()

/** The CONNACK a connection was accepted with (`sessionPresent`, the server's properties). */
export const connackOf = (client: MqttClient): IConnackPacket | undefined => connacks.get(client)

const opened = (client: MqttClient): Promise<MqttClient> => {
  listen(client)
  return new Promise((resolve, reject) => {
    const refused = (error: Error) => {
      client.end(true)
      reject(error)
    }
    // A network that drops the CONNECT answers nothing: the socket just closes.
    const dropped = () => refused(new Error("connection closed before CONNACK"))
    client.once("error", refused)
    client.once("close", dropped)
    client.once("connect", (packet) => {
      connacks.set(client, packet)
      client.off("error", refused)
      client.off("close", dropped)
      // Later errors are observed through events, as in `mqtt.connectAsync`.
      client.on("error", () => {})
      resolve(client)
    })
  })
}

/**
 * Connect the way the app does. Rejects with the client's error (its `code` is the CONNACK
 * reason code) when the broker refuses.
 *
 * A `ws://` URL goes through the library's own WebSocket transport over the global
 * `WebSocket`, the one it uses in browsers: under Bun its Node transport cannot start,
 * because Bun's `ws` shim has no `createWebSocketStream`.
 */
export const connect = (
  config: Pick<EmqxConfig, "mqttUrl">,
  clientId: string,
  credentials: MqttCredentials = {},
  overrides: IClientOptions = {},
): Promise<MqttClient> => {
  const options = { ...clientOptions(clientId, credentials), ...overrides }
  if (!/^wss?:/.test(config.mqttUrl)) return opened(mqtt.connect(config.mqttUrl, options))
  const url = new URL(config.mqttUrl)
  const socket: IClientOptions = {
    ...options,
    protocol: url.protocol === "wss:" ? "wss" : "ws",
    hostname: url.hostname,
    host: url.hostname,
    port: Number(url.port),
    path: `${url.pathname}${url.search}`,
  }
  return opened(new MqttClient((client) => browserStreamBuilder(client, socket), socket))
}

const inboxes = new WeakMap<MqttClient, Inbox>()

/**
 * Attach the app's message handler. The app does this as soon as it creates the client, before
 * the connection is up: a resumed session's queue arrives right behind the CONNACK.
 */
const listen = (client: MqttClient): void => {
  const waiting: { count: number; resolve: () => void }[] = []
  const box: Inbox = {
    raw: [],
    messages: [],
    malformed: 0,
    received: (count) =>
      box.raw.length >= count
        ? Promise.resolve()
        : new Promise((resolve) => {
            waiting.push({ count, resolve })
          }),
  }
  client.on("message", (topic, payload, packet) => {
    box.raw.push({ topic, payload, qos: packet.qos })
    try {
      const parsed: unknown = JSON.parse(payload.toString("utf8"))
      if (typeof parsed !== "object" || parsed === null || !("type" in parsed)) {
        throw new Error("not an envelope")
      }
      box.messages.push({ topic, envelope: parsed as Envelope })
    } catch {
      box.malformed += 1
    }
    for (const each of waiting.splice(0)) {
      if (box.raw.length >= each.count) each.resolve()
      else waiting.push(each)
    }
  })
  inboxes.set(client, box)
}

/** What a client has received, as the app's message handler saw it. */
export const inbox = (client: MqttClient): Inbox => {
  const box = inboxes.get(client)
  if (!box) throw new Error("not a consumer connection")
  return box
}

/** The next occurrence of one of the client's events, with the arguments it was emitted with. */
export const event = (
  client: MqttClient,
  name: "close" | "disconnect" | "offline" | "end" | "reconnect",
): Promise<unknown[]> =>
  new Promise((resolve) => {
    client.once(name, (...args: unknown[]) => resolve(args))
  })

/**
 * The MQTT reason code a refused operation carries. `mqtt` puts it on `code` for a CONNACK or
 * PUBACK, and in the SUBACK packet's `granted` list for a subscription.
 */
export const refusalCode = (error: unknown): number | undefined => {
  const { code, packet } = error as { code?: unknown; packet?: { granted?: unknown[] } }
  if (typeof code === "number") return code
  const granted = packet?.granted?.find((each) => typeof each === "number" && each >= 0x80)
  return typeof granted === "number" ? granted : undefined
}

/** Subscribe to one exact topic at QoS 1. Rejects when the broker refuses it. */
export const subscribe = async (client: MqttClient, topic: string): Promise<void> => {
  await client.subscribeAsync(topic, { qos: 1 })
}

/** Publish one envelope at QoS 1 without RETAIN; resolves on PUBACK. */
export const publishMqtt = async (
  client: MqttClient,
  topic: string,
  envelope: Envelope,
): Promise<void> => {
  await client.publishAsync(topic, JSON.stringify(envelope), { qos: 1, retain: false })
}

const authorization = (config: EmqxConfig) =>
  `Basic ${btoa(`${config.apiKey}:${config.apiSecret}`)}`

const send = (config: EmqxConfig, request: Request) =>
  (config.fetch ?? ((each: Request) => fetch(each)))(request)

export type HttpResult = { ok: boolean; status: number; body: unknown }

/** `POST /api/v5/publish`, as the publish-only Worker client sends it. */
export const publishHttp = async (
  config: EmqxConfig,
  topic: string,
  envelope: Envelope,
): Promise<HttpResult> => {
  const response = await send(
    config,
    new Request(`${config.apiOrigin}/api/v5/publish`, {
      method: "POST",
      headers: { authorization: authorization(config), "content-type": "application/json" },
      body: JSON.stringify({ topic, payload: JSON.stringify(envelope), qos: 1, retain: false }),
    }),
  )
  return {
    ok: response.ok,
    status: response.status,
    body: await response.json().catch(() => null),
  }
}

/** `DELETE /api/v5/clients/{clientid}`: true when kicked, false when the broker knows no such client. */
export const kickClient = async (config: EmqxConfig, clientId: string): Promise<boolean> => {
  const response = await send(
    config,
    new Request(`${config.apiOrigin}/api/v5/clients/${encodeURIComponent(clientId)}`, {
      method: "DELETE",
      headers: { authorization: authorization(config) },
    }),
  )
  if (response.status === 404) return false
  if (!response.ok) throw new Error(`kick failed: HTTP ${response.status}`)
  return true
}
