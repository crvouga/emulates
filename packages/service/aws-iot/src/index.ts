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
  utf8Length,
} from "@crvouga/mockingbird-mqtt-broker"
import {
  type APIOptions,
  bootSqlite,
  createService,
  defineOperations,
  forwardRequestContext,
  fromBase64,
  type OperationContext,
  type Service,
  sigV4AccessKeyId,
  toBase64,
} from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"
import { document, type SupportedOperationId } from "./generated/openapi.js"
import {
  type IotAction,
  isAllowed,
  type PolicyDocument,
  PolicyError,
  parsePolicyDocument,
} from "./policy.js"
import { parseAuthorization, verifySigV4 } from "./sigv4.js"
import { AwsIotState, type SettingsPatch } from "./state.js"

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
export type { OperationId, SupportedOperationId } from "./generated/openapi.js"
export { document, operationIds, supportedOperationIds } from "./generated/openapi.js"
export type { IotAction, PolicyContext, PolicyDocument, PolicyStatement } from "./policy.js"
export { isAllowed, PolicyError, parsePolicyDocument, resourceArn } from "./policy.js"
export type { AwsIotRuntime, AwsIotRuntimeOptions } from "./runtime.js"
export {
  AWS_IOT_PRESETS,
  createRuntime,
  MQTT_CONNECT_OPERATION,
  MQTT_WEBSOCKET_PATH,
} from "./runtime.js"
export type { AuthorizerEntry, IamCredential, Settings, SettingsPatch } from "./state.js"
export {
  DEFAULT_SETTINGS,
  MAX_PERSISTENT_SESSION_EXPIRY_SECONDS,
  parseSettings,
} from "./state.js"

export const AWS_IOT_NAMESPACE = "aws-iot"

/** The Signature Version 4 signing name of the data plane's HTTP API. */
export const SIGNING_NAME = "iotdata"

/** "The payload for every publish request can be no larger than 128 KB." */
export const MAX_PAYLOAD_BYTES = 128 * 1024
/** The quota "Maximum MQTT5 packet size (variable header and payload)": 146 KB. */
export const MAX_PACKET_SIZE = 146 * 1024
/** A topic "can be no larger than 256 bytes of UTF-8 encoded characters". */
export const MAX_TOPIC_BYTES = 256
/** A topic "can have no more than 7 forward slashes". */
export const MAX_TOPIC_SLASHES = 7
/** "Size of the client ID, which is 128 bytes of UTF-8 encoded characters." */
export const MAX_CLIENT_ID_BYTES = 128
/** Keep-alive bounds in seconds; the upper one is also the default. */
export const KEEP_ALIVE_RANGE = [30, 1200] as const
/** "Maximum Message Expiry Interval": seven days, in seconds. */
export const MAX_MESSAGE_EXPIRY_SECONDS = 604_800

/**
 * What a custom authorizer's Lambda function receives for an MQTT connection.
 * https://docs.aws.amazon.com/iot/latest/developerguide/custom-auth-lambda.html
 */
export type CustomAuthorizerEvent = {
  protocols: string[]
  protocolData: {
    mqtt: {
      username?: string
      /** Base64, as AWS IoT Core hands it to the function. */
      password?: string
      clientId: string
    }
  }
  connectionMetadata: { id: string }
}

/** What the Lambda function answers. Policy documents may be objects or JSON strings. */
export type CustomAuthorizerResponse = {
  isAuthenticated: boolean
  principalId?: string
  policyDocuments?: (PolicyDocument | string)[]
  /** Accepted, not enforced. */
  disconnectAfterInSeconds?: number
  /** Accepted, not enforced. */
  refreshAfterInSeconds?: number
}

/** An in-process stand-in for the Lambda function behind a custom authorizer. */
export type CustomAuthorizer = (
  event: CustomAuthorizerEvent,
) => CustomAuthorizerResponse | Promise<CustomAuthorizerResponse>

/** A fault a suite armed for the next CONNECT: the reason code its CONNACK carries. */
export type ConnectFault = () => Promise<number | undefined>

