import type { FetchAPI } from "@emulates/core"
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
} from "@emulates/service"
import type { Hono } from "hono"
import { document, type SupportedOperationId } from "./generated/openapi.js"

export type { OperationId, SupportedOperationId } from "./generated/openapi.js"
export { document, operationIds, supportedOperationIds } from "./generated/openapi.js"
export { createRuntime, VANTA_PRESETS } from "./runtime.js"
export const VANTA_NAMESPACE = "vanta"
export type Resource = { id: string; [key: string]: unknown }
export type Client = { id: string; secret: string; scopes: string[] }
export type Token = { clientId: string; scopes: string[]; expiresAt: number }
export type Upload = {
  id: string
  documentId: string
  metadata: Resource
  bytes: number
  submitted: boolean
}
export type Eligibility = { monitoredAccountsInactive: boolean; customTasksComplete: boolean }
export type VantaAPIOptions = APIOptions & {
  clients?: Client[]
  people?: Resource[]
  documents?: Resource[]
  tests?: Resource[]
  controls?: Resource[]
}
export const VANTA_SCOPES = {
  read: "vanta-api.all:read",
  write: "vanta-api.all:write",
  upload: "vanta-api.documents:upload",
} as const
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
const failure = (status: number, message: string) => jsonRes(status, { message })
const unauthorized = (request: Request) =>
  new Response("Unauthorized", {
    status: 401,
    headers: {
      "content-type": "application/json",
      "x-amzn-remapped-www-authenticate": `Bearer realm="Users"${bearerToken(request) ? ', error="invalid_token"' : ""}`,
    },
  })
