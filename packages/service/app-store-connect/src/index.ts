import type { FetchAPI } from "@emulators/core"
import {
  type APIOptions,
  annotateResponse,
  bearerToken,
  bodyIssues,
  bootSqlite,
  Collection,
  createService,
  defineOperations,
  IdSequence,
  jsonRes,
  type OperationContext,
  type Service,
} from "@emulators/service"
import { type ApiKey, matchesScope, verify } from "./auth.js"
import { document, type SupportedOperationId } from "./generated/openapi.js"

export type { ApiKey } from "./auth.js"
export type { OperationId, SupportedOperationId } from "./generated/openapi.js"
export { document, operationIds, supportedOperationIds } from "./generated/openapi.js"
export type { AppStoreConnectRuntime, AppStoreConnectRuntimeOptions } from "./runtime.js"
export { APP_STORE_CONNECT_PRESETS, createRuntime } from "./runtime.js"
export const APP_STORE_CONNECT_NAMESPACE = "app-store-connect"
export type ResourceType = "apps" | "users" | "userInvitations" | "betaGroups" | "betaTesters"
export type Linkage = { type: ResourceType; id: string }
export type Resource = Linkage & {
  attributes: Record<string, unknown>
  relationships?: Record<string, { data: Linkage | Linkage[] | null }>
}
export type AppStoreConnectAPIOptions = APIOptions & {
  keys?: readonly ApiKey[]
  resources?: readonly Resource[]
  adminPrefix?: string
  publicNamespace?: string
}
export const DEFAULT_RESOURCES: readonly Resource[] = [
  {
    type: "apps",
    id: "app_mock",
    attributes: {
      name: "Synthetic App",
      bundleId: "test.example.synthetic",
      sku: "synthetic",
      primaryLocale: "en-US",
    },
  },
]
const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
const error = (status: number, code: string, detail: string) =>
  jsonRes(status, {
    errors: [
      {
        status: String(status),
        code,
        title:
          (
            {
              400: "Invalid request",
              401: "Authentication credentials are missing or invalid",
              403: "The request is forbidden",
              404: "The specified resource does not exist",
              409: "The provided entity includes an attribute with a value that has already been used",
            } as Record<number, string>
          )[status] ?? "Request failed",
        detail,
      },
    ],
  })
