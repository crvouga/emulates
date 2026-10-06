import type { FetchAPI } from "@emulators/core"
import {
  type APIOptions,
  annotateResponse,
  bearerToken,
  bootSqlite,
  createService,
  defineOperations,
  faultEffect,
  type OperationContext,
  type Service,
} from "@emulators/service"
import type { SqliteClient } from "@emulators/sqlite-client"
import { AdsEngine } from "./ads.js"
import { AnalyticsEngine, type AnalyticsEvent } from "./analytics.js"
import { integer, invalid, present, Rejection, record, reject, rpcError } from "./errors.js"
import { document, type SupportedOperationId } from "./generated/openapi.js"
import {
  DEFAULT_ACTIONS,
  DEFAULT_API_SECRET,
  DEFAULT_BUDGETS,
  DEFAULT_CAMPAIGNS,
  DEFAULT_CUSTOMER,
  DEFAULT_CUSTOMERS,
  DEFAULT_MEASUREMENT,
  DEFAULT_PROPERTY,
  DEFAULT_TOKEN,
  type Fixtures,
  fingerprint,
  GoogleAdsState,
  key,
  normalizeBudget,
  type RequestMetadata,
  type Settings,
  validateMetric,
} from "./state.js"
import { createVaultKey, Vault } from "./vault.js"

export type { AnalyticsEvent, ValidationMessage } from "./analytics.js"
export { document, supportedOperationIds } from "./generated/openapi.js"
export type {
  ActionFixture,
  BudgetFixture,
  CampaignFixture,
  CustomerFixture,
  Fixtures,
  MetricFixture,
  PropertyFixture,
  RequestMetadata,
  Settings,
} from "./state.js"
export {
  DEFAULT_ACTIONS,
  DEFAULT_API_SECRET,
  DEFAULT_BUDGETS,
  DEFAULT_CAMPAIGNS,
  DEFAULT_CUSTOMER,
  DEFAULT_CUSTOMERS,
  DEFAULT_MEASUREMENT,
  DEFAULT_PROPERTY,
  DEFAULT_TOKEN,
  fingerprint,
} from "./state.js"
export { createVaultKey } from "./vault.js"
export const GOOGLE_ADS_NAMESPACE = "google-ads"
export const DEFAULT_ADMIN_KEY = "fixture-google-ads-admin"
export type TokenFixture = {
  token: string
  customerIds?: readonly string[]
  propertyIds?: readonly string[]
  loginCustomerIds?: readonly string[]
  expiresAt?: number
  projectAccess?: "test" | "production"
}
export type GoogleAdsAPIOptions = APIOptions &
  Fixtures & {
    tokens?: readonly TokenFixture[]
    vaultKey?: Uint8Array
    publicNamespace?: string
    reportingLagMs?: number
    pageTokenTtlMs?: number
    /** Synthetic test policy; null disables local future rejection. This is not a claimed vendor bound. */
    futureToleranceMs?: number | null
  }