export type AwsIotAPIOptions = APIOptions & {
  /** Initial per-namespace settings (IAM credentials, authorizer entries, the session quota). */
  settings?: SettingsPatch
  /** Decides every MQTT CONNECT instead of `settings.authorizers`. */
  authorizer?: CustomAuthorizer
  /** Asked once per CONNECT; the runtime wires it to its fault registry. */
  connectFault?: ConnectFault
}

/** What a session remembers about who authenticated it. `policyDocuments: null` allows everything. */
type Principal = { principalId: string | null; policyDocuments: PolicyDocument[] | null }

/**
 * The namespace credential of a signed request: its SigV4 access key id. Map it with
 * `PUT /__admin/credentials {"credentials": {"<AWS_ACCESS_KEY_ID>": "<namespace>"}}`.
 */
export const accessKeyCredential = sigV4AccessKeyId

/**
 * The parts of an MQTT username: AWS IoT reads the custom authorizer's name from its query
 * string (`username?x-amz-customauthorizer-name=…`).
 */
export const splitUsername = (
  username: string | undefined,
): { username: string | undefined; authorizerName: string | undefined } => {
  if (username === undefined) return { username: undefined, authorizerName: undefined }
  const mark = username.indexOf("?")
  if (mark < 0) return { username, authorizerName: undefined }
  const query = new URLSearchParams(username.slice(mark + 1))
  return {
    username: username.slice(0, mark),
    authorizerName: query.get("x-amz-customauthorizer-name") ?? undefined,
  }
}

const ERROR_MESSAGES = {
  InvalidRequestException: "The request is not valid.",
  UnauthorizedException: "You are not authorized to perform this operation.",
  MethodNotAllowedException: "The specified combination of HTTP verb and URI is not supported.",
  ForbiddenException: "Forbidden",
} as const

const withinTopicLimits = (topic: string): boolean =>
  utf8Length(topic) <= MAX_TOPIC_BYTES &&
  topic.split("/").length - 1 <= MAX_TOPIC_SLASHES &&
  // Reserved topics ($aws/…) belong to features this emulator does not model.
  !topic.startsWith("$")

/**
 * Stateful emulator of the AWS IoT Core data plane: IoTDataPlane `Publish` over `fetch`, and
 * the MQTT 5 message broker (`broker`) that a listener or an in-process client attaches to.
 */
export class AwsIotAPI implements FetchAPI {
  readonly sqlite: SqliteClient
  readonly state: AwsIotState
  /** The MQTT side. Attach a transport with `broker.connect(transport)`. */
  readonly broker: Broker
  private readonly service: Service
  private readonly now: () => number
  private readonly authorizer: CustomAuthorizer | undefined
  private readonly connectFault: ConnectFault | undefined
  /** Request bodies as received: the signature covers the bytes, whatever the content type. */
  private readonly bodies = new WeakMap<Request, Uint8Array>()
  private connections = 0

  constructor(options: AwsIotAPIOptions = {}) {
    const sqlite = bootSqlite(options.sqlite)
    const namespace = options.namespace ?? AWS_IOT_NAMESPACE
    this.now = options.now ?? (() => Date.now())
    this.authorizer = options.authorizer
    this.connectFault = options.connectFault
    this.state = new AwsIotState(sqlite, namespace, options.settings ?? {})
    this.broker = new Broker({ sqlite, namespace, now: this.now, policy: this.policy() })
    const handlers = defineOperations<SupportedOperationId>({
      Publish: (context) => this.publish(context),
    })
    this.service = createService({
      document,
      handlers,
      sqlite,
      namespace,
      now: this.now,
      notFound: () => this.error(405, "MethodNotAllowedException"),
      onError: (error) => {
        throw error
      },
    })
    this.sqlite = this.service.sqlite
  }

