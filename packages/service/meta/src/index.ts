import type { FetchAPI } from "@emulators/core"
import {
  type APIOptions,
  annotateResponse,
  bearerToken,
  bodyIssues,
  bootSqlite,
  createService,
  DroppedConnectionError,
  defineOperations,
  faultEffect,
  jsonRes,
  type OperationContext,
  type Service,
} from "@emulators/service"
import type { SqliteClient } from "@emulators/sqlite-client"
import type { Hono } from "hono"
import { document, type SupportedOperationId } from "./generated/openapi.js"
import { type Insight, type MetaEvent, type MetaSettings, MetaState } from "./state.js"

export type { FetchAPI } from "@emulators/core"
export type { SqliteClient } from "@emulators/sqlite-client"
export type { OperationId, SupportedOperationId } from "./generated/openapi.js"
export { document, operationIds, supportedOperationIds } from "./generated/openapi.js"
export { createRuntime, META_PRESETS } from "./runtime.js"
export type { Insight, MarketingObject, MetaEvent, MetaSettings } from "./state.js"
export { DEFAULT_SETTINGS, MetaState } from "./state.js"

export const META_NAMESPACE = "meta"

export type MetaAPIOptions = APIOptions & { settings?: Partial<MetaSettings> }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** Bearer access token, or the access_token query parameter used by Graph API clients. */
export const accessTokenCredential = (request: Request): string | undefined =>
  bearerToken(request) ?? new URL(request.url).searchParams.get("access_token") ?? undefined

const field = (record: Record<string, unknown>, key: string): string | null =>
  typeof record[key] === "string" ? record[key] : null

const HASHED_USER_FIELDS = [
  "external_id",
  "em",
  "ph",
  "fn",
  "ln",
  "ct",
  "st",
  "zp",
  "db",
  "country",
]
const sha256 = /^[a-f0-9]{64}$/i

const invalidHash = (userData: Record<string, unknown>): string | undefined => {
  for (const name of HASHED_USER_FIELDS) {
    const raw = userData[name]
    if (raw === undefined) continue
    const values = Array.isArray(raw) ? raw : [raw]
    if (values.some((value) => typeof value !== "string" || !sha256.test(value))) return name
  }
  return undefined
}

/** Stateful subset of Meta Graph v26 used by marketing reporting and CAPI clients. */
export class MetaAPI implements FetchAPI {
  readonly app: Hono
  readonly sqlite: SqliteClient
  readonly state: MetaState
  private readonly service: Service
  private readonly now: () => number

  constructor(options: MetaAPIOptions = {}) {
    const sqlite = bootSqlite(options.sqlite)
    const namespace = options.namespace ?? META_NAMESPACE
    this.now = options.now ?? (() => Date.now())
    this.state = new MetaState(sqlite, namespace, options.settings)
    this.service = createService({
      document,
      handlers: defineOperations<SupportedOperationId>({
        PostPixelEvents: (context) => this.postEvents(context),
        GetInsights: (context) => this.getInsights(context),
        GetMarketingObject: (context) => this.getMarketingObject(context),
      }),
      sqlite,
      namespace,
      now: this.now,
      notFound: () => this.error(404, "Unsupported get request.", 100, 33),
      onError: (error) => {
        throw error
      },
      before: (context) => {
        const token = accessTokenCredential(context.request)
        if (!token) return this.error(401, "An active access token must be used.", 190, 463)
        const allowed = this.state.current().accessTokens
        if (allowed.length > 0 && !allowed.includes(token)) {
          return this.error(401, "Invalid OAuth access token.", 190, 467)
        }
        return undefined
      },
    })
    this.app = this.service.app
    this.sqlite = this.service.sqlite
  }

  fetch(request: Request): Promise<Response> {
    return this.service.fetch(request)
  }

  async reset(): Promise<void> {
    await this.service.reset()
    this.state.ensureSeeded()
  }

  events(): MetaEvent[] {
    return this.state.events.list().map((entry) => entry.value)
  }

  private trace(): string {
    return this.state.ids.next("trace_", 24)
  }

  private error(
    status: number,
    message: string,
    code: number,
    errorSubcode?: number,
    transient = false,
  ): Response {
    return jsonRes(status, {
      error: {
        message,
        type: code === 190 ? "OAuthException" : "GraphMethodException",
        code,
        ...(errorSubcode === undefined ? {} : { error_subcode: errorSubcode }),
        is_transient: transient,
        fbtrace_id: this.trace(),
      },
    })
  }