export class AppStoreConnectAPI implements FetchAPI {
  readonly sqlite
  readonly app
  readonly keys: Collection<ApiKey>
  readonly resources: Collection<Resource>
  readonly memberships: Collection<{ groupId: string; testerId: string }>
  readonly visibleApps: Collection<{ userId: string; appId: string }>
  private readonly initialized: Collection<boolean>
  private readonly ids: IdSequence
  private readonly service: Service
  private readonly now: () => number
  constructor(private readonly options: AppStoreConnectAPIOptions = {}) {
    this.sqlite = bootSqlite(options.sqlite)
    const namespace = options.namespace ?? APP_STORE_CONNECT_NAMESPACE
    this.now = options.now ?? Date.now
    this.keys = new Collection(this.sqlite, namespace, "keys")
    this.resources = new Collection(this.sqlite, namespace, "resources")
    this.memberships = new Collection(this.sqlite, namespace, "memberships")
    this.visibleApps = new Collection(this.sqlite, namespace, "visibleApps")
    this.initialized = new Collection(this.sqlite, namespace, "initialized")
    this.ids = new IdSequence(this.sqlite, namespace, `asc:${namespace}`)
    this.seed()
    this.service = createService({
      document,
      sqlite: this.sqlite,
      namespace,
      now: this.now,
      before: (c) => this.authorize(c),
      onError: (cause) => {
        throw cause
      },
      notFound: () => error(404, "NOT_FOUND", "Resource not found"),
      handlers: defineOperations<SupportedOperationId>({
        ListApps: (c) => this.list(c, "apps"),
        ListUsers: (c) => this.list(c, "users"),
        ListInvitations: (c) => this.list(c, "userInvitations"),
        ListGroups: (c) => this.list(c, "betaGroups"),
        ListTesters: (c) => this.list(c, "betaTesters"),
        CreateGroup: (c) => this.create(c, "betaGroups"),
        CreateTester: (c) => this.create(c, "betaTesters"),
        CreateInvitation: (c) => this.create(c, "userInvitations"),
        ListGroupTesters: (c) =>
          this.get("betaGroups", c.params.id ?? "")
            ? this.list(
                c,
                "betaTesters",
                this.memberships
                  .list()
                  .filter((r) => r.value.groupId === c.params.id)
                  .map((r) => r.value.testerId),
              )
            : error(404, "NOT_FOUND", "Group not found"),
        AddGroupTesters: (c) => this.groupMembers(c, false),
        RemoveGroupTesters: (c) => this.groupMembers(c, true),
        AddVisibleApps: (c) => this.addVisibleApps(c),
        DeleteUser: (c) => this.remove(c, "users"),
        DeleteInvitation: (c) => this.remove(c, "userInvitations"),
      }),
    })
    this.app = this.service.app
  }
  private seed() {
    if (this.initialized.has("seed")) return
    for (const key of this.options.keys ?? []) {
      if (key.publicKey.d !== undefined)
        throw new Error("Only public verification keys may be seeded")
      this.keys.insert(key.id, key)
    }
    for (const row of this.options.resources ?? DEFAULT_RESOURCES)
      this.resources.insert(`${row.type}:${row.id}`, row)
    for (const row of this.options.resources ?? DEFAULT_RESOURCES) {
      const related =
        row.type === "betaGroups"
          ? row.relationships?.betaTesters?.data
          : row.type === "betaTesters"
            ? row.relationships?.betaGroups?.data
            : row.type === "users"
              ? row.relationships?.visibleApps?.data
              : undefined
      if (!Array.isArray(related)) continue
      for (const edge of related) {
        if (!this.get(edge.type, edge.id))
          throw new Error("Seed relationship references a missing resource")
        if (row.type === "users" && edge.type === "apps") {
          const id = `${row.id}:${edge.id}`
          if (!this.visibleApps.has(id))
            this.visibleApps.insert(id, { userId: row.id, appId: edge.id })
        } else if (
          (row.type === "betaGroups" && edge.type === "betaTesters") ||
          (row.type === "betaTesters" && edge.type === "betaGroups")
        ) {
          const groupId = row.type === "betaGroups" ? row.id : edge.id
          const testerId = row.type === "betaTesters" ? row.id : edge.id
          const id = `${groupId}:${testerId}`
          if (!this.memberships.has(id)) this.memberships.insert(id, { groupId, testerId })
        }
      }
    }
    this.initialized.insert("seed", true)
  }
  fetch(request: Request) {
    this.seed()
    return this.service.fetch(request)
  }
  async reset() {
    await this.service.reset()
    this.seed()
  }
  private get(type: ResourceType, id: string) {
    return this.resources.get(`${type}:${id}`)
  }
  private async authorize(c: OperationContext) {
    const token = bearerToken(c.request)
    const auth = token ? await verify(token, (id) => this.keys.get(id), this.now()) : undefined
    if (!auth)
      return error(401, "NOT_AUTHORIZED", "Provide a valid ES256 token for a registered key")
    if (auth.scope && !matchesScope(auth.scope, c.request))
      return error(403, "FORBIDDEN_ERROR", "Token scope does not permit this request")
    if (c.request.method === "GET") return undefined
    const administrative = auth.key.role === "ADMIN" || auth.key.role === "ACCOUNT_HOLDER"
    const managerAllowed =
      auth.key.role === "APP_MANAGER" &&
      (c.url.pathname.startsWith("/v1/beta") ||
        (c.url.pathname === "/v1/userInvitations" && c.request.method === "POST"))
    if (!administrative && !managerAllowed)
      return error(403, "FORBIDDEN_ERROR", "Role does not permit this operation")
    return undefined
  }
  private view(row: Resource, c: OperationContext): Resource {
    const relationships = { ...row.relationships }
    if (row.type === "betaGroups")
      relationships.betaTesters = {
        data: this.memberships
          .list()
          .filter((r) => r.value.groupId === row.id)
          .map((r) => ({ type: "betaTesters", id: r.value.testerId })),
      }
    if (row.type === "betaTesters")
      relationships.betaGroups = {
        data: this.memberships
          .list()
          .filter((r) => r.value.testerId === row.id)
          .map((r) => ({ type: "betaGroups", id: r.value.groupId })),
      }
    if (row.type === "users")
      relationships.visibleApps = {
        data: this.visibleApps
          .list()
          .filter((r) => r.value.userId === row.id)
          .map((r) => ({ type: "apps", id: r.value.appId })),
      }
    const fields = c.url.searchParams.get(`fields[${row.type}]`)?.split(",")
    return {
      type: row.type,
      id: row.id,
      attributes: fields
        ? Object.fromEntries(Object.entries(row.attributes).filter(([key]) => fields.includes(key)))
        : row.attributes,
      relationships: fields
        ? Object.fromEntries(Object.entries(relationships).filter(([key]) => fields.includes(key)))
        : relationships,
    }
  }
  private url(c: OperationContext) {
    const url = new URL(c.url)
    if (this.options.publicNamespace && this.options.publicNamespace !== "default")
      url.pathname = `${this.options.adminPrefix ?? "/__admin"}/ns/${encodeURIComponent(this.options.publicNamespace)}${url.pathname}`
    return url
  }
  private list(c: OperationContext, type: ResourceType, selected?: string[]) {
    const q = c.url.searchParams
    const limit = Number(q.get("limit") ?? 50)
    if (!Number.isInteger(limit) || limit < 1 || limit > 200)
      return error(400, "PARAMETER_ERROR.INVALID", "Invalid limit")
    let rows = this.resources
      .list({ order: "oldest" })
      .map((r) => r.value)
      .filter((r) => r.type === type && (!selected || selected.includes(r.id)))
    for (const attribute of ["name", "email"])
      if (q.has(`filter[${attribute}]`))
        rows = rows.filter((r) =>
          q.get(`filter[${attribute}]`)?.split(",").includes(String(r.attributes[attribute])),
        )
    if (q.has("filter[app]"))
      rows = rows.filter((r) => {
        const appIds = q.get("filter[app]")?.split(",") ?? []
        if (r.type === "betaGroups") {
          const app = r.relationships?.app?.data
          return app && !Array.isArray(app) && appIds.includes(app.id)
        }
        if (r.type === "betaTesters")
          return this.memberships.list().some((edge) => {
            const app = this.get("betaGroups", edge.value.groupId)?.relationships?.app?.data
            return (
              edge.value.testerId === r.id && app && !Array.isArray(app) && appIds.includes(app.id)
            )
          })
        return true
      })
    const cursor = q.get("cursor")
    const index = cursor ? rows.findIndex((r) => r.id === cursor) : -1
    if (cursor && index < 0) return error(400, "PARAMETER_ERROR.INVALID", "Invalid cursor")
    const page = rows.slice(index + 1, index + 1 + limit)
    const next = this.url(c)
    const last = page.at(-1)
    if (last) next.searchParams.set("cursor", last.id)
    return jsonRes(200, {
      data: page.map((r) => this.view(r, c)),
      links: {
        self: this.url(c).toString(),
        next: last && index + 1 + page.length < rows.length ? next.toString() : null,
      },
      meta: { paging: { total: rows.length, limit } },
    })
  }
  private body(c: OperationContext) {
    return c.body.kind === "json" && bodyIssues(c).length === 0 ? record(c.body.value) : undefined
  }
  private linkages(value: unknown, type: ResourceType): Linkage[] | undefined {
    if (!Array.isArray(value)) return undefined
    const rows: Linkage[] = []
    for (const raw of value) {
      const row = record(raw)
      if (row?.type !== type || typeof row.id !== "string" || !this.get(type, row.id))
        return undefined
      if (!rows.some((existing) => existing.id === row.id)) rows.push({ type, id: row.id })
    }
    return rows
  }
  private create(c: OperationContext, type: "betaGroups" | "betaTesters" | "userInvitations") {
    const data = record(this.body(c)?.data),
      attributes = record(data?.attributes),
      relationships = record(data?.relationships)
    if (!data || data.type !== type || !attributes)
      return error(400, "ENTITY_ERROR.INVALID", "Invalid resource")
    if (
      type === "betaGroups"
        ? typeof attributes.name !== "string" || !attributes.name.trim()
        : typeof attributes.email !== "string" ||
          !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(attributes.email)
    )
      return error(409, "ENTITY_ERROR.ATTRIBUTE.INVALID", "Required name or email is invalid")
    if (
      type !== "betaGroups" &&
      this.resources
        .list()
        .some(
          (r) =>
            r.value.type === type &&
            String(r.value.attributes.email).toLowerCase() ===
              String(attributes.email).toLowerCase(),
        )
    )
      return error(409, "ENTITY_ERROR.ATTRIBUTE.UNIQUE", "Email already exists")
    const app = record(record(relationships?.app)?.data)
    if (
      type === "betaGroups" &&
      (app?.type !== "apps" || typeof app.id !== "string" || !this.get("apps", app.id))
    )
      return error(409, "ENTITY_ERROR.RELATIONSHIP.INVALID", "App not found")
    const relatedName =
      type === "betaGroups" ? "betaTesters" : type === "betaTesters" ? "betaGroups" : "visibleApps"
    const relatedType =
      type === "betaGroups" ? "betaTesters" : type === "betaTesters" ? "betaGroups" : "apps"
    const edges =
      relationships?.[relatedName] === undefined
        ? []
        : this.linkages(record(relationships[relatedName])?.data, relatedType)
    if (!edges) return error(409, "ENTITY_ERROR.RELATIONSHIP.INVALID", "Related resource not found")
    const id = this.ids.next(type)
    const row: Resource = {
      type,
      id,
      attributes: {
        ...attributes,
        ...(type === "betaGroups"
          ? { createdDate: new Date(this.now()).toISOString() }
          : type === "userInvitations"
            ? { expirationDate: new Date(this.now() + 3 * 86400_000).toISOString() }
            : {}),
      },
      ...(type === "betaGroups" && app
        ? { relationships: { app: { data: { type: "apps", id: String(app.id) } } } }
        : {}),
    }
    this.resources.insert(`${type}:${id}`, row)
    if (type === "betaGroups" || type === "betaTesters")
      for (const edge of edges) {
        const groupId = type === "betaGroups" ? id : edge.id,
          testerId = type === "betaTesters" ? id : edge.id
        this.memberships.insert(`${groupId}:${testerId}`, { groupId, testerId })
      }
    if (type === "userInvitations" && edges.length)
      this.resources.update(`${type}:${id}`, {
        ...row,
        relationships: { visibleApps: { data: edges } },
      })
    return annotateResponse(
      jsonRes(201, {
        data: this.view(this.get(type, id) ?? row, c),
        links: { self: `${this.url(c).toString()}/${id}` },
      }),
      { ids: { resourceId: id } },
    )
  }
  private groupMembers(c: OperationContext, remove: boolean) {
    const groupId = c.params.id ?? ""
    if (!this.get("betaGroups", groupId)) return error(404, "NOT_FOUND", "Group not found")
    const edges = this.linkages(this.body(c)?.data, "betaTesters")
    if (!edges) return error(409, "ENTITY_ERROR.RELATIONSHIP.INVALID", "Tester not found")
    for (const edge of edges) {
      const id = `${groupId}:${edge.id}`
      if (remove) this.memberships.delete(id)
      else if (!this.memberships.has(id))
        this.memberships.insert(id, { groupId, testerId: edge.id })
    }
    return annotateResponse(new Response(null, { status: 204 }), { ids: { groupId } })
  }
  private addVisibleApps(c: OperationContext) {
    const userId = c.params.id ?? ""
    if (!this.get("users", userId)) return error(404, "NOT_FOUND", "User not found")
    const edges = this.linkages(this.body(c)?.data, "apps")
    if (!edges) return error(409, "ENTITY_ERROR.RELATIONSHIP.INVALID", "App not found")
    for (const edge of edges) {
      const id = `${userId}:${edge.id}`
      if (!this.visibleApps.has(id)) this.visibleApps.insert(id, { userId, appId: edge.id })
    }
    return annotateResponse(new Response(null, { status: 204 }), { ids: { userId } })
  }
  private remove(c: OperationContext, type: "users" | "userInvitations") {
    const id = c.params.id ?? ""
    if (!this.resources.delete(`${type}:${id}`))
      return error(404, "NOT_FOUND", "Resource not found")
    if (type === "users")
      for (const edge of this.visibleApps.list())
        if (edge.value.userId === id) this.visibleApps.delete(edge.id)
    return annotateResponse(new Response(null, { status: 204 }), { ids: { resourceId: id } })
  }
}