  async fetch(request: Request): Promise<Response> {
    if (request.method === "GET" || request.method === "HEAD") return this.service.fetch(request)
    const body = new Uint8Array(await request.arrayBuffer())
    const copy = forwardRequestContext(
      request,
      new Request(request.url, {
        method: request.method,
        headers: request.headers,
        body: body as BodyInit,
        signal: request.signal,
      }),
    )
    this.bodies.set(copy, body)
    return this.service.fetch(copy)
  }

  /** Drop every connection, clear every record, and re-apply the configured settings. */
  async reset(): Promise<void> {
    this.broker.dropConnections()
    await this.service.reset()
    this.state.ensureSeeded()
  }

  private policyContext(clientId: string) {
    const { region, accountId } = this.state.current()
    return { region, accountId, clientId }
  }

  // ── MQTT policy ──────────────────────────────────────────────────────────

  /**
   * Where AWS IoT Core differs from the MQTT 5 specification.
   * https://docs.aws.amazon.com/iot/latest/developerguide/mqtt.html
   */
  private policy(): BrokerPolicy {
    return {
      authenticate: (request) => this.authenticate(request),
      authorize: (request) => this.authorize(request),
      denyAction: () => "ignore",
      checkClientId: (clientId) =>
        utf8Length(clientId) > MAX_CLIENT_ID_BYTES
          ? ReasonCode.ClientIdentifierNotValid
          : undefined,
      assignClientId: (token) => token,
      checkTopicName: (topic) =>
        withinTopicLimits(topic) ? undefined : ReasonCode.TopicNameInvalid,
      checkTopicFilter: (filter) =>
        withinTopicLimits(filter) ? undefined : ReasonCode.TopicFilterInvalid,
      // "If the value you set exceeds the maximum of your account, AWS IoT Core will return
      // the adjusted value in the CONNACK."
      sessionExpiry: (requested) =>
        Math.min(requested, this.state.current().persistentSessionExpirySeconds),
      // "The default keep-alive interval is used when a client requests a keep-alive interval
      // of zero or > 1200 seconds. … < 30 seconds but more than zero, the server treats the
      // client as though it requested a keep-alive interval of 30 seconds."
      serverKeepAlive: (requested) =>
        requested === 0 || requested > KEEP_ALIVE_RANGE[1]
          ? KEEP_ALIVE_RANGE[1]
          : Math.max(requested, KEEP_ALIVE_RANGE[0]),
      connackProperties: () => ({
        maximumPacketSize: MAX_PACKET_SIZE,
        topicAliasMaximum: 8,
        receiveMaximum: 100,
        wildcardSubscriptionAvailable: 1,
        subscriptionIdentifierAvailable: 0,
      }),
      maxPayloadBytes: MAX_PAYLOAD_BYTES,
      maxInflight: 100,
      // Persistent sessions store QoS 1 messages only.
      queue: { storeQos0: false },
      pubackNoMatchingSubscribers: ReasonCode.Success,
      // "When QoS level 2 is requested, the message broker doesn't send a PUBACK or SUBACK."
      qos2Subscribe: "ignore",
      // "A subscription to sensor/# receives messages published to sensor/ … but not messages
      // published to sensor."
      multiLevelWildcardMatchesParent: false,
      connectionExpiredReason: ReasonCode.NotAuthorized,
    }
  }

