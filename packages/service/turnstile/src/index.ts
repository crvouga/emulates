import type { FetchAPI } from "@crvouga/mockingbird-core"
import {
  type APIOptions,
  bootSqlite,
  Collection,
  createService,
  defineOperations,
  IdempotencyStore,
  IdSequence,
  jsonRes,
  type OperationContext,
  type Service,
} from "@crvouga/mockingbird-service"
import type { Hono } from "hono"
import { document, type SupportedOperationId } from "./generated/openapi.js"

export type { OperationId, SupportedOperationId } from "./generated/openapi.js"
export { document, operationIds, supportedOperationIds } from "./generated/openapi.js"
export { createRuntime, TURNSTILE_PRESETS } from "./runtime.js"
export const TURNSTILE_NAMESPACE = "turnstile"
export type Site = { siteKey: string; secret: string }
export type Token = {
  token: string
  siteKey: string
  issuedAt: number
  hostname: string
  action: string
  cdata: string
  used: boolean
}
export type TurnstileAPIOptions = APIOptions & { sites?: Site[]; tokens?: Token[] }
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value)
const failure = (code: string) => jsonRes(200, { success: false, "error-codes": [code] })
export class TurnstileAPI implements FetchAPI {
  readonly app: Hono
  readonly tokens: Collection<Token>
  readonly attempts: Collection<{ at: number; success: boolean }>
  readonly sites: Collection<Site>
  private readonly initialized: Collection<{ value: boolean }>
  private readonly ids: IdSequence
  private readonly idempotency: IdempotencyStore
  private readonly service: Service
  private readonly now: () => number
  private readonly fixtures: { sites: Site[]; tokens: Token[] }
  constructor(options: TurnstileAPIOptions = {}) {
    const sqlite = bootSqlite(options.sqlite),
      namespace = options.namespace ?? TURNSTILE_NAMESPACE
    this.now = options.now ?? Date.now
    this.tokens = new Collection(sqlite, namespace, "tokens")
    this.attempts = new Collection(sqlite, namespace, "attempts")
    this.sites = new Collection(sqlite, namespace, "sites")
    this.initialized = new Collection(sqlite, namespace, "initialized")
    this.ids = new IdSequence(sqlite, namespace, `turnstile:${namespace}`)
    this.idempotency = new IdempotencyStore(sqlite, namespace)
    this.fixtures = structuredClone({
      sites: options.sites ?? [{ siteKey: "mock_site", secret: "mock_secret" }],
      tokens: options.tokens ?? [],
    })
    this.seed()
    this.service = createService({
      sqlite,
      namespace,
      document,
      now: this.now,
      notFound: () => jsonRes(404, { error: "Not found" }),
      onError: (error) => {
        throw error
      },
      handlers: defineOperations<SupportedOperationId>({
        Siteverify: (context) => this.verify(context),
      }),
    })
    this.app = this.service.app
  }
  private seed(): void {
    if (this.initialized.has("seed")) return
    for (const site of this.fixtures.sites) this.sites.insert(site.siteKey, site)
    for (const token of this.fixtures.tokens) this.tokens.insert(token.token, token)
    this.initialized.insert("seed", { value: true })
  }
  fetch(request: Request): Promise<Response> {
    return this.service.fetch(request)
  }
  async reset(): Promise<void> {
    await this.service.reset()
    this.seed()
  }
  issue(input: unknown): Response {
    if (!record(input)) return jsonRes(400, { error: "Expected token fixture object" })
    const siteKey = input.siteKey ?? "mock_site",
      hostname = input.hostname ?? "example.test",
      action = input.action ?? "",
      cdata = input.cdata ?? ""
    if (
      typeof siteKey !== "string" ||
      !this.sites.has(siteKey) ||
      typeof hostname !== "string" ||
      !hostname ||
      typeof action !== "string" ||
      !/^[A-Za-z0-9_-]{0,32}$/.test(action) ||
      typeof cdata !== "string" ||
      !/^[A-Za-z0-9_-]{0,255}$/.test(cdata)
    )
      return jsonRes(400, { error: "Invalid site, hostname, action or cdata" })
    const token = this.ids.next("mock_turnstile_", 24)
    this.tokens.insert(token, {
      token,
      siteKey,
      hostname,
      action,
      cdata,
      issuedAt: this.now(),
      used: false,
    })
    return jsonRes(200, { token })
  }
  private async verify(context: OperationContext): Promise<Response> {
    const body =
      context.body.kind === "json" || context.body.kind === "form" ? context.body.value : undefined
    if (!record(body)) return failure("bad-request")
    if (!body.secret) return failure("missing-input-secret")
    const site = this.sites
      .list()
      .map(({ value }) => value)
      .find((value) => value.secret === body.secret)
    if (!site) return failure("invalid-input-secret")
    if (!body.response) return failure("missing-input-response")
    if (typeof body.response !== "string" || body.response.length > 2048)
      return failure("invalid-input-response")
    const token = this.tokens.get(body.response)
    if (!token || token.siteKey !== site.siteKey) return failure("invalid-input-response")
    const key = body.idempotency_key
    if (
      key !== undefined &&
      (typeof key !== "string" || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(key))
    )
      return failure("bad-request")
    const validate = () => {
      const expired = token.used || this.now() - token.issuedAt >= 300_000
      this.attempts.insert(this.ids.next("attempt_", 20), { at: this.now(), success: !expired })
      if (expired) return failure("timeout-or-duplicate")
      this.tokens.insert(token.token, { ...token, used: true })
      return jsonRes(200, {
        success: true,
        "error-codes": [],
        challenge_ts: new Date(token.issuedAt).toISOString(),
        hostname: token.hostname,
        action: token.action,
        cdata: token.cdata,
      })
    }
    if (typeof key === "string")
      return this.idempotency.run(
        key,
        JSON.stringify([site.siteKey, token.token, body.remoteip ?? null]),
        { mismatch: () => failure("bad-request"), conflict: () => failure("internal-error") },
        validate,
      )
    return validate()
  }
}
