import type { FetchAPI } from "@crvouga/mockingbird-core"
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
  faultEffect,
  IdSequence,
  jsonRes,
  type OperationContext,
  opaqueToken,
  type Service,
} from "@crvouga/mockingbird-service"
import type { Hono } from "hono"
import { document, type SupportedOperationId } from "./generated/openapi.js"

export type { OperationId, SupportedOperationId } from "./generated/openapi.js"
export { document, operationIds, supportedOperationIds } from "./generated/openapi.js"
export { createRuntime, VIBE_PRESETS } from "./runtime.js"
export const VIBE_NAMESPACE = "vibe"
export type Client = { id: string; secret: string; scopes: string[]; advertiserIds: string[] }
export type Token = { clientId: string; scopes: string[]; expiresAt: number }
export type Row = { advertiser_id: string; impression_date: string; [key: string]: unknown }
export type Report = {
  id: string
  clientId: string
  createdAt: number
  readyAt: number | null
  processingAt: number
  failure: { code: string; message: string } | null
  rows: Record<string, unknown>[]
  downloadToken: string
  missingArtifact: boolean
}
export type Settings = { processingMs: number; readyMs: number; tokenTtlSeconds: number }
export type VibeAPIOptions = APIOptions & {
  clients?: Client[]
  rows?: Row[]
  settings?: Partial<Settings>
  publicNamespace?: string
  adminPrefix?: string
}
export const DEFAULT_ADVERTISER = "00000000-0000-4000-8000-000000000001"
const defaultClient: Client = {
  id: "mock_client",
  secret: "mock_client_secret",
  scopes: ["advertisers:read", "reporting:read"],
  advertiserIds: [DEFAULT_ADVERTISER],
}
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
const failure = (status: number, type: string, message: string) =>
  jsonRes(status, {
    error: { type, message, status, detail: null, request_id: "mock_request", doc_url: null },
  })
