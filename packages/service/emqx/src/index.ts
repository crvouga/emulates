import type { FetchAPI } from "@crvouga/mockingbird-core"
import {
  type AuthorizeRequest,
  Broker,
  type BrokerPolicy,
  type ConnectDecision,
  type ConnectRequest,
  isValidTopicName,
  type JsonValue,
  type Properties,
  ReasonCode,
} from "@crvouga/mockingbird-mqtt-broker"
import {
  type APIOptions,
  basicAuth,
  bodyIssues,
  bootSqlite,
  createService,
  defineOperations,
  fromBase64,
  jsonRes,
  type OperationContext,
  type Service,
  unsupportedMediaType,
} from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"
import { type Acl, checkAcl, verifyJwt } from "./auth.js"
import { document, type SupportedOperationId } from "./generated/openapi.js"
import { EmqxState, type SettingsPatch } from "./state.js"

export type { FetchAPI } from "@crvouga/mockingbird-core"
export type {
  Broker,
  ClientInfo,
  Connection,
  PublishRecord,
  SubscriptionRecord,
  Transport,
  TransportInfo,
} from "@crvouga/mockingbird-mqtt-broker"
export { ReasonCode } from "@crvouga/mockingbird-mqtt-broker"
export type { SqliteClient } from "@crvouga/mockingbird-sqlite"
export type { Acl, AclRule } from "./auth.js"
export { checkAcl, parseAcl } from "./auth.js"
export type { OperationId, SupportedOperationId } from "./generated/openapi.js"
export { document, operationIds, supportedOperationIds } from "./generated/openapi.js"
export type { EmqxRuntime, EmqxRuntimeOptions } from "./runtime.js"
export {
  createRuntime,
  EMQX_PRESETS,
  MQTT_CONNECT_OPERATION,
  MQTT_WEBSOCKET_PATH,
} from "./runtime.js"
export type { ApiKey, JwtAuthenticator, MqttUser, Settings, SettingsPatch } from "./state.js"
export { DEFAULT_JWT_AUTHENTICATOR, DEFAULT_SETTINGS } from "./state.js"

export const EMQX_NAMESPACE = "emqx"

/** `mqtt.max_packet_size`, EMQX's default of 1 MB, also sent as the CONNACK Maximum Packet Size. */
export const MAX_PACKET_SIZE = 1_048_576

/** A fault a suite armed for the next CONNECT: the reason code its CONNACK carries. */
export type ConnectFault = () => Promise<number | undefined>

export type EmqxAPIOptions = APIOptions & {
  /** Initial per-namespace settings (API keys, MQTT users, the JWT authenticator). */
  settings?: SettingsPatch
  /** Asked once per CONNECT; the runtime wires it to its fault registry. */
  connectFault?: ConnectFault
}

/** What a session remembers about who authenticated it. */
type Principal = { superuser: boolean; acl: Acl | null; aclExpiresAt: number | null }

const ANONYMOUS: Principal = { superuser: false, acl: null, aclExpiresAt: null }

/** Every `401` carries this header (`emqx_dashboard:return_unauthorized/2`). */
const UNAUTHORIZED = { "www-authenticate": 'Basic Realm="emqx-dashboard"' }

const apiError = (status: number, code: string, message: string, headers = {}) =>
  jsonRes(status, { code, message }, headers)

const publishError = (status: number, reasonCode: number, message: string) =>
  jsonRes(status, { reason_code: reasonCode, message })

/** The `Basic` key an API request carries, for mapping a key to a namespace. */
export const apiKeyCredential = (request: Request): string | undefined =>
  basicAuth(request)?.username

/**
 * Stateful emulator of an EMQX 5 broker: the REST v5 publish and kick endpoints over `fetch`,
 * and an MQTT 5 broker (`broker`) that a listener or an in-process client attaches to.
 */
export class EmqxAPI implements FetchAPI {
  readonly sqlite: SqliteClient
  readonly state: EmqxState
  /** The MQTT side. Attach a transport with `broker.connect(transport)`. */
  readonly broker: Broker
  private readonly service: Service
  private readonly now: () => number
  private readonly connectFault: ConnectFault | undefined

  constructor(options: EmqxAPIOptions = {}) {
    const sqlite = bootSqlite(options.sqlite)
    const namespace = options.namespace ?? EMQX_NAMESPACE
    this.now = options.now ?? (() => Date.now())
    this.connectFault = options.connectFault
    this.state = new EmqxState(sqlite, namespace, options.settings ?? {})
    this.broker = new Broker({ sqlite, namespace, now: this.now, policy: this.policy() })
    const handlers = defineOperations<SupportedOperationId>({
      PublishMessage: (context) => this.publish(context),
      KickClient: (context) => this.kick(context),
    })
    this.service = createService({
      document,
      handlers,
      sqlite,
      namespace,
      now: this.now,
      notFound: () => apiError(404, "NOT_FOUND", "Request Path Not Found"),
      onError: (error) => {
        throw error
      },
      before: (context) => this.authorizeRequest(context.request),
    })
    this.sqlite = this.service.sqlite
  }

