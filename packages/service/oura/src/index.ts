import type { FetchAPI } from "@emulates/core"
import {
  type APIOptions,
  basicAuth,
  bearerToken,
  bootSqlite,
  Collection,
  createService,
  defineOperations,
  IdSequence,
  jsonRes,
  type OperationContext,
  type Service,
} from "@emulates/service"
import type { Hono } from "hono"
import { document, type SupportedOperationId } from "./generated/openapi.js"

export type { OperationId, SupportedOperationId } from "./generated/openapi.js"
export { document, operationIds, supportedOperationIds } from "./generated/openapi.js"
export type { OuraRuntime, OuraRuntimeOptions } from "./runtime.js"
export { createRuntime, OURA_PRESETS } from "./runtime.js"
export const OURA_NAMESPACE = "oura"
export const COLLECTION_SCOPES = {
  workout: "workout",
  sleep: "daily",
  heartrate: "heartrate",
  daily_activity: "daily",
  daily_spo2: "spo2",
  daily_readiness: "daily",
  daily_sleep: "daily",
} as const
export type CollectionName = keyof typeof COLLECTION_SCOPES
export type Grant = {
  token: string
  refreshToken: string
  clientId: string
  userId: string
  scopes: string[]
  expiresAt: number
}
export type OAuthCode = {
  code: string
  clientId: string
  userId: string
  scopes: string[]
  redirectUri?: string
  challenge?: string
  expiresAt: number
}
export type Client = { id: string; secret: string }
export type DataRecord = {
  key: string
  userId: string
  collection: CollectionName
  data: Record<string, unknown>
}
export type OuraAPIOptions = APIOptions & {
  grants?: Grant[]
  clients?: Client[]
  codes?: OAuthCode[]
  records?: DataRecord[]
  pageSize?: number
  tokenTtlSeconds?: number
}
const unauthorized = () =>
  jsonRes(401, {
    detail:
      "The access token provided is expired, revoked, malformed, or invalid for other reasons.",
  })
const oauthError = (error: string, description: string) =>
  jsonRes(400, { status: 400, error, error_description: description })
