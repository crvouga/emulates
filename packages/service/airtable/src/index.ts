import type { FetchAPI } from "@emulators/core"
import {
  type APIOptions,
  annotateResponse,
  basicAuth,
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
import type { Hono } from "hono"
import { document, type SupportedOperationId } from "./generated/openapi.js"

export type { OperationId, SupportedOperationId } from "./generated/openapi.js"
export { document, operationIds, supportedOperationIds } from "./generated/openapi.js"
export type { AirtableRuntime, AirtableRuntimeOptions } from "./runtime.js"
export { AIRTABLE_PRESETS, createRuntime } from "./runtime.js"
export const AIRTABLE_NAMESPACE = "airtable"
export type Field = {
  id: string
  name: string
  type: string
  options?: Record<string, unknown>
  description?: string
}
export type Table = {
  id: string
  baseId: string
  name: string
  primaryFieldId: string
  fields: Field[]
  views: Record<string, unknown>[]
}
export type Base = {
  id: string
  name: string
  permissionLevel: "read" | "comment" | "edit" | "create"
}
export type Grant = {
  token: string
  refreshToken: string
  clientId: string
  userId: string
  email?: string
  scopes: string[]
  baseIds: string[]
  expiresAt: number
  refreshExpiresAt: number
}
export type Client = { id: string; secret?: string }
export type OAuthCode = {
  code: string
  clientId: string
  userId: string
  email?: string
  scopes: string[]
  baseIds: string[]
  redirectUri: string
  challenge: string
  expiresAt: number
}
export type StoredRecord = {
  id: string
  tableId: string
  fields: Record<string, unknown>
  createdTime: string
}
export type AirtableAPIOptions = APIOptions & {
  bases?: Base[]
  tables?: Table[]
  grants?: Grant[]
  clients?: Client[]
  codes?: OAuthCode[]
  records?: StoredRecord[]
  pageSize?: number
}
const err = (status: number, type: string, message: string) =>
  jsonRes(status, { error: { type, message } })
const denied = () =>
  err(
    403,
    "INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND",
    "Invalid permissions, or the requested model was not found.",
  )
const oauthError = (error: string) =>
  jsonRes(error === "invalid_client" ? 401 : 400, {
    error,
    error_description: error.replaceAll("_", " "),
  })
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v)
const textTypes = new Set([
  "singleLineText",
  "multilineText",
  "richText",
  "email",
  "url",
  "phoneNumber",
])
const numberTypes = new Set(["number", "percent", "currency", "duration", "rating"])
const supportedTypes = new Set([
  ...textTypes,
  ...numberTypes,
  "checkbox",
  "date",
  "dateTime",
  "singleSelect",
  "multipleSelects",
])

