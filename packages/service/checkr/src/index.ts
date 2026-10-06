import type { FetchAPI } from "@emulates/core"
import {
  type APIOptions,
  annotateResponse,
  basicAuth,
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
import { document, type SupportedOperationId } from "./generated/openapi.js"

export type { OperationId, SupportedOperationId } from "./generated/openapi.js"
export { document, operationIds, supportedOperationIds } from "./generated/openapi.js"
export type { CheckrRuntime, CheckrRuntimeOptions } from "./runtime.js"
export { CHECKR_PRESETS, createRuntime } from "./runtime.js"
export const CHECKR_NAMESPACE = "checkr"
export type Package = { id: string; slug: string; name: string; price: number }
export type Node = { custom_id: string; name: string; packages: string[] }
export type Candidate = {
  id: string
  object: "candidate"
  email: string
  first_name: string | null
  last_name: string | null
  report_ids: string[]
  created_at: string
}
export type Invitation = {
  id: string
  object: "invitation"
  candidate_id: string
  package: string
  status: "pending" | "completed" | "expired"
  report_id: string | null
  created_at: string
  expires_at: string
  deleted_at: string | null
  node: string | null
}
export type Report = {
  id: string
  candidate_id: string
  status: string
  result: string | null
  package: string
  adjudication: string | null
  estimated_completion_time: string | null
  estimate_generated_at?: string
}
export type CheckrAPIOptions = APIOptions & {
  adminPrefix?: string
  publicNamespace?: string
  apiKey?: string
  packages?: readonly Package[]
  nodes?: readonly Node[]
  candidates?: readonly Candidate[]
  reports?: readonly Report[]
  hierarchyEnabled?: boolean
  invitationTtlMs?: number
}
export const DEFAULT_PACKAGES: readonly Package[] = [
  { id: "package_mock", slug: "synthetic_basic", name: "Synthetic Basic", price: 2500 },
]
const failure = (status: number, error: string) => jsonRes(status, { error })
export class CheckrAPI implements FetchAPI {
  readonly sqlite
  readonly app
  readonly packages: Collection<Package>
  readonly nodes: Collection<Node>
  readonly candidates: Collection<Candidate>
  readonly invitations: Collection<Invitation>
  readonly reports: Collection<Report>
  readonly settings: Collection<{ hierarchyEnabled: boolean }>
  private readonly initialized: Collection<boolean>
  private readonly ids: IdSequence
  private readonly service: Service
  private readonly now: () => number
  constructor(private readonly options: CheckrAPIOptions = {}) {
    this.sqlite = bootSqlite(options.sqlite)
    const namespace = options.namespace ?? CHECKR_NAMESPACE
    this.now = options.now ?? Date.now
    this.packages = new Collection(this.sqlite, namespace, "packages")
    this.nodes = new Collection(this.sqlite, namespace, "nodes")
    this.candidates = new Collection(this.sqlite, namespace, "candidates")
    this.invitations = new Collection(this.sqlite, namespace, "invitations")
    this.reports = new Collection(this.sqlite, namespace, "reports")
    this.settings = new Collection(this.sqlite, namespace, "settings")
    this.initialized = new Collection(this.sqlite, namespace, "initialized")
    this.ids = new IdSequence(this.sqlite, namespace, `checkr:${namespace}`)
    this.seed()
    this.service = createService({
      document,
      sqlite: this.sqlite,
      namespace,
      now: this.now,
      before: (c) => {
        const auth = basicAuth(c.request)
        return auth?.username === (this.options.apiKey ?? "mock_checkr_key") && auth.password === ""
          ? undefined
          : failure(401, "Unauthorized")
      },
      notFound: () => failure(404, "Not found"),
      onError: (error) => {
        throw error
      },
      handlers: defineOperations<SupportedOperationId>({
        ListPackages: (c) =>
          this.page(
            c,
            this.packages.list({ order: "oldest" }).map((r) => r.value),
          ),
        ListNodes: (c) =>
          this.settings.get("account")?.hierarchyEnabled
            ? this.page(
                c,
                this.nodes.list({ order: "oldest" }).map((r) => r.value),
              )
            : failure(403, "Hierarchy not enabled"),
        ListCandidates: (c) =>
          this.page(
            c,
            this.candidates
              .list({ order: "oldest" })
              .map((r) => this.candidate(r.value))
              .filter(
                (r) =>
                  !c.url.searchParams.has("email") || r.email === c.url.searchParams.get("email"),
              ),
          ),
        CreateCandidate: (c) => this.createCandidate(c),
        ListInvitations: (c) =>
          this.page(
            c,
            this.invitations
              .list({ order: "oldest" })
              .map((r) => this.invitation(r.value))
              .filter(
                (r) =>
                  !r.deleted_at &&
                  (!c.url.searchParams.has("candidate_id") ||
                    r.candidate_id === c.url.searchParams.get("candidate_id")) &&
                  (!c.url.searchParams.has("status") ||
                    r.status === c.url.searchParams.get("status")),
              ),
          ),
        CreateInvitation: (c) => this.createInvitation(c),
        GetInvitation: (c) => this.getInvitation(c),
        CancelInvitation: (c) => this.cancel(c),
        GetReport: (c) => {
          const report = this.reports.get(c.params.id ?? "")
          return report ? jsonRes(200, report) : failure(404, "Report not found")
        },
        GetReportEta: (c) => {
          const report = this.reports.get(c.params.id ?? "")
          return report?.estimated_completion_time
            ? jsonRes(200, {
                estimated_completion_time: report.estimated_completion_time,
                estimate_generated_at:
                  report.estimate_generated_at ?? new Date(this.now()).toISOString(),
              })
            : failure(404, "ETA unavailable")
        },
      }),
    })
    this.app = this.service.app
  }
  private seed() {
    if (this.initialized.has("seed")) return
    for (const row of this.options.packages ?? DEFAULT_PACKAGES) this.packages.insert(row.slug, row)
    for (const row of this.options.nodes ?? []) this.nodes.insert(row.custom_id, row)
    for (const row of this.options.candidates ?? []) this.candidates.insert(row.id, row)
    for (const row of this.options.reports ?? []) this.reports.insert(row.id, row)
    this.settings.insert("account", { hierarchyEnabled: this.options.hierarchyEnabled ?? false })
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
  private candidate(row: Candidate): Candidate {
    return {
      ...row,
      report_ids: [
        ...new Set([
          ...row.report_ids,
          ...this.reports
            .list()
            .filter((r) => r.value.candidate_id === row.id)
            .map((r) => r.id),
        ]),
      ],
    }
  }
  private invitation(row: Invitation): Invitation {
    if (!row.deleted_at && row.status === "pending" && Date.parse(row.expires_at) <= this.now()) {
      const expired: Invitation = { ...row, status: "expired" }
      this.invitations.update(row.id, expired)
      return expired
    }
    return row
  }
  private page(c: OperationContext, rows: unknown[]) {
    const page = Number(c.url.searchParams.get("page") ?? 1)
    const perPage = Number(c.url.searchParams.get("per_page") ?? 25)
    if (
      !Number.isInteger(page) ||
      page < 1 ||
      !Number.isInteger(perPage) ||
      perPage < 0 ||
      perPage > 100
    )
      return failure(400, "Invalid pagination")
    const link = (value: number) => {
      const url = new URL(c.request.url)
      const namespace = this.options.publicNamespace
      if (namespace && namespace !== "default" && namespace !== CHECKR_NAMESPACE)
        url.pathname = `${this.options.adminPrefix ?? "/__admin"}/ns/${encodeURIComponent(namespace)}${url.pathname}`
      url.searchParams.set("page", String(value))
      url.searchParams.set("per_page", String(perPage))
      return url.toString()
    }
    return jsonRes(200, {
      object: "list",
      data: rows.slice((page - 1) * perPage, page * perPage),
      count: rows.length,
      next_href: perPage > 0 && page * perPage < rows.length ? link(page + 1) : null,
      previous_href: perPage > 0 && page > 1 ? link(page - 1) : null,
    })
  }
  private body(c: OperationContext): Record<string, unknown> | undefined {
    if (bodyIssues(c).length) return undefined
    if (
      (c.body.kind === "json" || c.body.kind === "form") &&
      c.body.value &&
      typeof c.body.value === "object" &&
      !Array.isArray(c.body.value)
    )
      return c.body.value as Record<string, unknown>
    return undefined
  }
  private createCandidate(c: OperationContext) {
    const b = this.body(c)
    if (!b || typeof b.email !== "string" || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(b.email))
      return failure(400, "email is required")
    const row: Candidate = {
      id: this.ids.next("candidate"),
      object: "candidate",
      email: b.email,
      first_name: typeof b.first_name === "string" ? b.first_name : null,
      last_name: typeof b.last_name === "string" ? b.last_name : null,
      report_ids: [],
      created_at: new Date(this.now()).toISOString(),
    }
    this.candidates.insert(row.id, row)
    return annotateResponse(jsonRes(201, row), { ids: { candidateId: row.id } })
  }
  private createInvitation(c: OperationContext) {
    const b = this.body(c)
    if (
      !b ||
      typeof b.candidate_id !== "string" ||
      typeof b.package !== "string" ||
      !Array.isArray(b.work_locations) ||
      b.work_locations.length === 0
    )
      return failure(400, "Invalid invitation")
    if (!this.candidates.has(b.candidate_id)) return failure(404, "Candidate not found")
    if (!this.packages.has(b.package)) return failure(400, "Package not found")
    if (
      b.work_locations.some(
        (value) =>
          !value ||
          typeof value !== "object" ||
          ((value.country ?? "US") === "US"
            ? typeof value.state !== "string" || value.state.length !== 2
            : typeof value.country !== "string"),
      )
    )
      return failure(400, "Invalid work location")
    if (this.settings.get("account")?.hierarchyEnabled) {
      const node = this.nodes.get(String(b.node ?? ""))
      if (!node?.packages.includes(b.package)) return failure(400, "Node or package not available")
    }
    const row: Invitation = {
      id: this.ids.next("invitation"),
      object: "invitation",
      candidate_id: b.candidate_id,
      package: b.package,
      status: "pending",
      report_id: null,
      node: typeof b.node === "string" ? b.node : null,
      created_at: new Date(this.now()).toISOString(),
      expires_at: new Date(
        this.now() + (this.options.invitationTtlMs ?? 7 * 86400_000),
      ).toISOString(),
      deleted_at: null,
    }
    this.invitations.insert(row.id, row)
    return annotateResponse(jsonRes(201, row), {
      ids: { candidateId: row.candidate_id, invitationId: row.id },
    })
  }
  private getInvitation(c: OperationContext) {
    const row = this.invitations.get(c.params.id ?? "")
    if (!row || (row.deleted_at && c.url.searchParams.get("include_deleted") !== "true"))
      return failure(404, "Invitation not found")
    return jsonRes(200, this.invitation(row))
  }
  private cancel(c: OperationContext) {
    const previous = this.invitations.get(c.params.id ?? "")
    if (!previous) return failure(404, "Invitation not found")
    const row = this.invitation(previous)
    if (row.deleted_at || row.status !== "pending")
      return failure(400, "Invitation cannot be canceled")
    const canceled = { ...row, deleted_at: new Date(this.now()).toISOString() }
    this.invitations.update(row.id, canceled)
    return annotateResponse(jsonRes(200, canceled), { ids: { invitationId: row.id } })
  }
}