export class VibeAPI implements FetchAPI {
  readonly app: Hono
  readonly clients: Collection<Client>
  readonly tokens: Collection<Token>
  readonly rows: Collection<Row>
  readonly reports: Collection<Report>
  readonly settings: Collection<Settings>
  private readonly initialized: Collection<{ value: boolean }>
  private readonly ids: IdSequence
  private readonly service: Service
  private readonly now: () => number
  private readonly seeds: { clients: Client[]; rows: Row[]; settings: Settings }
  private readonly basePath: string
  private readonly prefix: string
  private readonly namespace: string
  constructor(options: VibeAPIOptions = {}) {
    const sqlite = bootSqlite(options.sqlite),
      namespace = options.namespace ?? VIBE_NAMESPACE
    this.namespace = namespace
    this.now = options.now ?? Date.now
    this.prefix = options.adminPrefix ?? "/__admin"
    this.basePath =
      !options.publicNamespace || options.publicNamespace === "default"
        ? ""
        : `${this.prefix}/ns/${encodeURIComponent(options.publicNamespace)}`
    this.clients = new Collection(sqlite, namespace, "clients")
    this.tokens = new Collection(sqlite, namespace, "tokens")
    this.rows = new Collection(sqlite, namespace, "rows")
    this.reports = new Collection(sqlite, namespace, "reports")
    this.settings = new Collection(sqlite, namespace, "settings")
    this.initialized = new Collection(sqlite, namespace, "initialized")
    this.ids = new IdSequence(sqlite, namespace)
    this.seeds = structuredClone({
      clients: options.clients ?? [defaultClient],
      rows: options.rows ?? [],
      settings: { processingMs: 1000, readyMs: 2000, tokenTtlSeconds: 3600, ...options.settings },
    })
    this.seed()
    this.service = createService({
      sqlite,
      namespace,
      document,
      now: this.now,
      notFound: () => failure(404, "not_found", "Report not found"),
      onError: (error) => {
        throw error
      },
      before: (context) => {
        if (["OAuthToken", "DownloadReport"].includes(context.operation.operationId))
          return undefined
        const token = this.tokens.get(bearerToken(context.request) ?? "")
        if (!token || token.expiresAt <= this.now())
          return failure(401, "invalid_token", "Unauthorized")
        if (context.request.headers.get("x-vibe-revision") !== "2026-06-01")
          return failure(400, "unknown_revision", "Unknown or missing revision")
        if (!token.scopes.includes("reporting:read"))
          return failure(403, "insufficient_scope", "Missing required scope")
        return undefined
      },
      handlers: defineOperations<SupportedOperationId>({
        OAuthToken: (context) => this.exchange(context),
        CreateReport: (context) => this.create(context),
        GetReport: (context) => this.get(context),
        DownloadReport: (context) => this.download(context),
      }),
    })
    this.app = this.service.app
  }
  private seed(): void {
    if (this.initialized.has("seed")) return
    for (const client of this.seeds.clients) this.clients.insert(client.id, client)
    for (const [i, row] of this.seeds.rows.entries()) this.rows.insert(String(i), row)
    this.settings.insert("default", this.seeds.settings)
    const client = this.clients.get("mock_client")
    if (client)
      this.tokens.insert("mock_vibe_token", {
        clientId: client.id,
        scopes: client.scopes,
        expiresAt: this.now() + this.seeds.settings.tokenTtlSeconds * 1000,
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
  private exchange(context: OperationContext): Response {
    const auth = basicAuth(context.request)
    let client: Client | undefined
    try {
      client = this.clients.get(decodeURIComponent(auth?.username ?? ""))
    } catch {
      return jsonRes(401, { error: "invalid_client" })
    }
    let password: string
    try {
      password = decodeURIComponent(auth?.password ?? "")
    } catch {
      return jsonRes(401, { error: "invalid_client" })
    }
    if (!client || client.secret !== password) return jsonRes(401, { error: "invalid_client" })
    if (bodyIssues(context).length || context.body.kind !== "form")
      return jsonRes(400, { error: "invalid_request" })
    const form = context.body.value
    if (form.grant_type !== "client_credentials")
      return jsonRes(400, { error: "unsupported_grant_type" })
    const scope = form.scope,
      scopes = typeof scope === "string" ? scope.split(/\s+/).filter(Boolean) : client.scopes
    if (scopes.some((value) => !client.scopes.includes(value)))
      return jsonRes(400, { error: "invalid_scope" })
    const token = this.ids.next("mock_vibe_", 24),
      expires = this.settings.get("default")?.tokenTtlSeconds ?? 3600
    this.tokens.insert(token, {
      clientId: client.id,
      scopes,
      expiresAt: this.now() + expires * 1000,
    })
    return jsonRes(200, {
      access_token: token,
      token_type: "Bearer",
      expires_in: expires,
      scope: scopes.join(" "),
    })
  }
  private create(context: OperationContext): Response {
    if (bodyIssues(context).length || context.body.kind !== "json" || !record(context.body.value))
      return failure(400, "validation", "Invalid report request")
    const body = context.body.value,
      token = this.tokens.get(bearerToken(context.request) ?? ""),
      client = this.clients.get(token?.clientId ?? "")
    if (!client) return failure(401, "invalid_token", "Unauthorized")
    const start = String(body.start_date),
      end = String(body.end_date),
      duration = Date.parse(end) - Date.parse(start)
    if (!Number.isFinite(duration) || duration <= 0 || duration > 45 * 86400000)
      return failure(400, "validation", "Report window must be positive and at most 45 days")
    const advertisers = body.advertiser_ids as string[]
    if (advertisers.some((id) => !client.advertiserIds.includes(id)))
      return failure(403, "insufficient_scope", "Advertiser not accessible")
    // The initial package deliberately serves pre-aggregated JSON/DAY fixtures only.
    if ((body.format && body.format !== "JSON") || (body.granularity && body.granularity !== "DAY"))
      return failure(400, "validation", "This mock supports JSON/DAY fixtures only")
    const columns = [
      ...(Array.isArray(body.dimensions) ? body.dimensions : []),
      ...(body.metrics as string[]),
    ] as string[]
    const rows = this.rows
      .list({ order: "oldest" })
      .map(({ value }) => value)
      .filter(
        (row) =>
          advertisers.includes(row.advertiser_id) &&
          row.impression_date >= start &&
          row.impression_date < end,
      )
      .map((row) => Object.fromEntries(columns.map((column) => [column, row[column] ?? null])))
    const raw = Array.from(this.ids.next("", 32), (char) =>
        (char.charCodeAt(0) % 16).toString(16),
      ).join(""),
      id = `${raw.slice(0, 8)}-${raw.slice(8, 12)}-4${raw.slice(13, 16)}-8${raw.slice(17, 20)}-${raw.slice(20)}`
    const now = this.now(),
      settings = this.settings.get("default") ?? this.seeds.settings
    const report: Report = {
      id,
      clientId: client.id,
      createdAt: now,
      processingAt: now + settings.processingMs,
      readyAt: faultEffect(context.request, "stuck") ? null : now + settings.readyMs,
      failure: faultEffect(context.request, "failed")
        ? { code: "mock_report_failed", message: "Scripted report failure" }
        : null,
      rows,
      downloadToken: opaqueToken(`${this.namespace}:${id}:${now}`, 24),
      missingArtifact: false,
    }
    this.reports.insert(id, report)
    const response = jsonRes(201, this.view(context, report))
    annotateResponse(response, { ids: { reportId: id } })
    return response
  }
  private view(context: OperationContext, report: Report): Record<string, unknown> {
    const terminal = report.readyAt !== null && this.now() >= report.readyAt
    const status = terminal
      ? report.failure
        ? "FAILED"
        : "READY"
      : this.now() >= report.processingAt
        ? "PROCESSING"
        : "CREATED"
    const ready = status === "READY",
      completed = terminal ? new Date(report.readyAt ?? 0).toISOString() : null
    return {
      id: report.id,
      status,
      created_at: new Date(report.createdAt).toISOString(),
      completed_at: completed,
      failure_reason: status === "FAILED" ? report.failure : null,
      download_url: ready
        ? `${context.url.origin}${this.basePath}${this.prefix}/blobs/${report.id}?token=${encodeURIComponent(report.downloadToken)}`
        : null,
      generated_url_time: ready ? completed : null,
      url_expiration_time: ready ? new Date((report.readyAt ?? 0) + 86400000).toISOString() : null,
    }
  }
  private get(context: OperationContext): Response {
    const report = this.reports.get(context.params.report_id ?? ""),
      token = this.tokens.get(bearerToken(context.request) ?? "")
    if (!report || report.clientId !== token?.clientId)
      return failure(404, "not_found", "Report not found")
    return jsonRes(200, this.view(context, report))
  }
  private download(context: OperationContext): Response {
    const report = this.reports.get(context.params.id ?? "")
    if (!report || report.missingArtifact) return failure(404, "not_found", "Artifact not found")
    if (
      report.readyAt === null ||
      this.now() < report.readyAt ||
      report.failure ||
      this.now() >= report.readyAt + 86400000 ||
      context.url.searchParams.get("token") !== report.downloadToken
    )
      return failure(403, "invalid_token", "Artifact capability unavailable or expired")
    return jsonRes(200, report.rows)
  }
}