export class OuraAPI implements FetchAPI {
  readonly app: Hono
  readonly grants: Collection<Grant>
  readonly clients: Collection<Client>
  readonly codes: Collection<OAuthCode>
  readonly records: Collection<DataRecord>
  private readonly initialized: Collection<{ value: boolean }>
  private readonly ids: IdSequence
  private readonly service: Service
  private readonly now: () => number
  private readonly fixtures: Required<
    Pick<OuraAPIOptions, "grants" | "clients" | "codes" | "records">
  >
  private readonly pageSize: number
  private readonly ttl: number
  constructor(options: OuraAPIOptions = {}) {
    const sqlite = bootSqlite(options.sqlite),
      namespace = options.namespace ?? OURA_NAMESPACE
    this.now = options.now ?? Date.now
    this.grants = new Collection(sqlite, namespace, "grants")
    this.clients = new Collection(sqlite, namespace, "clients")
    this.codes = new Collection(sqlite, namespace, "codes")
    this.records = new Collection(sqlite, namespace, "records")
    this.initialized = new Collection(sqlite, namespace, "initialized")
    this.ids = new IdSequence(sqlite, namespace)
    this.pageSize = options.pageSize ?? 100
    this.ttl = options.tokenTtlSeconds ?? 86400
    if (!Number.isInteger(this.pageSize) || this.pageSize < 1)
      throw new Error("pageSize must be positive")
    this.fixtures = structuredClone({
      grants: options.grants ?? [
        {
          token: "mock_oura_token",
          refreshToken: "mock_oura_refresh",
          clientId: "mock_client",
          userId: "synthetic-user",
          scopes: ["daily", "workout", "heartrate", "spo2"],
          expiresAt: 4102444800000,
        },
      ],
      clients: options.clients ?? [{ id: "mock_client", secret: "mock_client_secret" }],
      codes: options.codes ?? [],
      records: options.records ?? [],
    })
    this.seed()
    this.service = createService({
      document,
      sqlite,
      namespace,
      now: this.now,
      notFound: () => jsonRes(404, { detail: "Not Found" }),
      onError: (error) => {
        throw error
      },
      handlers: defineOperations<SupportedOperationId>({
        OAuthToken: (c) => this.exchange(c),
        ListWorkout: (c) => this.list(c, "workout"),
        ListSleep: (c) => this.list(c, "sleep"),
        ListHeartrate: (c) => this.list(c, "heartrate"),
        ListDailyActivity: (c) => this.list(c, "daily_activity"),
        ListDailySpo2: (c) => this.list(c, "daily_spo2"),
        ListDailyReadiness: (c) => this.list(c, "daily_readiness"),
        ListDailySleep: (c) => this.list(c, "daily_sleep"),
      }),
    })
    this.app = this.service.app
  }
  private seed() {
    if (this.initialized.has("seed")) return
    for (const g of this.fixtures.grants) this.grants.insert(g.token, g)
    for (const c of this.fixtures.clients) this.clients.insert(c.id, c)
    for (const c of this.fixtures.codes) this.codes.insert(c.code, c)
    for (const r of this.fixtures.records) this.records.insert(r.key, r)
    this.initialized.insert("seed", { value: true })
  }
  fetch(request: Request): Promise<Response> {
    return this.service.fetch(request)
  }
  async reset(): Promise<void> {
    await this.service.reset()
    this.seed()
  }
  private async exchange(c: OperationContext): Promise<Response> {
    const body = new URLSearchParams(
        c.body.kind === "form" ? (c.body.value as Record<string, string>) : {},
      ),
      basic = basicAuth(c.request)
    const clientId = basic?.username ?? body.get("client_id") ?? "",
      client = this.clients.get(clientId)
    if (!client || client.secret !== (basic?.password ?? body.get("client_secret")))
      return oauthError("invalid_client", "Invalid client_id.")
    if (!c.request.headers.get("content-type")?.startsWith("application/x-www-form-urlencoded"))
      return oauthError("invalid_request", "Expected form encoded body.")
    let userId: string, scopes: string[]
    if (body.get("grant_type") === "refresh_token") {
      const previous = this.grants
        .list({ order: "oldest" })
        .map((r) => r.value)
        .find(
          (g) =>
            g.refreshToken &&
            g.refreshToken === body.get("refresh_token") &&
            g.clientId === clientId,
        )
      if (!previous) return oauthError("invalid_grant", "Invalid refresh_token.")
      userId = previous.userId
      scopes = previous.scopes
      this.grants.update(previous.token, { ...previous, refreshToken: "" })
    } else if (body.get("grant_type") === "authorization_code") {
      const code = this.codes.get(body.get("code") ?? "")
      if (
        !code ||
        code.clientId !== clientId ||
        code.expiresAt <= this.now() ||
        code.redirectUri !== (body.get("redirect_uri") ?? undefined)
      )
        return oauthError("invalid_grant", "Invalid authorization code.")
      if (code.challenge) {
        const verifier = body.get("code_verifier") ?? ""
        const digest = new Uint8Array(
          await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
        )
        const encoded = btoa(String.fromCharCode(...digest))
          .replaceAll("+", "-")
          .replaceAll("/", "_")
          .replaceAll("=", "")
        if (verifier.length < 43 || verifier.length > 128 || encoded !== code.challenge)
          return oauthError("invalid_grant", "Invalid code_verifier.")
      }
      userId = code.userId
      scopes = code.scopes
      // PKCE hashing yielded: re-check before the synchronous claim to reject a concurrent replay.
      if (!this.codes.has(code.code) || code.expiresAt <= this.now())
        return oauthError("invalid_grant", "Authorization code already used or expired.")
      this.codes.delete(code.code)
    } else return oauthError("unsupported_grant_type", "Unsupported grant_type.")
    const token = this.ids.next("mock_access"),
      refreshToken = this.ids.next("mock_refresh")
    this.grants.insert(token, {
      token,
      refreshToken,
      clientId,
      userId,
      scopes,
      expiresAt: this.now() + this.ttl * 1000,
    })
    return jsonRes(200, {
      access_token: token,
      refresh_token: refreshToken,
      expires_in: this.ttl,
      token_type: "bearer",
    })
  }
  private list(c: OperationContext, collection: CollectionName): Response {
    const grant = this.grants.get(bearerToken(c.request) ?? "")
    if (!grant || grant.expiresAt <= this.now()) return unauthorized()
    if (!grant.scopes.includes(COLLECTION_SCOPES[collection]))
      return jsonRes(403, { detail: "Access forbidden." })
    const query = new URL(c.request.url).searchParams,
      timed = collection === "heartrate"
    const from = query.get(timed ? "start_datetime" : "start_date"),
      to = query.get(timed ? "end_datetime" : "end_date")
    const valid = (s: string) =>
      Number.isFinite(Date.parse(s)) && (timed ? /T/.test(s) : /^\d{4}-\d{2}-\d{2}(T|$)/.test(s))
    if (
      (from && !valid(from)) ||
      (to && !valid(to)) ||
      (from && to && Date.parse(from) > Date.parse(to))
    )
      return jsonRes(400, { detail: "Invalid date range." })
    const rows = this.records
      .list({ order: "oldest" })
      .map((r) => r.value)
      .filter((r) => r.userId === grant.userId && r.collection === collection)
      .filter((r) => {
        const date = String(r.data[timed ? "timestamp" : "day"] ?? ""),
          time = Date.parse(date)
        return (!from || time >= Date.parse(from)) && (!to || time <= Date.parse(to))
      })
    const cursor = query.get("next_token"),
      offset = cursor ? rows.findIndex((r) => r.key === cursor) + 1 : 0
    if (cursor && offset === 0) return jsonRes(400, { detail: "Invalid next_token." })
    const page = rows.slice(offset, offset + this.pageSize)
    return jsonRes(200, {
      data: page.map((r) => r.data),
      next_token: offset + page.length < rows.length ? page.at(-1)?.key : null,
    })
  }
}