  private postEvents(context: OperationContext): Response {
    const issues = bodyIssues(context, "application/json")
    if (issues.length > 0)
      return this.error(400, `Invalid parameter: ${issues[0]?.path ?? "data"}`, 100)
    const body =
      context.body.kind === "json" && isRecord(context.body.value) ? context.body.value : null
    const data = Array.isArray(body?.data) ? body.data : []
    if (data.length === 0) return this.error(400, "The parameter data is required.", 100)
    const pixelId = context.params.pixel_id ?? ""
    const testCode = typeof body?.test_event_code === "string" ? body.test_event_code : null
    const partial = faultEffect(context.request, "partial_acceptance") !== undefined
    let accepted = 0
    const messages: string[] = []
    for (let index = 0; index < data.length; index += 1) {
      const raw = data[index]
      if (!isRecord(raw)) return this.error(400, `Invalid parameter at data[${index}]`, 100)
      const eventName = field(raw, "event_name")
      const actionSource = field(raw, "action_source")
      const eventTime = typeof raw.event_time === "number" ? raw.event_time : Number.NaN
      const userData = isRecord(raw.user_data) ? raw.user_data : null
      if (!eventName || !actionSource || !Number.isInteger(eventTime) || !userData) {
        return this.error(400, `Invalid parameter at data[${index}]`, 100)
      }
      const badHash = invalidHash(userData)
      if (badHash) return this.error(400, `Invalid SHA-256 value for user_data.${badHash}.`, 100)
      const age = Math.floor(this.now() / 1000) - eventTime
      if (age > this.state.current().maxEventAgeSeconds) {
        return this.error(400, "Event time can be at most 7 days old.", 100)
      }
      if (age < -60) return this.error(400, "Event time cannot be in the future.", 100)
      if (partial && index > 0) {
        messages.push(`data[${index}] was not accepted by the scripted partial failure`)
        continue
      }
      const eventId = field(raw, "event_id")
      const id = eventId ? `${pixelId}:${eventId}` : this.state.ids.next("evt_", 24)
      if (!this.state.events.has(id)) {
        this.state.events.insert(id, {
          id,
          pixelId,
          event_name: eventName,
          event_time: eventTime,
          event_id: eventId,
          action_source: actionSource,
          event_source_url: field(raw, "event_source_url"),
          user_data: userData,
          custom_data: isRecord(raw.custom_data) ? raw.custom_data : {},
          test_event_code: testCode,
          accepted_at: Math.floor(this.now() / 1000),
        })
      }
      accepted += 1
    }
    if (faultEffect(context.request, "accepted_then_drop") !== undefined) {
      throw new DroppedConnectionError()
    }
    return annotateResponse(
      jsonRes(200, { events_received: accepted, messages, fbtrace_id: this.trace() }),
      { ids: { pixelId } },
    )
  }

  private getInsights(context: OperationContext): Response {
    const accountId = context.params.account_id ?? ""
    let since: string | undefined
    let until: string | undefined
    if (typeof context.query.time_range === "string") {
      try {
        const parsed = JSON.parse(context.query.time_range) as unknown
        if (!isRecord(parsed)) throw new Error("not an object")
        since = typeof parsed.since === "string" ? parsed.since : undefined
        until = typeof parsed.until === "string" ? parsed.until : undefined
      } catch {
        return this.error(400, "Invalid parameter: time_range.", 100)
      }
    }
    const rows = this.state.insights
      .list({
        where: (row) =>
          row.account_id === accountId &&
          (since === undefined || row.date_start >= since) &&
          (until === undefined || row.date_stop <= until),
      })
      .map((entry) => entry.value)
      .sort((left, right) => left.date_start.localeCompare(right.date_start))
    const start = typeof context.query.after === "string" ? Number(context.query.after) : 0
    if (!Number.isInteger(start) || start < 0) return this.error(400, "Invalid cursor.", 100)
    const limit = Math.min(100, Math.max(1, Number(context.query.limit ?? 25)))
    const page = rows.slice(start, start + limit)
    const nextOffset = start + page.length
    const cursors = { before: String(start), after: String(nextOffset) }
    const paging: { cursors: typeof cursors; next?: string } = { cursors }
    if (nextOffset < rows.length) {
      const next = new URL(context.url)
      next.searchParams.set("after", String(nextOffset))
      paging.next = next.toString()
    }
    return jsonRes(200, { data: page.map((row) => this.renderInsight(row, context)), paging })
  }

  private renderInsight(row: Insight, context: OperationContext): Omit<Insight, "id"> {
    const { id: _id, country, ...rest } = row
    const wantsCountry =
      typeof context.query.breakdowns === "string" &&
      context.query.breakdowns.split(",").includes("country")
    return { ...rest, ...(wantsCountry && country ? { country } : {}) }
  }

  private getMarketingObject(context: OperationContext): Response {
    const id = context.params.object_id ?? ""
    const object = this.state.objects.get(id)
    if (!object)
      return this.error(
        404,
        `Unsupported get request. Object with ID '${id}' does not exist.`,
        100,
        33,
      )
    return annotateResponse(jsonRes(200, object), { ids: { marketingObjectId: id } })
  }
}