export class AirtableAPI implements FetchAPI {
  readonly app: Hono
  readonly grants: Collection<Grant>
  readonly clients: Collection<Client>
  readonly codes: Collection<OAuthCode>
  readonly bases: Collection<Base>
  readonly tables: Collection<Table>
  readonly records: Collection<StoredRecord>
  private readonly initialized: Collection<{ value: boolean }>
  private readonly ids: IdSequence
  private readonly service: Service
  private readonly now: () => number
  private readonly pageSize: number
  private readonly fixtures: Required<
    Pick<AirtableAPIOptions, "grants" | "clients" | "codes" | "bases" | "tables" | "records">
  >
  constructor(options: AirtableAPIOptions = {}) {
    const sqlite = bootSqlite(options.sqlite),
      namespace = options.namespace ?? AIRTABLE_NAMESPACE
    this.now = options.now ?? Date.now
    this.ids = new IdSequence(sqlite, namespace)
    this.grants = new Collection(sqlite, namespace, "grants")
    this.clients = new Collection(sqlite, namespace, "clients")
    this.codes = new Collection(sqlite, namespace, "codes")
    this.bases = new Collection(sqlite, namespace, "bases")
    this.tables = new Collection(sqlite, namespace, "tables")
    this.records = new Collection(sqlite, namespace, "records")
    this.initialized = new Collection(sqlite, namespace, "initialized")
    this.pageSize = options.pageSize ?? 1000
    if (!Number.isInteger(this.pageSize) || this.pageSize < 1)
      throw new Error("pageSize must be positive")
    this.fixtures = structuredClone({
      grants: options.grants ?? [
        {
          token: "mock_airtable_token",
          refreshToken: "mock_airtable_refresh",
          clientId: "mock_client",
          userId: "usrSynthetic",
          email: "synthetic@example.invalid",
          scopes: [
            "schema.bases:read",
            "schema.bases:write",
            "data.records:write",
            "user.email:read",
          ],
          baseIds: ["appMockBase"],
          expiresAt: 4102444800000,
          refreshExpiresAt: 4102444800000,
        },
      ],
      clients: options.clients ?? [{ id: "mock_client", secret: "mock_client_secret" }],
      codes: options.codes ?? [],
      records: options.records ?? [],
      bases: options.bases ?? [
        { id: "appMockBase", name: "Synthetic forms", permissionLevel: "create" },
      ],
      tables: options.tables ?? [
        {
          id: "tblMockTable",
          baseId: "appMockBase",
          name: "Submissions",
          primaryFieldId: "fldMockName",
          fields: [{ id: "fldMockName", name: "Name", type: "singleLineText" }],
          views: [],
        },
      ],
    })
    this.seed()
    this.service = createService({
      document,
      sqlite,
      namespace,
      now: this.now,
      notFound: () => err(404, "NOT_FOUND", "Not found"),
      onError: (error) => {
        throw error
      },
      handlers: defineOperations<SupportedOperationId>({
        OAuthToken: (c) => this.exchange(c),
        Whoami: (c) => this.whoami(c),
        ListBases: (c) => this.listBases(c),
        ListTables: (c) => this.listTables(c),
        CreateField: (c) => this.createField(c),
        CreateRecords: (c) => this.createRecords(c),
      }),
    })
    this.app = this.service.app
  }
  private seed() {
    if (this.initialized.has("seed")) return
    for (const g of this.fixtures.grants) this.grants.insert(g.token, g)
    for (const c of this.fixtures.clients) this.clients.insert(c.id, c)
    for (const c of this.fixtures.codes) this.codes.insert(c.code, c)
    for (const b of this.fixtures.bases) this.bases.insert(b.id, b)
    for (const t of this.fixtures.tables) this.tables.insert(t.id, t)
    for (const r of this.fixtures.records) this.records.insert(r.id, r)
    this.initialized.insert("seed", { value: true })
  }
  async fetch(r: Request): Promise<Response> {
    // OAuth rejects duplicate flat parameters; the shared bracket-form decoder
    // intentionally keeps only the last value, so inspect pairs before dispatch.
    if (
      r.method === "POST" &&
      new URL(r.url).pathname === "/oauth2/v1/token" &&
      r.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ===
        "application/x-www-form-urlencoded"
    ) {
      const pairs = new URLSearchParams(await r.clone().text())
      const names = new Set<string>()
      for (const name of pairs.keys()) {
        if (names.has(name)) return oauthError("invalid_request")
        names.add(name)
      }
    }
    return this.service.fetch(r)
  }
  async reset() {
    await this.service.reset()
    this.seed()
  }
  private grant(c: OperationContext): Grant | Response {
    const g = this.grants.get(bearerToken(c.request) ?? "")
    return !g || g.expiresAt <= this.now()
      ? err(401, "AUTHENTICATION_REQUIRED", "Authentication required")
      : g
  }
  private access(c: OperationContext, scope: string): { grant: Grant; base: Base } | Response {
    const g = this.grant(c)
    if (g instanceof Response) return g
    const base = this.bases.get(String(c.params.baseId))
    if (!base || !g.baseIds.includes(base.id) || !g.scopes.includes(scope)) return denied()
    if (scope === "schema.bases:write" && base.permissionLevel !== "create") return denied()
    if (scope === "data.records:write" && !["edit", "create"].includes(base.permissionLevel))
      return denied()
    return { grant: g, base }
  }
  private whoami(c: OperationContext) {
    const g = this.grant(c)
    if (g instanceof Response) return g
    return jsonRes(200, {
      id: g.userId,
      scopes: g.scopes,
      ...(g.scopes.includes("user.email:read") && g.email ? { email: g.email } : {}),
    })
  }
  private listBases(c: OperationContext) {
    const g = this.grant(c)
    if (g instanceof Response) return g
    if (!g.scopes.includes("schema.bases:read")) return denied()
    const rows = this.bases
      .list({ order: "oldest" })
      .map((r) => r.value)
      .filter((b) => g.baseIds.includes(b.id))
    const cursor = new URL(c.request.url).searchParams.get("offset"),
      offset = cursor ? rows.findIndex((b) => b.id === cursor) + 1 : 0
    if (cursor && offset === 0) return err(422, "INVALID_OFFSET_VALUE", "Invalid offset")
    const page = rows.slice(offset, offset + this.pageSize)
    return jsonRes(200, {
      bases: page,
      ...(offset + page.length < rows.length ? { offset: page.at(-1)?.id } : {}),
    })
  }
  private listTables(c: OperationContext) {
    const a = this.access(c, "schema.bases:read")
    if (a instanceof Response) return a
    return jsonRes(200, {
      tables: this.tables
        .list({ order: "oldest" })
        .map((r) => r.value)
        .filter((t) => t.baseId === a.base.id)
        .map(({ baseId, ...table }) => table),
    })
  }
  private table(baseId: string, id: string) {
    return this.tables
      .list({ order: "oldest" })
      .map((r) => r.value)
      .find((t) => t.baseId === baseId && (t.id === id || t.name === id))
  }
  private createField(c: OperationContext) {
    const a = this.access(c, "schema.bases:write")
    if (a instanceof Response) return a
    const table = this.table(a.base.id, String(c.params.tableId))
    if (!table) return denied()
    const b = c.body.kind === "json" ? c.body.value : null
    if (
      !object(b) ||
      bodyIssues(c).length ||
      typeof b.name !== "string" ||
      !b.name.trim() ||
      typeof b.type !== "string" ||
      !supportedTypes.has(b.type)
    )
      return err(422, "INVALID_REQUEST_UNKNOWN", "Invalid or unsupported field configuration")
    if (table.fields.some((f) => f.name === b.name))
      return err(422, "DUPLICATE_FIELD_NAME", "Duplicate field name")
    const options = object(b.options) ? b.options : undefined
    if (
      ["singleSelect", "multipleSelects"].includes(b.type) &&
      (!Array.isArray(options?.choices) ||
        !options.choices.every((v) => object(v) && typeof v.name === "string"))
    )
      return err(422, "INVALID_REQUEST_UNKNOWN", "Invalid choices")
    if (
      ["number", "percent", "currency"].includes(b.type) &&
      (!options ||
        !Number.isInteger(options.precision) ||
        Number(options.precision) < 0 ||
        Number(options.precision) > 8)
    )
      return err(422, "INVALID_REQUEST_UNKNOWN", "Invalid precision")
    if (
      b.type === "checkbox" &&
      (!options || typeof options.icon !== "string" || typeof options.color !== "string")
    )
      return err(422, "INVALID_REQUEST_UNKNOWN", "Invalid checkbox options")
    const field: Field = {
      id: this.ids.next("fld"),
      name: b.name,
      type: b.type,
      ...(options ? { options } : {}),
      ...(typeof b.description === "string" ? { description: b.description } : {}),
    }
    this.tables.update(table.id, { ...table, fields: [...table.fields, field] })
    return annotateResponse(jsonRes(200, field), { ids: { field: field.id, table: table.id } })
  }
  private validValue(field: Field, value: unknown): boolean {
    if (value === null) return true
    if (textTypes.has(field.type)) return typeof value === "string"
    if (numberTypes.has(field.type)) return typeof value === "number" && Number.isFinite(value)
    if (field.type === "checkbox") return typeof value === "boolean"
    if (field.type === "date" || field.type === "dateTime")
      return typeof value === "string" && Number.isFinite(Date.parse(value))
    const choices = Array.isArray(field.options?.choices) ? field.options.choices : []
    const choice = (v: unknown) =>
      typeof v === "string" && choices.some((c) => object(c) && c.name === v)
    if (field.type === "singleSelect") return choice(value)
    if (field.type === "multipleSelects") return Array.isArray(value) && value.every(choice)
    return false
  }
  private createRecords(c: OperationContext) {
    const a = this.access(c, "data.records:write")
    if (a instanceof Response) return a
    const table = this.table(a.base.id, String(c.params.tableId))
    if (!table) return denied()
    const b = c.body.kind === "json" ? c.body.value : null
    if (!object(b) || bodyIssues(c).length)
      return err(422, "INVALID_REQUEST_UNKNOWN", "Invalid request")
    const single = object(b.fields),
      rows = single ? [{ fields: b.fields }] : b.records
    if (!Array.isArray(rows) || !rows.length || rows.length > 10)
      return err(422, "INVALID_REQUEST_UNKNOWN", "Expected 1 to 10 records")
    const normalized: Record<string, unknown>[] = []
    for (const row of rows) {
      if (!object(row) || !object(row.fields))
        return err(422, "INVALID_REQUEST_UNKNOWN", "Invalid record fields")
      const fields: Record<string, unknown> = {}
      for (const [key, value] of Object.entries(row.fields)) {
        const f = table.fields.find((f) => f.name === key || f.id === key)
        if (!f) return err(422, "UNKNOWN_FIELD_NAME", `Unknown field name: ${key}`)
        if (!this.validValue(f, value))
          return err(422, "INVALID_VALUE_FOR_COLUMN", `Invalid value for ${f.name}`)
        // Empty cells are omitted in Airtable's response.
        if (
          value !== null &&
          value !== "" &&
          value !== false &&
          !(Array.isArray(value) && value.length === 0)
        )
          fields[f.name] = value
      }
      normalized.push(fields)
    }
    // Validate every record before writing any state or allocating identifiers.
    const records = normalized.map((fields) => {
      const r = {
        id: this.ids.next("rec"),
        tableId: table.id,
        fields,
        createdTime: new Date(this.now()).toISOString(),
      }
      this.records.insert(r.id, r)
      const output = b.returnFieldsByFieldId
        ? Object.fromEntries(
            Object.entries(fields).map(([name, value]) => [
              table.fields.find((f) => f.name === name)?.id ?? name,
              value,
            ]),
          )
        : fields
      return { id: r.id, createdTime: r.createdTime, fields: output }
    })
    return annotateResponse(jsonRes(200, single ? records[0] : { records }), {
      ids: Object.fromEntries(records.map((r, i) => [`record${i}`, r.id])),
    })
  }
  private async exchange(c: OperationContext): Promise<Response> {
    const b = new URLSearchParams(
      c.body.kind === "form" ? (c.body.value as Record<string, string>) : {},
    )
    const basic = basicAuth(c.request),
      clientId = basic?.username ?? b.get("client_id") ?? "",
      client = this.clients.get(clientId)
    if (
      !client ||
      (client.secret ? basic?.password !== client.secret : basic !== undefined) ||
      (b.has("client_id") && b.get("client_id") !== clientId)
    )
      return oauthError("invalid_client")
    let source: Omit<Grant, "token" | "refreshToken" | "expiresAt" | "refreshExpiresAt">
    if (b.get("grant_type") === "authorization_code") {
      const code = this.codes.get(b.get("code") ?? "")
      // Airtable consumes authorization codes even when verification fails.
      if (code) this.codes.delete(code.code)
      if (
        !code ||
        code.expiresAt <= this.now() ||
        code.clientId !== clientId ||
        code.redirectUri !== b.get("redirect_uri")
      )
        return oauthError("invalid_grant")
      const verifier = b.get("code_verifier") ?? ""
      const digest = new Uint8Array(
        await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
      )
      const challenge = btoa(String.fromCharCode(...digest))
        .replaceAll("+", "-")
        .replaceAll("/", "_")
        .replaceAll("=", "")
      if (verifier.length < 43 || verifier.length > 128 || challenge !== code.challenge)
        return oauthError("invalid_grant")
      source = code
    } else if (b.get("grant_type") === "refresh_token") {
      const grant = this.grants
        .list({ order: "oldest" })
        .map((r) => r.value)
        .find(
          (g) =>
            g.refreshToken && g.refreshToken === b.get("refresh_token") && g.clientId === clientId,
        )
      if (!grant || grant.refreshExpiresAt <= this.now()) return oauthError("invalid_grant")
      const scopes = b.has("scope") ? (b.get("scope") ?? "").split(" ") : grant.scopes
      if (scopes.some((scope) => !grant.scopes.includes(scope))) return oauthError("invalid_scope")
      this.grants.delete(grant.token)
      source = { ...grant, scopes }
    } else return oauthError("unsupported_grant_type")
    const token = this.ids.next("mock_access"),
      refreshToken = this.ids.next("mock_refresh")
    const grant: Grant = {
      token,
      refreshToken,
      clientId,
      userId: source.userId,
      scopes: source.scopes,
      baseIds: source.baseIds,
      ...(source.email ? { email: source.email } : {}),
      expiresAt: this.now() + 3600000,
      refreshExpiresAt: this.now() + 60 * 86400000,
    }
    this.grants.insert(token, grant)
    return jsonRes(200, {
      access_token: token,
      refresh_token: refreshToken,
      expires_in: 3600,
      refresh_expires_in: 60 * 86400,
      scope: grant.scopes.join(" "),
      token_type: "Bearer ",
    })
  }
}