  /** Custom authentication: an authorizer decides, then its policy must allow `iot:Connect`. */
  private async authenticate(request: ConnectRequest): Promise<ConnectDecision> {
    const injected = await this.connectFault?.()
    if (injected !== undefined) return { ok: false, reasonCode: injected }
    const notAuthorized = { ok: false, reasonCode: ReasonCode.NotAuthorized } as const
    const { username, authorizerName } = splitUsername(request.username)
    const { authorizers } = this.state.current()
    let principal: Principal
    if (this.authorizer) {
      this.connections += 1
      let response: CustomAuthorizerResponse
      try {
        response = await this.authorizer({
          protocols: request.transport.kind === "websocket" ? ["http", "mqtt"] : ["mqtt"],
          protocolData: {
            mqtt: {
              ...(username !== undefined ? { username } : {}),
              ...(request.password !== undefined ? { password: toBase64(request.password) } : {}),
              clientId: request.clientId,
            },
          },
          connectionMetadata: { id: `mockingbird-connection-${this.connections}` },
        })
      } catch {
        // "If failures occur during custom authentication, AWS IoT Core terminates the connection."
        return notAuthorized
      }
      if (!response.isAuthenticated) return notAuthorized
      let policyDocuments: PolicyDocument[]
      try {
        policyDocuments = (response.policyDocuments ?? []).map(parsePolicyDocument)
      } catch (error) {
        if (error instanceof PolicyError) return notAuthorized
        throw error
      }
      principal = { principalId: response.principalId ?? null, policyDocuments }
    } else if (authorizers.length === 0) {
      principal = { principalId: null, policyDocuments: null }
    } else {
      const password =
        request.password === undefined ? undefined : new TextDecoder().decode(request.password)
      const entry = authorizers.find(
        (each) =>
          each.username === username &&
          (each.password === undefined || each.password === password) &&
          (each.name === undefined || each.name === authorizerName),
      )
      if (!entry || entry.isAuthenticated === false) return notAuthorized
      principal = {
        principalId: entry.principalId ?? null,
        policyDocuments: entry.policyDocuments,
      }
    }
    if (
      principal.policyDocuments &&
      !isAllowed(
        principal.policyDocuments,
        "iot:Connect",
        request.clientId,
        this.policyContext(request.clientId),
      )
    ) {
      return notAuthorized
    }
    return { ok: true, principal: principal as unknown as JsonValue }
  }

  /** `iot:Publish` and `iot:Receive` on `topic/…`, `iot:Subscribe` on `topicfilter/…`. */
  private authorize(request: AuthorizeRequest): boolean {
    const principal = request.principal as unknown as Principal | null
    if (!principal?.policyDocuments) return true
    const action: IotAction =
      request.action === "publish"
        ? "iot:Publish"
        : request.action === "subscribe"
          ? "iot:Subscribe"
          : "iot:Receive"
    return isAllowed(
      principal.policyDocuments,
      action,
      request.topic,
      this.policyContext(request.clientId),
    )
  }

  // ── IoTDataPlane Publish ─────────────────────────────────────────────────

  /** The restJson1 error body AWS IoT shows: `{message, traceId}`, typed by a header. */
  private error(status: number, type: keyof typeof ERROR_MESSAGES, reason?: string): Response {
    const traceId = this.state.nextTraceId()
    return new Response(JSON.stringify({ message: ERROR_MESSAGES[type], traceId }), {
      status,
      headers: {
        "content-type": "application/json",
        "x-amzn-errortype": type,
        "x-amzn-requestid": traceId,
        // Why the emulator refused, for a suite's diagnostics. AWS sends no such header.
        ...(reason !== undefined ? { "x-mockingbird-reason": reason } : {}),
      },
    })
  }

  /**
   * Signature Version 4 authentication. With no credentials configured any signed request
   * passes unverified, like the other AWS emulators; with some, the signature must verify.
   * Returns the caller's policy (`null` allows everything) or the refusal.
   */
  private async authenticateRequest(
    request: Request,
    body: Uint8Array,
  ): Promise<{ policyDocuments: PolicyDocument[] | null } | Response> {
    const forbidden = (reason: string) => this.error(403, "ForbiddenException", reason)
    const authorization = parseAuthorization(request.headers.get("authorization"))
    if (!authorization) return forbidden("missing_or_malformed_authorization")
    const { credentials, region } = this.state.current()
    if (credentials.length === 0) return { policyDocuments: null }
    const credential = credentials.find((each) => each.accessKeyId === authorization.accessKeyId)
    if (!credential) return forbidden("unknown_access_key")
    if (authorization.service !== SIGNING_NAME) return forbidden("wrong_signing_name")
    if (authorization.region !== region) return forbidden("wrong_region")
    if (
      credential.sessionToken !== undefined &&
      request.headers.get("x-amz-security-token") !== credential.sessionToken
    ) {
      return forbidden("wrong_session_token")
    }
    const failure = await verifySigV4(request, body, authorization, credential.secretAccessKey)
    if (failure) return forbidden(failure)
    return { policyDocuments: credential.policyDocuments ?? null }
  }