  fetch(request: Request): Promise<Response> {
    return this.service.fetch(request)
  }

  /** Drop every connection, clear every record, and re-apply the configured settings. */
  async reset(): Promise<void> {
    this.broker.dropConnections()
    await this.service.reset()
    this.state.ensureSeeded()
  }

  // ── MQTT policy ──────────────────────────────────────────────────────────

  /** Where this broker follows EMQX rather than the bare MQTT 5 specification. */
  private policy(): BrokerPolicy {
    return {
      authenticate: (request) => this.authenticate(request),
      authorize: (request) => this.authorize(request),
      denyAction: () => this.state.current().authorization.denyAction,
      // 16 random characters, the first one a letter (emqx_channel.erl, `rand_id/1`).
      assignClientId: (token) =>
        /^[0-9]/.test(token) ? `${"abcdefghij"[Number(token[0])]}${token.slice(1)}` : token,
      // EMQX takes an MQTT 5 client's interval as sent, with no broker maximum.
      sessionExpiry: (requested) => requested,
      connackProperties: () => ({
        maximumPacketSize: MAX_PACKET_SIZE,
        topicAliasMaximum: 65_535,
        receiveMaximum: 32,
        wildcardSubscriptionAvailable: 1,
        subscriptionIdentifierAvailable: 1,
      }),
      // `mqtt.max_inflight`, `mqtt.max_mqueue_len`, `mqtt.mqueue_store_qos0`.
      maxInflight: 32,
      queue: { storeQos0: true, maxLength: 1000 },
      pubackNoMatchingSubscribers: ReasonCode.NoMatchingSubscribers,
      qos2Subscribe: "downgrade",
      multiLevelWildcardMatchesParent: true,
      // `disconnect_after_expire`: the connection timer ends with Not authorized.
      connectionExpiredReason: ReasonCode.NotAuthorized,
    }
  }

  /**
   * EMQX's authentication chain: the built-in database, then the JWT authenticator. Each
   * answers ok, error, or ignore (try the next); a chain nobody answered is Not authorized,
   * and an empty chain lets everyone in.
   */
  private async authenticate(request: ConnectRequest): Promise<ConnectDecision> {
    const injected = await this.connectFault?.()
    if (injected !== undefined) return { ok: false, reasonCode: injected }
    const { users, jwt } = this.state.current()
    const principal = (value: Principal): JsonValue => value as unknown as JsonValue
    if (users.length === 0 && !jwt) return { ok: true, principal: principal(ANONYMOUS) }
    const badCredentials = { ok: false, reasonCode: ReasonCode.BadUserNameOrPassword } as const
    const password =
      request.password === undefined ? undefined : new TextDecoder().decode(request.password)
    if (users.length > 0) {
      if (password === undefined) return badCredentials
      const user = users.find((each) => each.username === request.username)
      if (user) {
        if (user.password !== password) return badCredentials
        return {
          ok: true,
          principal: principal({ ...ANONYMOUS, superuser: user.superuser === true }),
        }
      }
    }
    if (jwt) {
      const verdict = await verifyJwt(
        jwt.from === "password" ? password : request.username,
        jwt,
        Math.floor(this.now() / 1000),
        request,
      )
      if (verdict.result === "error") return badCredentials
      if (verdict.result === "ok") {
        const expires = jwt.disconnectAfterExpire && verdict.expiresAt !== null
        return {
          ok: true,
          principal: principal({
            superuser: false,
            acl: verdict.acl,
            aclExpiresAt: verdict.expiresAt,
          }),
          ...(expires ? { connectionExpiresAt: (verdict.expiresAt as number) * 1000 } : {}),
        }
      }
    }
    return { ok: false, reasonCode: ReasonCode.NotAuthorized }
  }

  /**
   * EMQX's authorization: a superuser passes; the token's ACL is asked first; whatever it
   * leaves undecided falls to `authorization.no_match`. Delivery is not authorized separately.
   */
  private authorize(request: AuthorizeRequest): boolean {
    if (request.action === "receive") return true
    const principal = (request.principal ?? ANONYMOUS) as unknown as Principal
    if (principal.superuser) return true
    if (principal.acl) {
      // An ACL outlives its token only when `disconnect_after_expire` is off; then it denies.
      if (principal.aclExpiresAt !== null && this.now() / 1000 >= principal.aclExpiresAt) {
        return false
      }
      const verdict = checkAcl(principal.acl, {
        action: request.action,
        topic: request.topic,
        qos: request.qos,
        retain: request.retain,
        clientId: request.clientId,
        username: request.username ?? undefined,
      })
      if (verdict !== "nomatch") return verdict === "allow"
    }
    return this.state.current().authorization.noMatch === "allow"
  }