export class VantaAPI implements FetchAPI {
  readonly app: Hono
  readonly clients: Collection<Client>
  readonly tokens: Collection<Token>
  readonly people: Collection<Resource>
  readonly documents: Collection<Resource>
  readonly tests: Collection<Resource>
  readonly controls: Collection<Resource>
  readonly uploads: Collection<Upload>
  readonly eligibility: Collection<Eligibility>
  readonly offboardings: Collection<{
    personId: string
    acknowledgerId: string
    completedAt: string
  }>
  private readonly initialized: Collection<{ value: boolean }>
  private readonly ids: IdSequence
  private readonly now: () => number
  private readonly service: Service
  private readonly seeds: Required<
    Pick<VantaAPIOptions, "clients" | "people" | "documents" | "tests" | "controls">
  >
  constructor(options: VantaAPIOptions = {}) {
    const sqlite = bootSqlite(options.sqlite),
      namespace = options.namespace ?? VANTA_NAMESPACE
    this.now = options.now ?? Date.now
    this.clients = new Collection(sqlite, namespace, "clients")
    this.tokens = new Collection(sqlite, namespace, "tokens")
    this.people = new Collection(sqlite, namespace, "people")
    this.documents = new Collection(sqlite, namespace, "documents")
    this.tests = new Collection(sqlite, namespace, "tests")
    this.controls = new Collection(sqlite, namespace, "controls")
    this.uploads = new Collection(sqlite, namespace, "uploads")
    this.eligibility = new Collection(sqlite, namespace, "eligibility")
    this.offboardings = new Collection(sqlite, namespace, "offboardings")
    this.initialized = new Collection(sqlite, namespace, "initialized")
    this.ids = new IdSequence(sqlite, namespace)
    this.seeds = structuredClone({
      clients: options.clients ?? [
        { id: "mock_read", secret: "mock_read_secret", scopes: [VANTA_SCOPES.read] },
        { id: "mock_write", secret: "mock_write_secret", scopes: Object.values(VANTA_SCOPES) },
      ],
      people: options.people ?? [
        {
          id: "mock-person",
          emailAddress: "person@example.test",
          name: { first: "Synthetic", last: "Person", display: "Synthetic Person" },
          employment: { status: "FORMER" },
          tasksSummary: { status: "OFFBOARDING_DUE_SOON" },
        },
      ],
      documents: options.documents ?? [
        {
          id: "mock-document",
          title: "Synthetic evidence",
          uploadStatus: "Needs document",
          uploadStatusDate: null,
        },
      ],
      tests: options.tests ?? [],
      controls: options.controls ?? [],
    })
    this.seed()
    this.service = createService({
      sqlite,
      namespace,
      document,
      now: this.now,
      notFound: () => failure(404, "Not found"),
      onError: (error) => {
        throw error
      },
      before: (context) => {
        const id = context.operation.operationId
        if (id === "OAuthToken") return undefined
        const token = this.tokens.get(bearerToken(context.request) ?? "")
        if (!token || token.expiresAt <= this.now()) return unauthorized(context.request)
        const required =
          id === "UploadFileForDocument"
            ? VANTA_SCOPES.upload
            : ["OffboardPeople", "SubmitDocumentCollection"].includes(id)
              ? VANTA_SCOPES.write
              : VANTA_SCOPES.read
        if (!token.scopes.includes(required)) return failure(403, "Insufficient scope")
        return undefined
      },
      handlers: defineOperations<SupportedOperationId>({
        OAuthToken: (context) => this.exchange(context),
        ListPeople: (context) => this.list(context, this.people),
        GetPerson: (context) => this.get(this.people, context.params.personId),
        ListTests: (context) => this.list(context, this.tests),
        ListControls: (context) => this.list(context, this.controls),
        ListDocuments: (context) => this.list(context, this.documents),
        GetDocument: (context) => this.get(this.documents, context.params.documentId),
        UploadFileForDocument: (context) => this.upload(context),
        SubmitDocumentCollection: (context) => this.submit(context),
        OffboardPeople: (context) => this.offboard(context),
      }),
    })
    this.app = this.service.app
  }
  private seed(): void {
    if (this.initialized.has("seed")) return
    for (const client of this.seeds.clients) this.clients.insert(client.id, client)
    for (const kind of ["people", "documents", "tests", "controls"] as const)
      for (const row of this.seeds[kind]) this[kind].insert(row.id, row)
    const client = this.clients.get("mock_write")
    if (client)
      this.tokens.insert("mock_vanta_token", {
        clientId: client.id,
        scopes: client.scopes,
        expiresAt: this.now() + 3600000,
      })
    this.initialized.insert("seed", { value: true })
  }
  fetch(request: Request): Promise<Response> {
    return this.service.fetch(request)
  }
  async reset(): Promise<void> {
    await this.service.reset()
    this.seed()
  }
  private body(context: OperationContext): Record<string, unknown> | undefined {
    return !bodyIssues(context).length && context.body.kind === "json" && record(context.body.value)
      ? context.body.value
      : undefined
  }
  private exchange(context: OperationContext): Response {
    const body = this.body(context)
    if (!body) return jsonRes(400, { error: "invalid_request" })
    const client = this.clients.get(String(body.client_id))
    if (!client || client.secret !== body.client_secret)
      return jsonRes(401, { error: "invalid_client" })
    const scopes = typeof body.scope === "string" ? body.scope.split(/\s+/).filter(Boolean) : []
    if (!scopes.length || scopes.some((scope) => !client.scopes.includes(scope)))
      return jsonRes(400, { error: "invalid_scope" })
    const token = this.ids.next("mock_vanta_", 24)
    for (const row of this.tokens.list())
      if (row.value.clientId === client.id) this.tokens.delete(row.id)
    this.tokens.insert(token, { clientId: client.id, scopes, expiresAt: this.now() + 3600000 })
    return jsonRes(200, { access_token: token, expires_in: 3600, token_type: "Bearer" })
  }
  private list(context: OperationContext, collection: Collection<Resource>): Response {
    const size = Number(context.url.searchParams.get("pageSize") ?? 10),
      cursor = context.url.searchParams.get("pageCursor")
    if (!Number.isInteger(size) || size < 1 || size > 100) return failure(400, "Invalid pageSize")
    const rows = collection.list({ order: "oldest" }).map(({ value }) => value),
      prior = cursor ? rows.findIndex((row) => row.id === cursor) : -1
    if (cursor && prior < 0) return failure(400, "Invalid pageCursor")
    const data = rows.slice(prior + 1, prior + 1 + size)
    return jsonRes(200, {
      results: {
        data,
        pageInfo: {
          hasNextPage: prior + 1 + size < rows.length,
          hasPreviousPage: prior >= 0,
          startCursor: data[0]?.id ?? null,
          endCursor: data.at(-1)?.id ?? null,
        },
      },
    })
  }
  private get(collection: Collection<Resource>, id: string | undefined): Response {
    const value = collection.get(id ?? "")
    return value ? jsonRes(200, value) : failure(404, "Not found")
  }
  private async upload(context: OperationContext): Promise<Response> {
    const document = this.documents.get(context.params.documentId ?? "")
    if (!document) return failure(404, "Document not found")
    const contentType = context.request.headers.get("content-type") ?? ""
    if (!contentType.toLowerCase().startsWith("multipart/form-data"))
      return failure(415, "Expected multipart/form-data")
    let form: FormData
    try {
      if (context.body.kind !== "bytes" && context.body.kind !== "text")
        return failure(400, "Malformed multipart body")
      form = await new Response(context.body.value as BodyInit, {
        headers: { "content-type": contentType },
      }).formData()
    } catch {
      return failure(400, "Malformed multipart body")
    }
    const file = form.get("file"),
      effective = form.get("effectiveAtDate"),
      description = form.get("description")
    if (!file || typeof file === "string") return failure(400, "File is required")
    if (effective && (typeof effective !== "string" || !Number.isFinite(Date.parse(effective))))
      return failure(400, "Invalid effectiveAtDate")
    if (description !== null && typeof description !== "string")
      return failure(400, "Invalid description")
    const id = this.ids.next("mock_upload_"),
      now = new Date(this.now()).toISOString()
    const metadata: Resource = {
      id,
      fileName: file.name,
      title: document.title ?? "Synthetic evidence",
      description,
      mimeType: file.type || "application/octet-stream",
      uploadedBy: {
        id: this.tokens.get(bearerToken(context.request) ?? "")?.clientId,
        type: "APPLICATION",
      },
      creationDate: now,
      updatedDate: now,
      deletionDate: null,
      effectiveDate: effective ? new Date(String(effective)).toISOString() : null,
      url: `https://app.vanta.com/documents/${encodeURIComponent(document.id)}`,
    }
    this.uploads.insert(id, {
      id,
      documentId: document.id,
      metadata,
      bytes: file.size,
      submitted: false,
    })
    const response = jsonRes(201, metadata)
    annotateResponse(response, { ids: { uploadId: id, documentId: document.id } })
    return response
  }
  private submit(context: OperationContext): Response {
    const document = this.documents.get(context.params.documentId ?? "")
    if (!document) return failure(404, "Document not found")
    const uploads = this.uploads
      .list()
      .filter(({ value }) => value.documentId === document.id && !value.submitted)
    if (!uploads.length) return failure(400, "No draft uploads")
    for (const { id, value } of uploads) this.uploads.insert(id, { ...value, submitted: true })
    this.documents.insert(document.id, {
      ...document,
      uploadStatus: "OK",
      uploadStatusDate: new Date(this.now()).toISOString(),
    })
    const response = new Response(null, { status: 204 })
    annotateResponse(response, { ids: { documentId: document.id } })
    return response
  }
  private offboard(context: OperationContext): Response {
    const body = this.body(context)
    if (!body || !Array.isArray(body.updates)) return failure(400, "Invalid updates")
    const results = body.updates.map((update: { id: string; acknowledgerId: string }) => {
      const person = this.people.get(update.id),
        eligibility = this.eligibility.get(update.id)
      if (
        !person ||
        !this.people.has(update.acknowledgerId) ||
        !record(person.employment) ||
        person.employment.status !== "FORMER" ||
        !eligibility?.monitoredAccountsInactive ||
        !eligibility.customTasksComplete
      )
        return { id: update.id, status: "ERROR", message: "Invalid Input" }
      const completedAt = new Date(this.now()).toISOString()
      this.offboardings.insert(person.id, {
        personId: person.id,
        acknowledgerId: update.acknowledgerId,
        completedAt,
      })
      this.people.insert(person.id, {
        ...person,
        tasksSummary: {
          ...(record(person.tasksSummary) ? person.tasksSummary : {}),
          status: "OFFBOARDING_COMPLETE",
          completionDate: completedAt,
        },
      })
      return { id: person.id, status: "SUCCESS" }
    })
    return jsonRes(200, { results })
  }
}