  private async publish(context: OperationContext): Promise<Response> {
    const { request, url } = context
    const body = this.bodies.get(request) ?? new Uint8Array(0)
    const caller = await this.authenticateRequest(request, body)
    if (caller instanceof Response) return caller
    const invalid = (reason: string) => this.error(400, "InvalidRequestException", reason)

    // The path is decoded exactly once: `%2F` is a level separator, `%252F` a literal `%2F`.
    let topic: string
    try {
      topic = decodeURIComponent(url.pathname.slice("/topics/".length))
    } catch {
      return invalid("malformed_topic_encoding")
    }
    if (!isValidTopicName(topic)) return invalid("topic_name")
    if (!withinTopicLimits(topic)) return invalid("topic_limits")
    const query = url.searchParams
    const qos = query.get("qos") ?? "0"
    if (qos !== "0" && qos !== "1") return invalid("qos")
    const retain = query.get("retain") ?? "false"
    if (retain !== "true" && retain !== "false") return invalid("retain")
    if (retain === "true") return invalid("retained_messages_not_modelled")
    if (body.length > MAX_PAYLOAD_BYTES) return invalid("payload_too_large")

    const properties: Properties = {}
    const contentType = query.get("contentType")
    if (contentType !== null) properties.contentType = contentType
    const responseTopic = query.get("responseTopic")
    if (responseTopic !== null) {
      // "The topic must not contain wildcard characters."
      if (!isValidTopicName(responseTopic)) return invalid("response_topic")
      properties.responseTopic = responseTopic
    }
    const expiry = query.get("messageExpiry")
    if (expiry !== null) {
      if (!/^\d+$/.test(expiry)) return invalid("message_expiry")
      // "The minimum MEI is 1 … Any values higher than this will be adjusted to the maximum."
      properties.messageExpiryInterval = Math.min(
        Math.max(Number(expiry), 1),
        MAX_MESSAGE_EXPIRY_SECONDS,
      )
    }
    const indicator = request.headers.get("x-amz-mqtt5-payload-format-indicator")
    if (indicator !== null) {
      if (indicator !== "UNSPECIFIED_BYTES" && indicator !== "UTF8_DATA") {
        return invalid("payload_format_indicator")
      }
      properties.payloadFormatIndicator = indicator === "UTF8_DATA" ? 1 : 0
    }
    const correlation = request.headers.get("x-amz-mqtt5-correlation-data")
    if (correlation !== null) {
      try {
        properties.correlationData = fromBase64(correlation)
      } catch {
        return invalid("correlation_data")
      }
    }
    const userProperties = request.headers.get("x-amz-mqtt5-user-properties")
    if (userProperties !== null) {
      // A base64-encoded JSON list of single-entry objects: [{"deviceName": "alpha"}, …].
      try {
        const parsed: unknown = JSON.parse(new TextDecoder().decode(fromBase64(userProperties)))
        if (!Array.isArray(parsed)) throw new TypeError("not a list")
        properties.userProperties = parsed.flatMap((each) =>
          Object.entries(each as Record<string, unknown>).map(
            ([name, value]) => [name, String(value)] as [string, string],
          ),
        )
      } catch {
        return invalid("user_properties")
      }
    }

    if (
      caller.policyDocuments &&
      !isAllowed(caller.policyDocuments, "iot:Publish", topic, this.policyContext(""))
    ) {
      return this.error(401, "UnauthorizedException", "iot_publish_not_allowed")
    }
    this.broker.publish({ topic, payload: body, qos: qos === "1" ? 1 : 0, properties }, "http")
    const traceId = this.state.nextTraceId()
    return new Response(JSON.stringify({ message: "OK", traceId }), {
      status: 200,
      headers: { "content-type": "application/json", "x-amzn-requestid": traceId },
    })
  }
}
