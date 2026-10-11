/**
 * The consumer's AWS IoT Core client, as the service request describes it.
 *
 * - Publishing: a raw `fetch` to `POST /topics/{topic}?qos=1` signed with Signature Version 4
 *   (service `iotdata`), with an injectable `fetch`, endpoint and credentials. The body is the
 *   UTF-8 bytes of a JSON envelope, sent as `application/octet-stream`.
 * - Subscribing: `mqtt@5.16.0` speaking MQTT 5 with a stable client id, `clean: false` and a
 *   session expiry, with credentials from an injected callback (its custom authorizer's).
 * - Topics: the app names topics `user:example`; on AWS IoT it uses `user/example`. That
 *   mapping is the app's own (`toMqttTopic`), applied before either transport sees a topic.
 *
 * The signer here is written against the SigV4 documentation with `node:crypto`, separately
 * from the emulator's verifier, so the two check each other.
 */
import { createHash, createHmac } from "node:crypto"
import mqtt, { type IClientOptions, type IConnackPacket, MqttClient } from "mqtt"
import { browserStreamBuilder } from "mqtt/lib/connect/ws"

export type AwsCredentials = {
  accessKeyId: string
  secretAccessKey: string
  sessionToken?: string
}

export type IotHttpConfig = {
  /** The data endpoint origin, e.g. `https://example-ats.iot.us-east-1.amazonaws.com`. */
  endpoint: string
  region: string
  credentials: AwsCredentials
  fetch?: (request: Request) => Promise<Response>
  /** The signing time; defaults to now. */
  now?: () => Date
}

export type Envelope = { type: string; [key: string]: unknown }

/** The app's logical topic names use `:`; AWS IoT topic levels are separated by `/`. */
export const toMqttTopic = (logicalTopic: string): string => logicalTopic.replaceAll(":", "/")

const sha256 = (data: Uint8Array | string): string =>
  createHash("sha256").update(data).digest("hex")
const hmac = (key: Uint8Array | string, data: string): Buffer =>
  createHmac("sha256", key).update(data).digest()

/** RFC 3986 encoding, as SigV4's `UriEncode()` defines it. */
const uriEncode = (value: string): string =>
  encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  )

/** The SigV4 headers for one request to the `iotdata` service. */
export const signRequest = (
  config: Pick<IotHttpConfig, "region" | "credentials" | "now">,
  method: string,
  url: URL,
  body: Uint8Array,
  headers: Record<string, string> = {},
): Record<string, string> => {
  const stamp = (config.now?.() ?? new Date()).toISOString().replace(/[:-]|\.\d{3}/g, "")
  const date = stamp.slice(0, 8)
  const signed: Record<string, string> = {
    ...Object.fromEntries(
      Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]),
    ),
    host: url.host,
    "x-amz-date": stamp,
    ...(config.credentials.sessionToken
      ? { "x-amz-security-token": config.credentials.sessionToken }
      : {}),
  }
  const names = Object.keys(signed).sort()
  const canonicalRequest = [
    method,
    // Every service but S3 encodes the already-encoded path once more.
    url.pathname.split("/").map(uriEncode).join("/"),
    [...url.searchParams]
      .map(([name, value]) => `${uriEncode(name)}=${uriEncode(value)}`)
      .sort()
      .join("&"),
    names.map((name) => `${name}:${String(signed[name]).trim()}\n`).join(""),
    names.join(";"),
    sha256(body),
  ].join("\n")
  const scope = `${date}/${config.region}/iotdata/aws4_request`
  const stringToSign = ["AWS4-HMAC-SHA256", stamp, scope, sha256(canonicalRequest)].join("\n")
  const dateKey = hmac(`AWS4${config.credentials.secretAccessKey}`, date)
  const serviceKey = hmac(hmac(dateKey, config.region), "iotdata")
  const key = hmac(serviceKey, "aws4_request")
  const { host: _host, ...sent } = signed
  return {
    ...sent,
    authorization: `AWS4-HMAC-SHA256 Credential=${config.credentials.accessKeyId}/${scope}, SignedHeaders=${names.join(";")}, Signature=${hmac(key, stringToSign).toString("hex")}`,
  }
}

export type PublishResult = {
  ok: boolean
  status: number
  /** `x-amzn-ErrorType`, when the service names one. */
  errorType: string | null
  body: { message?: string; traceId?: string } | null
}

/** Publish raw bytes to an MQTT topic at QoS 1. */
export const publishBytes = async (
  config: IotHttpConfig,
  topic: string,
  payload: Uint8Array,
  query: Record<string, string> = { qos: "1" },
): Promise<PublishResult> => {
  // Encoded once: a `/` in the topic travels as `%2F`.
  const url = new URL(`${config.endpoint}/topics/${encodeURIComponent(topic)}`)
  for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value)
  const headers = signRequest(config, "POST", url, payload, {
    "content-type": "application/octet-stream",
  })
  const send = config.fetch ?? ((request: Request) => fetch(request))
  const response = await send(
    new Request(url, { method: "POST", headers, body: payload as BodyInit }),
  )
  return {
    ok: response.ok,
    status: response.status,
    errorType: response.headers.get("x-amzn-errortype"),
    body: (await response.json().catch(() => null)) as PublishResult["body"],
  }
}

/** Publish one envelope to a logical topic, the way the app's publisher does. */
export const publish = (
  config: IotHttpConfig,
  logicalTopic: string,
  envelope: Envelope,
): Promise<PublishResult> =>
  publishBytes(
    config,
    toMqttTopic(logicalTopic),
    new TextEncoder().encode(JSON.stringify(envelope)),
  )

// ── MQTT ─────────────────────────────────────────────────────────────────────

export type MqttCredentials = { username?: string; password?: string }

/** The app's injected auth callback: the credentials its custom authorizer expects. */
export type AuthCallback = () => MqttCredentials | Promise<MqttCredentials>

/** The session lifetime the consumer asks for. */
export const SESSION_EXPIRY_SECONDS = 600

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

const inboxes = new WeakMap<MqttClient, Inbox>()
const connacks = new WeakMap<MqttClient, IConnackPacket>()

/** The CONNACK a connection was accepted with (`sessionPresent`, the server's properties). */
export const connackOf = (client: MqttClient): IConnackPacket | undefined => connacks.get(client)

/** What a client has received, as the app's message handler saw it. */
export const inbox = (client: MqttClient): Inbox => {
  const box = inboxes.get(client)
  if (!box) throw new Error("not a consumer connection")
  return box
}

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
export const connect = async (
  mqttUrl: string,
  clientId: string,
  auth: AuthCallback = () => ({}),
  overrides: IClientOptions = {},
): Promise<MqttClient> => {
  const options: IClientOptions = {
    protocolVersion: 5,
    clientId,
    clean: false,
    properties: { sessionExpiryInterval: SESSION_EXPIRY_SECONDS },
    ...(await auth()),
    // Suites reconnect on purpose; the app's own back-off would race them.
    reconnectPeriod: 0,
    connectTimeout: 5_000,
    ...overrides,
  }
  if (!/^wss?:/.test(mqttUrl)) return opened(mqtt.connect(mqttUrl, options))
  const url = new URL(mqttUrl)
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

/** Subscribe to one logical topic at QoS 1. Rejects when the broker refuses it. */
export const subscribe = async (client: MqttClient, logicalTopic: string): Promise<void> => {
  await client.subscribeAsync(toMqttTopic(logicalTopic), { qos: 1 })
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
