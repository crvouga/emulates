import type { FetchAPI } from "@crvouga/mockingbird-core"
import {
  type APIOptions,
  bodyIssues,
  bootSqlite,
  Collection,
  createService,
  defineOperations,
  jsonRes,
  type OperationContext,
  type Service,
} from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"
import type { Hono } from "hono"
import { document, type SupportedOperationId } from "./generated/openapi.js"

export type { OperationId, SupportedOperationId } from "./generated/openapi.js"
export { document, operationIds, supportedOperationIds } from "./generated/openapi.js"
export { BREVO_PRESETS, createRuntime } from "./runtime.js"
export const BREVO_NAMESPACE = "brevo"
export type Contact = {
  id: number
  email?: string
  ext_id?: string
  attributes: Record<string, unknown>
  listIds: number[]
  createdAt: string
  modifiedAt: string
  emailBlacklisted: boolean
  smsBlacklisted: boolean
}
export type BrevoAPIOptions = APIOptions & { apiKeys?: string[]; contacts?: Contact[] }
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
const error = (status: number, code: string, message: string) => jsonRes(status, { code, message })
const noContent = () => new Response(null, { status: 204 })

export class BrevoAPI implements FetchAPI {
  readonly app: Hono
  readonly sqlite: SqliteClient
  readonly contacts: Collection<Contact>
  readonly counters: Collection<{ next: number }>
  private readonly service: Service
  private readonly now: () => number
  private readonly seed: Contact[]
  constructor(options: BrevoAPIOptions = {}) {
    const sqlite = bootSqlite(options.sqlite),
      namespace = options.namespace ?? BREVO_NAMESPACE
    this.now = options.now ?? Date.now
    this.contacts = new Collection(sqlite, namespace, "contacts")
    this.counters = new Collection(sqlite, namespace, "counters")
    this.seed = structuredClone(options.contacts ?? [])
    this.ensureSeeded()
    this.service = createService({
      document,
      sqlite,
      namespace,
      now: this.now,
      notFound: () => error(404, "document_not_found", "Resource not found"),
      onError: (thrown) => {
        throw thrown
      },
      before: (context) => {
        const key = context.request.headers.get("api-key")
        if (!key || !(options.apiKeys ?? ["mock_brevo_key"]).includes(key))
          return error(401, "unauthorized", "Key not found")
        return undefined
      },
      handlers: defineOperations<SupportedOperationId>({
        CreateContact: (context) => this.create(context),
        GetContact: (context) => this.existing(context, (contact) => jsonRes(200, contact)),
        UpdateContact: (context) =>
          this.existing(context, (contact) => this.update(context, contact)),
        DeleteContact: (context) =>
          this.existing(context, (contact) => {
            this.contacts.delete(String(contact.id))
            return noContent()
          }),
      }),
    })
    this.sqlite = sqlite
    this.app = this.service.app
  }
  private ensureSeeded(): void {
    if (this.counters.has("ids")) return
    for (const contact of this.seed) this.contacts.insert(String(contact.id), contact)
    this.counters.insert("ids", {
      next: Math.max(0, ...this.seed.map((contact) => contact.id)) + 1,
    })
  }
  fetch(request: Request): Promise<Response> {
    return this.service.fetch(request)
  }
  async reset(): Promise<void> {
    await this.service.reset()
    this.ensureSeeded()
  }
  private existing(context: OperationContext, fn: (contact: Contact) => Response): Response {
    const identifier = context.params.identifier ?? ""
    const type =
      context.url.searchParams.get("identifierType") ??
      (identifier.includes("@") ? "email_id" : "contact_id")
    if (!["email_id", "contact_id", "ext_id"].includes(type))
      return error(400, "invalid_parameter", "Invalid identifier type")
    const contact = this.contacts
      .list()
      .map((row) => row.value)
      .find((row) =>
        type === "email_id"
          ? row.email?.toLowerCase() === identifier.toLowerCase()
          : type === "ext_id"
            ? row.ext_id === identifier
            : String(row.id) === identifier,
      )
    return contact ? fn(contact) : error(404, "document_not_found", "Contact does not exist")
  }
  private body(context: OperationContext): Record<string, unknown> | undefined {
    return !bodyIssues(context).length && context.body.kind === "json" && record(context.body.value)
      ? context.body.value
      : undefined
  }
  private change(body: Record<string, unknown>, existing?: Contact): Contact | Response {
    const attributes = record(body.attributes) ? body.attributes : {}
    const email = attributes.EMAIL ?? body.email ?? existing?.email
    const external = body.ext_id ?? existing?.ext_id
    if (
      email !== undefined &&
      (typeof email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    )
      return error(400, "invalid_parameter", "Invalid email address")
    if (external !== undefined && (typeof external !== "string" || !external))
      return error(400, "invalid_parameter", "Invalid external identifier")
    if (!email && !external)
      return error(400, "missing_parameter", "Email or external identifier is required")
    const conflict = this.contacts
      .list()
      .some(
        ({ value }) =>
          value.id !== existing?.id &&
          ((email !== undefined && value.email?.toLowerCase() === String(email).toLowerCase()) ||
            (external !== undefined && value.ext_id === external)),
      )
    if (conflict) return error(400, "duplicate_parameter", "Contact already exist")
    const now = new Date(this.now()).toISOString()
    const lists = [
      ...new Set([
        ...(existing?.listIds ?? []),
        ...(Array.isArray(body.listIds) ? (body.listIds as number[]) : []),
      ]),
    ].filter((id) => !Array.isArray(body.unlinkListIds) || !body.unlinkListIds.includes(id))
    return {
      id: existing?.id ?? this.counters.get("ids")?.next ?? 1,
      ...(email !== undefined ? { email: String(email) } : {}),
      ...(external !== undefined ? { ext_id: String(external) } : {}),
      attributes: { ...(existing?.attributes ?? {}), ...attributes },
      listIds: lists,
      createdAt: existing?.createdAt ?? now,
      modifiedAt: now,
      emailBlacklisted:
        typeof body.emailBlacklisted === "boolean"
          ? body.emailBlacklisted
          : email !== existing?.email
            ? false
            : (existing?.emailBlacklisted ?? false),
      smsBlacklisted:
        typeof body.smsBlacklisted === "boolean"
          ? body.smsBlacklisted
          : (existing?.smsBlacklisted ?? false),
    }
  }
  private create(context: OperationContext): Response {
    const body = this.body(context)
    if (!body) return error(400, "invalid_parameter", "Invalid contact data")
    const existing = this.contacts
      .list()
      .map((row) => row.value)
      .find(
        (row) =>
          (typeof body.email === "string" &&
            row.email?.toLowerCase() === body.email.toLowerCase()) ||
          (typeof body.ext_id === "string" && row.ext_id === body.ext_id),
      )
    if (existing && body.updateEnabled !== true)
      return error(400, "duplicate_parameter", "Contact already exist")
    const contact = this.change(body, existing)
    if (contact instanceof Response) return contact
    this.contacts.insert(String(contact.id), contact)
    if (!existing) this.counters.insert("ids", { next: contact.id + 1 })
    return existing ? noContent() : jsonRes(201, { id: contact.id })
  }
  private update(context: OperationContext, existing: Contact): Response {
    const body = this.body(context)
    if (!body) return error(400, "invalid_parameter", "Invalid contact data")
    const contact = this.change(body, existing)
    if (contact instanceof Response) return contact
    this.contacts.insert(String(contact.id), contact)
    return noContent()
  }
}
