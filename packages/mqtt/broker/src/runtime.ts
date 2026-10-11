/**
 * What every MQTT emulator's runtime needs around its brokers, written once: the admin routes
 * that inspect and steer a broker, a clock that settles expiries when a suite moves it, CONNECT
 * faults, and how a transport finds its namespace.
 */
import {
  type AdminRoutes,
  type Clock,
  type CredentialRegistry,
  DEFAULT_NAMESPACE,
  type FaultPreset,
  type FaultRegistry,
  fromBase64,
  matchNamespacePath,
} from "@crvouga/mockingbird-service"
import type { Broker } from "./broker.js"
import type { ConnectPacket } from "./codec.js"

/** The path MQTT over WebSocket is served on (EMQX's `mqtt_path`, AWS IoT's `/mqtt`). */
export const MQTT_WEBSOCKET_PATH = "/mqtt"

/**
 * What an MQTT CONNECT is called in fault rules, since it is not an HTTP operation:
 * `POST /__admin/faults {"operationId": "MqttConnect", "effect": "connack", "params": {"reasonCode": 135}}`.
 */
export const MQTT_CONNECT_OPERATION = "MqttConnect"

/** A fault preset that refuses CONNECT with `reasonCode`. */
export const connackPreset = (reasonCode: number, description: string): FaultPreset => ({
  description,
  rules: [{ operationId: MQTT_CONNECT_OPERATION, effect: "connack", params: { reasonCode } }],
})

/**
 * The reason code a fault rule armed for the next CONNECT in `namespace`, if any. Consumes one
 * use of each matching rule, as an HTTP request does.
 */
export const takeConnackFault = async (
  faults: FaultRegistry,
  namespace: string,
): Promise<number | undefined> => {
  const hits = await faults.take({
    operationId: MQTT_CONNECT_OPERATION,
    method: "CONNECT",
    path: MQTT_WEBSOCKET_PATH,
    namespace,
  })
  for (const hit of hits) {
    const code = hit.effect?.name === "connack" ? hit.effect.params.reasonCode : undefined
    if (typeof code === "number") return code
  }
  return undefined
}

/** A clock that reports every jump, so expiries are settled the moment a suite moves time. */
export const observeClock = (clock: Clock, moved: () => void): Clock => ({
  now: clock.now,
  state: clock.state,
  freeze: clock.freeze,
  set: (epochMs) => {
    clock.set(epochMs)
    moved()
  },
  advance: (deltaMs) => {
    clock.advance(deltaMs)
    moved()
  },
  unfreeze: () => {
    clock.unfreeze()
    moved()
  },
  reset: () => {
    clock.reset()
    moved()
  },
})

/**
 * Whether an HTTP path is the MQTT WebSocket endpoint: `/mqtt`, or `<adminPrefix>/ns/<name>/mqtt`
 * to select a namespace. `undefined` when it is neither.
 */
export const webSocketNamespace = (
  pathname: string,
  adminPrefix: string,
): { namespace: string | undefined } | undefined => {
  const prefixed = matchNamespacePath(pathname, adminPrefix)
  if ((prefixed ? prefixed[2] : pathname) !== MQTT_WEBSOCKET_PATH) return undefined
  return { namespace: prefixed ? decodeURIComponent(prefixed[1] as string) : undefined }
}

/**
 * The namespace a CONNECT belongs to when its transport named none: the one
 * `PUT /__admin/credentials` maps its username to, then its client identifier, then the default.
 */
export const connectNamespace = (
  credentials: CredentialRegistry,
  connect: Pick<ConnectPacket, "username" | "clientId">,
  username: string | undefined = connect.username,
): string =>
  (username !== undefined ? credentials.get(username) : undefined) ??
  credentials.get(connect.clientId) ??
  DEFAULT_NAMESPACE

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
const adminError = (status: number, message: string) =>
  json(status, { error: { type: "mockingbird_admin", message } })
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/**
 * Admin routes over one namespace's broker: inspect clients, subscriptions and publish
 * metadata; inject raw payloads; cut and restore the transport; force a disconnect.
 */
export const brokerAdminRoutes = (brokerOf: (namespace: string) => Broker): AdminRoutes => {
  /** `undefined`: every client. `null`: not a client identifier. */
  const target = (body: unknown): string | undefined | null =>
    !isRecord(body) || body.clientId === undefined
      ? undefined
      : typeof body.clientId === "string" && body.clientId !== ""
        ? body.clientId
        : null
  return {
    "GET /clients": ({ namespace }) => json(200, { clients: brokerOf(namespace).clients() }),
    "GET /clients/:clientId": ({ params, namespace }) => {
      const broker = brokerOf(namespace)
      const client = broker.clients().find((each) => each.clientId === params.clientId)
      if (!client) return adminError(404, `no client ${params.clientId}`)
      return json(200, { ...client, topics: broker.subscriptionList(client.clientId) })
    },
    "POST /clients/:clientId/disconnect": ({ params, body, namespace }) => {
      const reasonCode = isRecord(body) ? body.reasonCode : undefined
      const valid =
        reasonCode === undefined ||
        (typeof reasonCode === "number" &&
          Number.isInteger(reasonCode) &&
          reasonCode >= 0 &&
          reasonCode <= 0xff)
      if (!valid) return adminError(400, "reasonCode: an MQTT reason code, 0 to 255")
      return brokerOf(namespace).disconnect(params.clientId as string, reasonCode)
        ? json(200, { disconnected: params.clientId })
        : adminError(404, `client ${params.clientId} is not connected`)
    },
    "GET /subscriptions": ({ url, namespace }) =>
      json(200, {
        subscriptions: brokerOf(namespace).subscriptionList(
          url.searchParams.get("clientId") ?? undefined,
        ),
      }),
    "GET /publishes": ({ namespace }) => {
      const broker = brokerOf(namespace)
      return json(200, { total: broker.publishCount(), publishes: broker.publishLog() })
    },
    "POST /inject": ({ body, namespace }) => {
      if (!isRecord(body) || typeof body.topic !== "string" || body.topic === "") {
        return adminError(400, 'expected {"topic", "payload" | "payloadBase64", "qos"?}')
      }
      let payload: Uint8Array
      if (typeof body.payloadBase64 === "string") {
        try {
          payload = fromBase64(body.payloadBase64)
        } catch {
          return adminError(400, "payloadBase64: not base64")
        }
      } else if (typeof body.payload === "string") payload = new TextEncoder().encode(body.payload)
      else return adminError(400, "payload: a string, or payloadBase64 for raw bytes")
      const qos = body.qos ?? 1
      if (qos !== 0 && qos !== 1) return adminError(400, "qos: 0 or 1")
      const matched = brokerOf(namespace).publish({ topic: body.topic, payload, qos }, "admin")
      return json(200, { matched })
    },
    "GET /transport": ({ namespace }) => json(200, { cut: brokerOf(namespace).transportCuts() }),
    "POST /transport/cut": ({ body, namespace }) => {
      const clientId = target(body)
      if (clientId === null) return adminError(400, "clientId: a client identifier, or omit it")
      const broker = brokerOf(namespace)
      const dropped = broker.cutTransport(clientId)
      return json(200, { cut: broker.transportCuts(), dropped })
    },
    "POST /transport/restore": ({ body, namespace }) => {
      const clientId = target(body)
      if (clientId === null) return adminError(400, "clientId: a client identifier, or omit it")
      const broker = brokerOf(namespace)
      broker.restoreTransport(clientId)
      return json(200, { cut: broker.transportCuts() })
    },
  }
}
