import {
  type APIOptions,
  annotateResponse,
  bootSqlite,
  Collection,
  IdSequence,
} from "@emulators/service"
import { clearNamespace } from "@emulators/sqlite-client"

export { document, operationIds, supportedOperationIds } from "./generated/openapi.js"
export type { EventBridgeRuntime, EventBridgeRuntimeOptions } from "./runtime.js"
export { createRuntime, EVENTBRIDGE_PRESETS } from "./runtime.js"
export const EVENTBRIDGE_NAMESPACE = "eventbridge"
export type Rule = {
  Name: string
  Arn: string
  EventBusName?: string
  State?: string
  [key: string]: unknown
}
export type Target = {
  Id: string
  Arn: string
  EcsParameters?: Record<string, unknown>
  [key: string]: unknown
}
export type SeedRule = { rule: Rule; targets: Target[] }
type Cursor = { fingerprint: string; offset: number; expiresAt: number }
export type EventBridgeAPIOptions = APIOptions & { rules?: SeedRule[]; buses?: string[] }
export class EventBridgeAPI {
  readonly rules: Collection<SeedRule>
  readonly buses: Collection<{ name: string }>
  readonly cursors: Collection<Cursor>
  private readonly initialized: Collection<boolean>
  private readonly ids: IdSequence
  private readonly sqlite
  private readonly namespace: string
  private readonly now: () => number
  constructor(private readonly options: EventBridgeAPIOptions = {}) {
    this.sqlite = bootSqlite(options.sqlite)
    this.namespace = options.namespace ?? EVENTBRIDGE_NAMESPACE
    this.now = options.now ?? Date.now
    this.rules = new Collection(this.sqlite, this.namespace, "rules")
    this.buses = new Collection(this.sqlite, this.namespace, "buses")
    this.cursors = new Collection(this.sqlite, this.namespace, "cursors")
    this.initialized = new Collection(this.sqlite, this.namespace, "initialized")
    this.ids = new IdSequence(this.sqlite, this.namespace, "eventbridge")
    this.seed()
  }
  private seed() {
    if (this.initialized.get("seed")) return
    for (const bus of ["default", ...(this.options.buses ?? [])])
      this.buses.insert(bus, { name: bus })
    for (const resource of this.options.rules ?? [])
      this.rules.insert(
        `${resource.rule.EventBusName ?? "default"}:${resource.rule.Name}`,
        resource,
      )
    this.initialized.insert("seed", true)
  }
  async reset() {
    clearNamespace(this.sqlite, this.namespace)
    this.seed()
  }
  private response(body: unknown, status = 200) {
    return Response.json(body, {
      status,
      headers: {
        "content-type": "application/x-amz-json-1.1",
        "x-amzn-requestid": "mock-eventbridge-request",
      },
    })
  }
  private error(type: string, message: string, status = 400) {
    return this.response({ __type: type, message }, status)
  }
  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST" || new URL(request.url).pathname !== "/")
      return this.error("UnknownOperationException", "Unknown operation", 404)
    const target = request.headers.get("x-amz-target")
    if (target !== "AWSEvents.ListRules" && target !== "AWSEvents.ListTargetsByRule")
      return this.error("UnknownOperationException", "Unknown operation")
    const raw: unknown = await request.json().catch(() => null)
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      return this.error("SerializationException", "Expected a JSON object")
    const body = raw as Record<string, unknown>
    for (const field of ["NamePrefix", "Rule", "EventBusName", "NextToken"]) {
      const value = body[field]
      if (
        value !== undefined &&
        (typeof value !== "string" ||
          !value.length ||
          value.length > (field === "NextToken" ? 2048 : field === "EventBusName" ? 1600 : 64))
      )
        return this.error("ValidationException", `Invalid ${field}`)
    }
    if (
      body.Limit !== undefined &&
      (!Number.isInteger(body.Limit) || Number(body.Limit) < 1 || Number(body.Limit) > 100)
    )
      return this.error("ValidationException", "Limit must be between 1 and 100")
    const bus = String(body.EventBusName ?? "default")
      .split(":event-bus/")
      .at(-1) as string
    if (!this.buses.get(bus))
      return this.error("ResourceNotFoundException", "Event bus does not exist")
    let items: (Rule | Target)[]
    let key: string
    if (target === "AWSEvents.ListRules") {
      key = "Rules"
      items = this.rules
        .list({ order: "oldest" })
        .map(({ value }) => value.rule)
        .filter(
          (rule) =>
            (rule.EventBusName ?? "default") === bus &&
            rule.Name.startsWith(String(body.NamePrefix ?? "")),
        )
    } else {
      if (!body.Rule) return this.error("ValidationException", "Rule is required")
      const resource = this.rules.get(`${bus}:${body.Rule}`)
      if (!resource) return this.error("ResourceNotFoundException", "Rule does not exist")
      key = "Targets"
      items = resource.targets
    }
    const limit = Number(body.Limit ?? 100)
    const fingerprint = JSON.stringify([
      target,
      bus,
      body.NamePrefix ?? null,
      body.Rule ?? null,
      limit,
    ])
    let offset = 0
    if (body.NextToken) {
      const cursor = this.cursors.get(String(body.NextToken))
      if (!cursor || cursor.fingerprint !== fingerprint || cursor.expiresAt <= this.now())
        return this.error("InvalidToken", "Invalid or expired pagination token")
      offset = cursor.offset
    }
    const page = items.slice(offset, offset + limit)
    const result: Record<string, unknown> = { [key]: page }
    if (offset + limit < items.length) {
      const token = this.ids.next("mock-page-", 16)
      this.cursors.insert(token, {
        fingerprint,
        offset: offset + limit,
        expiresAt: this.now() + 3600000,
      })
      result.NextToken = token
    }
    return annotateResponse(this.response(result), {
      ids: Object.fromEntries(page.map((item, index) => [String(index), item.Arn])),
    })
  }
}

export { EventbridgeAPI } from "./aws.js"
export type { Runtime as AwsRuntime, RuntimeOptions as AwsRuntimeOptions } from "./aws-runtime.js"
export { createRuntime as createAwsRuntime } from "./aws-runtime.js"