  // ── REST API v5 ──────────────────────────────────────────────────────────

  /** API-key authentication, ahead of routing a request to its handler. */
  private authorizeRequest(request: Request): Response | undefined {
    const header = request.headers.get("authorization") ?? ""
    if (/^Bearer\s/i.test(header)) {
      // A dashboard login token. The emulator issues none, so every one is unknown.
      return apiError(401, "BAD_TOKEN", "Get a token by POST /login", UNAUTHORIZED)
    }
    const credentials = basicAuth(request)
    if (!credentials) {
      // The trailing space is EMQX's (emqx_dashboard.erl).
      return apiError(
        401,
        "AUTHORIZATION_HEADER_ERROR",
        "Support authorization: basic/bearer ",
        UNAUTHORIZED,
      )
    }
    const keys = this.state.current().apiKeys
    const known = keys.some(
      (each) => each.key === credentials.username && each.secret === credentials.password,
    )
    if (keys.length > 0 && !known) {
      return apiError(401, "BAD_API_KEY_OR_SECRET", "Check api_key/api_secret", UNAUTHORIZED)
    }
    return undefined
  }

  private publish(context: OperationContext): Response {
    if (unsupportedMediaType(context, { includeEmpty: true })) {
      return apiError(415, "UNSUPPORTED_MEDIA_TYPE", "content-type:application/json Required")
    }
    if (context.body.kind === "invalid" || context.body.kind === "empty") {
      return apiError(400, "BAD_REQUEST", "Invalid json message received")
    }
    const [issue] = bodyIssues(context)
    if (issue) {
      // EMQX answers a schema failure with its config library's error, printed as JSON.
      const missing = /^missing required property (.+)$/.exec(issue.message)
      const path = ["root", issue.path, missing?.[1]].filter(Boolean).join(".")
      return apiError(
        400,
        "BAD_REQUEST",
        JSON.stringify({
          kind: "validation_error",
          path,
          reason: missing ? "required_field" : issue.message,
        }),
      )
    }
    const body = (context.body.kind === "json" ? context.body.value : {}) as {
      topic: string
      payload: string
      qos?: 0 | 1 | 2
      retain?: boolean
      payload_encoding?: "plain" | "base64"
      properties?: {
        payload_format_indicator?: number
        message_expiry_interval?: number
        response_topic?: string
        correlation_data?: string
        content_type?: string
        user_properties?: Record<string, string>
      }
    }
    if (!isValidTopicName(body.topic)) {
      return publishError(400, ReasonCode.TopicNameInvalid, "topic_name_invalid")
    }
    let payload: Uint8Array
    if (body.payload_encoding === "base64") {
      try {
        payload = fromBase64(body.payload)
      } catch {
        return publishError(
          400,
          ReasonCode.ImplementationSpecificError,
          "decode_base64_payload_failed",
        )
      }
    } else payload = new TextEncoder().encode(body.payload)
    if (payload.length + new TextEncoder().encode(body.topic).length > MAX_PACKET_SIZE) {
      return publishError(400, ReasonCode.PacketTooLarge, "packet_too_large")
    }
    if (body.retain === true) {
      return apiError(
        400,
        "BAD_REQUEST",
        "retain: retained messages are not modelled by Mockingbird",
      )
    }
    const given = body.properties ?? {}
    const properties: Properties = {
      ...(given.payload_format_indicator !== undefined
        ? { payloadFormatIndicator: given.payload_format_indicator }
        : {}),
      ...(given.message_expiry_interval !== undefined
        ? { messageExpiryInterval: given.message_expiry_interval }
        : {}),
      ...(given.response_topic !== undefined ? { responseTopic: given.response_topic } : {}),
      ...(given.correlation_data !== undefined
        ? { correlationData: new TextEncoder().encode(given.correlation_data) }
        : {}),
      ...(given.content_type !== undefined ? { contentType: given.content_type } : {}),
      ...(given.user_properties !== undefined
        ? { userProperties: Object.entries(given.user_properties) }
        : {}),
    }
    const matched = this.broker.publish(
      { topic: body.topic, payload, qos: body.qos ?? 0, properties },
      "http",
    )
    if (matched === 0) {
      return publishError(202, ReasonCode.NoMatchingSubscribers, "no_matching_subscribers")
    }
    return jsonRes(200, { id: this.state.nextMessageId() })
  }

  private kick(context: OperationContext): Response {
    const clientId = context.params.clientid ?? ""
    if (!this.broker.kick(clientId)) {
      return apiError(404, "CLIENTID_NOT_FOUND", "Client ID not found")
    }
    return new Response(null, { status: 204 })
  }
}