const isMP = (path: string): boolean => path === "/mp/collect" || path === "/debug/mp/collect"
export class GoogleAdsAPI implements FetchAPI {
  readonly sqlite: SqliteClient
  readonly state: GoogleAdsState
  readonly app: Service["app"]
  private readonly service: Service
  private readonly now: () => number
  private readonly fixtures: Required<Fixtures>
  private readonly tokens: readonly TokenFixture[]
  private readonly initialSettings: Settings
  private readonly requestIds = new WeakMap<Request, string>()
  private readonly ads: AdsEngine
  private readonly analytics: AnalyticsEngine
  constructor(options: GoogleAdsAPIOptions = {}) {
    this.sqlite = options.sqlite ?? bootSqlite()
    this.now = options.now ?? Date.now
    this.tokens = structuredClone(options.tokens ?? [{ token: DEFAULT_TOKEN }])
    if (
      this.tokens.some(
        (t) => !t.token || (t.expiresAt !== undefined && !Number.isSafeInteger(t.expiresAt)),
      ) ||
      new Set(this.tokens.map((t) => t.token)).size !== this.tokens.length
    )
      throw new Error("Invalid synthetic token fixtures")
    this.fixtures = structuredClone({
      customers: options.customers ?? DEFAULT_CUSTOMERS,
      budgets: options.budgets ?? DEFAULT_BUDGETS,
      campaigns: options.campaigns ?? DEFAULT_CAMPAIGNS,
      actions: options.actions ?? DEFAULT_ACTIONS,
      metrics: options.metrics ?? [
        {
          customerId: DEFAULT_CUSTOMER,
          campaignId: "3000000001",
          date: new Date(this.now()).toISOString().slice(0, 10),
          costMicros: "12345678",
          clicks: "7",
          impressions: "123",
          conversions: 1.25,
          conversionsValue: 42.75,
          conversionActionId: "4000000001",
        },
      ],
      properties: options.properties ?? [
        {
          id: DEFAULT_PROPERTY,
          measurementId: DEFAULT_MEASUREMENT,
          apiSecret: DEFAULT_API_SECRET,
          currencyCode: "USD",
          timeZone: "UTC",
        },
      ],
    })
    this.initialSettings = {
      initialized: true,
      nextBudgetId: "9000000001",
      nextJobId: "2147483648",
      reportingLagMs: integer(options.reportingLagMs ?? 0, "reportingLagMs"),
      pageTokenTtlMs: integer(options.pageTokenTtlMs ?? 3600000, "pageTokenTtlMs", 1),
      futureToleranceMs:
        options.futureToleranceMs === null
          ? null
          : integer(options.futureToleranceMs ?? 60000, "futureToleranceMs"),
    }
    this.state = new GoogleAdsState(
      this.sqlite,
      options.namespace ?? GOOGLE_ADS_NAMESPACE,
      new Vault(options.vaultKey ?? createVaultKey()),
      options.publicNamespace,
    )
    this.ensureSeeded()
    this.ads = new AdsEngine(this.state, this.now)
    this.analytics = new AnalyticsEngine(this.state, this.now, this.fixtures.properties)
    const wrap =
      (fn: (c: OperationContext) => Response) =>
      (c: OperationContext): Response => {
        try {
          if (c.request.signal.aborted) throw c.request.signal.reason
          return fn(c)
        } catch (e) {
          if (e instanceof Rejection) return e.response(this.id(c.request))
          throw e
        }
      }
    this.service = createService({
      document,
      sqlite: this.sqlite,
      namespace: options.namespace ?? GOOGLE_ADS_NAMESPACE,
      now: this.now,
      handlers: defineOperations<SupportedOperationId>({
        SearchGoogleAds: wrap((c) =>
          Response.json(
            this.ads.search(
              present(c.params.customerId),
              record(c.body.kind === "json" ? c.body.value : undefined),
              false,
              this.id(c.request),
            ),
          ),
        ),
        SearchStreamGoogleAds: wrap((c) =>
          Response.json(
            this.ads.search(
              present(c.params.customerId),
              record(c.body.kind === "json" ? c.body.value : undefined),
              true,
              this.id(c.request),
            ),
          ),
        ),
        MutateCampaignBudgets: wrap((c) => {
          const body = record(c.body.kind === "json" ? c.body.value : undefined),
            result = this.ads.mutate(
              present(c.params.customerId),
              body,
              this.id(c.request),
              !!faultEffect(c.request, "partial_failure"),
            )
          if (!body.validateOnly && faultEffect(c.request, "ambiguous_mutation"))
            return rpcError(
              503,
              "Response unavailable after the budget mutation; reconcile before retrying",
            )
          return annotateResponse(Response.json(result), {
            ids: { customer: present(c.params.customerId) },
          })
        }),
        UploadClickConversions: wrap((c) =>
          annotateResponse(
            Response.json(
              this.ads.upload(
                present(c.params.customerId),
                record(c.body.kind === "json" ? c.body.value : undefined),
                this.id(c.request),
                !!faultEffect(c.request, "partial_failure"),
              ),
            ),
            { ids: { customer: present(c.params.customerId) } },
          ),
        ),
        CollectAnalyticsEvents: wrap((c) =>
          this.collect(
            c.request,
            c.url,
            c.body.kind === "json" ? c.body.value : undefined,
            c.body.kind !== "json",
          ),
        ),
        ValidateAnalyticsEvents: wrap((c) =>
          this.collect(
            c.request,
            c.url,
            c.body.kind === "json" ? c.body.value : undefined,
            c.body.kind !== "json",
            true,
          ),
        ),
        RunAnalyticsReport: wrap((c) =>
          this.analytics.report(
            present(c.params.propertyId),
            record(c.body.kind === "json" ? c.body.value : undefined),
          ),
        ),
        BatchRunAnalyticsReports: wrap((c) =>
          this.analytics.batch(
            present(c.params.propertyId),
            record(c.body.kind === "json" ? c.body.value : undefined),
          ),
        ),
      }),
      notFound: () => rpcError(404, "Unsupported Google API route"),
      onError: (e, request) => {
        const url = new URL(request.url)
        if (isMP(url.pathname))
          return this.collect(request, url, undefined, true, url.pathname.startsWith("/debug/"))
        if (e instanceof Rejection) return e.response(this.id(request))
        return rpcError(400, "Invalid JSON request body")
      },
    })
    this.app = this.service.app
  }
  private id(request: Request): string {
    let id = this.requestIds.get(request)
    if (!id) {
      id = this.state.ids.next("request_", 24)
      this.requestIds.set(request, id)
    }
    return id
  }
  private authenticate(request: Request): void {
    const path = new URL(request.url).pathname
    if (isMP(path)) return
    const token = this.tokens.find((t) => t.token === bearerToken(request))
    if (!token)
      reject("OAUTH_TOKEN_INVALID", "Invalid OAuth bearer token", "authenticationError", 401)
    if (token.expiresAt !== undefined && token.expiresAt <= this.now())
      reject("OAUTH_TOKEN_EXPIRED", "OAuth bearer token has expired", "authenticationError", 401)
    const customer = /^\/v25\/customers\/(\d+)/.exec(path)?.[1],
      property = /^\/v1beta\/properties\/(\d+)/.exec(path)?.[1]
    if (customer) {
      if (
        !this.state.customers.has(customer) ||
        (token.customerIds && !token.customerIds.includes(customer))
      )
        reject(
          "USER_PERMISSION_DENIED",
          "OAuth principal cannot access this customer",
          "authorizationError",
          403,
        )
      const login = request.headers.get("login-customer-id")
      if (
        login &&
        ((login !== customer && login !== present(this.state.customers.get(customer)).managerId) ||
          (token.loginCustomerIds && !token.loginCustomerIds.includes(login)))
      )
        reject(
          "INVALID_LOGIN_CUSTOMER_ID_SERVING_CUSTOMER_ID_COMBINATION",
          "Login customer cannot access the serving customer",
          "authorizationError",
          403,
        )
      if (token.projectAccess === "test")
        reject(
          "CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION",
          "Fixture project is not approved for this production customer",
          "authorizationError",
          403,
        )
    }
    if (
      property &&
      (!this.state.properties.has(property) ||
        (token.propertyIds && !token.propertyIds.includes(property)))
    )
      reject(
        "USER_PERMISSION_DENIED",
        "OAuth principal cannot access this property",
        "authorizationError",
        403,
      )
    // Google's September 2026 policy makes developer-token optional and ignored.
  }
  async fetch(request: Request): Promise<Response> {
    if (request.signal.aborted)
      throw request.signal.reason ?? new DOMException("Aborted", "AbortError")
    const id = this.id(request),
      url = new URL(request.url)
    let body: unknown
    try {
      body = await request.clone().json()
    } catch {
      body = null
    }
    const b = record(body)
    const operation = /googleAds:searchStream$/.test(url.pathname)
      ? "SearchStreamGoogleAds"
      : /googleAds:search$/.test(url.pathname)
        ? "SearchGoogleAds"
        : /campaignBudgets:mutate$/.test(url.pathname)
          ? "MutateCampaignBudgets"
          : /:uploadClickConversions$/.test(url.pathname)
            ? "UploadClickConversions"
            : url.pathname === "/mp/collect"
              ? "CollectAnalyticsEvents"
              : url.pathname === "/debug/mp/collect"
                ? "ValidateAnalyticsEvents"
                : /:batchRunReports$/.test(url.pathname)
                  ? "BatchRunAnalyticsReports"
                  : /:runReport$/.test(url.pathname)
                    ? "RunAnalyticsReport"
                    : "Unsupported"
    const customerId = /^\/v25\/customers\/(\d+)/.exec(url.pathname)?.[1]
    const metadata: RequestMetadata = {
      id,
      operationId: operation,
      createdAt: this.now(),
      bodyHash: fingerprint(body),
      developerTokenPresent: request.headers.has("developer-token"),
      loginCustomerPresent: request.headers.has("login-customer-id"),
      ...(customerId ? { customerId } : {}),
      ...(typeof b.validateOnly === "boolean" ? { validateOnly: b.validateOnly } : {}),
    }
    this.state.requests.insert(id, metadata)
    let response: Response
    try {
      this.authenticate(request)
      response = await this.service.fetch(request)
    } catch (e) {
      if (e instanceof Rejection) response = e.response(id)
      else throw e
    }
    if (url.pathname.startsWith("/v25/")) response.headers.set("request-id", id)
    return response
  }
  private collect(
    request: Request,
    url: URL,
    input: unknown,
    malformed = false,
    debug = false,
  ): Response {
    const result = this.analytics.collect(url, input, malformed, debug),
      id = this.id(request),
      prior = this.state.requests.get(id)
    if (prior)
      this.state.requests.update(id, {
        ...prior,
        accepted: result.accepted,
        rejected: result.rejected,
        duplicate: result.duplicate,
        reasons: result.reasons,
        eventCount: result.eventCount,
        ...(result.propertyId ? { propertyId: result.propertyId } : {}),
      })
    return result.response
  }
  private ensureSeeded(): void {
    if (this.state.settings.has("settings")) return
    const { customers, budgets, campaigns, actions, metrics, properties } = this.fixtures
    const normalizedBudgets = budgets.map(normalizeBudget),
      normalizedMetrics = metrics.map(validateMetric)
    const unique = (values: readonly string[]): boolean => new Set(values).size === values.length
    if (
      !unique(customers.map((c) => c.id)) ||
      customers.some(
        (c) => !/^\d+$/.test(c.id) || !c.descriptiveName || !/^[A-Z]{3}$/.test(c.currencyCode),
      )
    )
      throw new Error("Invalid customer fixtures")
    if (
      !unique(normalizedBudgets.map((b) => key(b.customerId, b.id))) ||
      normalizedBudgets.some((b) => !customers.some((c) => c.id === b.customerId))
    )
      throw new Error("Invalid budget fixtures")
    if (
      !unique(campaigns.map((c) => key(c.customerId, c.id))) ||
      campaigns.some(
        (c) =>
          !/^[1-9]\d*$/.test(c.id) ||
          !c.name ||
          !["ENABLED", "PAUSED", "REMOVED"].includes(c.status) ||
          !normalizedBudgets.some((b) => b.customerId === c.customerId && b.id === c.budgetId),
      )
    )
      throw new Error("Invalid campaign fixtures")
    if (
      !unique(actions.map((a) => key(a.customerId, a.id))) ||
      actions.some(
        (a) => !/^[1-9]\d*$/.test(a.id) || !a.name || !customers.some((c) => c.id === a.customerId),
      )
    )
      throw new Error("Invalid conversion action fixtures")
    const campaignIds = new Set(campaigns.map((c) => key(c.customerId, c.id))),
      actionIds = new Set(actions.map((a) => key(a.customerId, a.id)))
    if (
      normalizedMetrics.some(
        (m) =>
          !campaignIds.has(key(m.customerId, m.campaignId)) ||
          (m.conversionActionId && !actionIds.has(key(m.customerId, m.conversionActionId))),
      )
    )
      throw new Error("Invalid metric references")
    if (
      !unique(properties.map((p) => p.id)) ||
      !unique(properties.map((p) => p.measurementId)) ||
      properties.some((p) => !/^\d+$/.test(p.id) || !p.measurementId || !p.apiSecret)
    )
      throw new Error("Invalid property fixtures")
    for (const p of [...customers, ...properties])
      new Intl.DateTimeFormat("en", { timeZone: p.timeZone ?? "UTC" })
    this.sqlite.transaction(() => {
      for (const c of customers) this.state.customers.insert(c.id, c)
      for (const b of normalizedBudgets) this.state.budgets.insert(key(b.customerId, b.id), b)
      for (const c of campaigns) this.state.campaigns.insert(key(c.customerId, c.id), c)
      for (const a of actions) this.state.actions.insert(key(a.customerId, a.id), a)
      for (const [index, m] of normalizedMetrics.entries())
        this.state.metrics.insert(`fixture_metric_${index}`, m)
      for (const { apiSecret: _secret, ...p } of properties)
        this.state.properties.insert(p.id, {
          ...p,
          currencyCode: p.currencyCode ?? "USD",
          timeZone: p.timeZone ?? "UTC",
        })
      this.state.settings.insert("settings", this.initialSettings)
    })
  }
  seedMetrics(input: unknown): number {
    const values = record(input).metrics
    if (!Array.isArray(values)) invalid("metrics must be an array")
    const metrics = values.map(validateMetric)
    if (
      metrics.some(
        (m) =>
          !this.state.campaigns.has(key(m.customerId, m.campaignId)) ||
          (m.conversionActionId &&
            !this.state.actions.has(key(m.customerId, m.conversionActionId))),
      )
    )
      invalid("Metric references an unknown resource")
    this.sqlite.transaction(() => {
      for (const m of metrics) this.state.metrics.insert(this.state.ids.next("metric_"), m)
    })
    return metrics.length
  }
  configure(input: unknown): Settings {
    return this.state.configure(record(input))
  }
  inspectEvents(): (AnalyticsEvent & {
    id: string
    propertyId?: string
    createdAt: number
    availableAt: number
  })[] {
    return this.state.events.list({ order: "oldest" }).map(({ value: v }) => ({
      ...this.state.open<AnalyticsEvent>(v.sealed, "event", v.id),
      id: v.id,
      ...(v.propertyId ? { propertyId: v.propertyId } : {}),
      createdAt: v.createdAt,
      availableAt: v.availableAt,
    }))
  }
  inspectConversions(): Record<string, unknown>[] {
    return this.state.conversions.list({ order: "oldest" }).map(({ value: v }) => ({
      ...this.state.open<Record<string, unknown>>(v.sealed, "conversion", v.id),
      id: v.id,
      customerId: v.customerId,
      availableAt: v.availableAt,
    }))
  }
  expirePageTokens(): number {
    const snapshots = this.state.snapshots.list()
    for (const { value: v } of snapshots)
      this.state.snapshots.update(v.id, { ...v, expiresAt: this.now() })
    return snapshots.length
  }
  async reset(): Promise<void> {
    await this.service.reset()
    this.ensureSeeded()
  }
}
export type { GoogleAdsRuntime, GoogleAdsRuntimeOptions } from "./runtime.js"
export { createRuntime, GOOGLE_ADS_PRESETS } from "./runtime.js"
