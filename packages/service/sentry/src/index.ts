import type { FetchAPI } from "@emulates/core"
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
} from "@emulates/service"
import type { SqliteClient } from "@emulates/sqlite-client"
import { document, type SupportedOperationId } from "./generated/openapi.js"
import {
  createCaptureKey,
  type Envelope,
  type EnvelopeItem,
  encode,
  type JsonObject,
  object,
  parseEnvelope,
  parseJson,
  redact,
  seal,
  unseal,
} from "./protocol.js"
import {
  type AttachmentRecord,
  type CapturedEvent,
  DEFAULT_PROJECT,
  type IssueRecord,
  type ProjectFixture,
  type SentrySettings,
  SentryState,
} from "./state.js"

export { document, supportedOperationIds } from "./generated/openapi.js"
export { createCaptureKey } from "./protocol.js"
export type {
  CapturedEnvelope,
  CapturedEvent,
  IssueRecord,
  ProjectFixture,
  SentrySettings,
} from "./state.js"
export { DEFAULT_PROJECT } from "./state.js"
export const SENTRY_NAMESPACE = "sentry"
export type SentryAPIOptions = APIOptions & {
  projects?: readonly ProjectFixture[]
  restTokens?: readonly string[]
  settings?: Partial<SentrySettings>
  /** Reuse this key to decrypt captures after reopening a persistent SQLite database. */
  captureKey?: Promise<CryptoKey> | CryptoKey
  maxPayloadBytes?: number
  adminPrefix?: string
}
const json = (status: number, body: unknown, headers?: HeadersInit): Response =>
  Response.json(body, { status, ...(headers ? { headers } : {}) })
const error = (status: number, detail: string): Response => json(status, { detail })
const eventId = (value: unknown): string | undefined => {
  if (value === undefined) return undefined
  if (
    typeof value !== "string" ||
    !/^(?:[a-fA-F0-9]{32}|[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12})$/.test(value)
  )
    throw new Error("invalid event id")
  return value.replaceAll("-", "").toLowerCase()
}
const title = (data: JsonObject): string => {
  const values = object(data.exception).values
  const exception = object(Array.isArray(values) ? values.at(-1) : undefined)
  if (exception.type || exception.value)
    return [exception.type, exception.value].filter(Boolean).join(": ")
  if (typeof data.message === "string") return data.message
  const logentry = object(data.logentry)
  return String(logentry.formatted ?? logentry.message ?? data.transaction ?? "Unlabeled event")
}

/** DSN credentials for namespace routing; bearer tokens belong to the REST API. */
export const sentryCredential = (request: Request): string | undefined => {
  const match = /(?:^|[,\s])sentry_key=([^,\s]+)/.exec(request.headers.get("x-sentry-auth") ?? "")
  return match?.[1] ?? new URL(request.url).searchParams.get("sentry_key") ?? bearerToken(request)
}

export class SentryAPI implements FetchAPI {
  readonly sqlite: SqliteClient
  readonly state: SentryState
  readonly app: Service["app"]
  private readonly service: Service
  private readonly now: () => number
  private readonly key: Promise<CryptoKey>
  private readonly restTokens: readonly string[]
  private readonly maxPayloadBytes: number
  private readonly adminPrefix: string
  private readonly raw = new WeakMap<Request, { wire: Uint8Array; decoded: Uint8Array }>()
  constructor(options: SentryAPIOptions = {}) {
    this.sqlite = bootSqlite(options.sqlite)
    const namespace = options.namespace ?? SENTRY_NAMESPACE
    this.now = options.now ?? (() => Date.now())
    this.key = Promise.resolve(options.captureKey ?? createCaptureKey())
    this.restTokens = options.restTokens ?? ["fixture-rest-token"]
    this.maxPayloadBytes = options.maxPayloadBytes ?? 20 * 1024 * 1024
    this.adminPrefix = options.adminPrefix ?? "/__admin"
    this.state = new SentryState(this.sqlite, namespace, options.projects ?? [DEFAULT_PROJECT], {
      grouping: options.settings?.grouping ?? "exception",
      sensitivePaths: options.settings?.sensitivePaths ?? ["request.data", "request.cookies"],
      rejectItems: options.settings?.rejectItems ?? [],
    })
    const handlers = defineOperations<SupportedOperationId>({
      IngestEnvelope: (c) => this.ingest(c, "envelope"),
      StoreEvent: (c) => this.ingest(c, "store"),
      IngestMinidump: (c) => this.ingest(c, "minidump"),
      ListProjectEvents: (c) => this.listEvents(c),
      GetProjectEvent: (c) => this.getEvent(c),
      ListProjectIssues: (c) => this.listIssues(c),
      GetIssue: (c) => this.getIssue(c),
      GetOrganizationIssue: (c) => this.getIssue(c),
      UpdateIssue: (c) => this.updateIssue(c),
      UpdateOrganizationIssue: (c) => this.updateIssue(c),
      ListEventAttachments: (c) => this.listAttachments(c),
      GetEventAttachment: (c) => this.getAttachment(c),
    })
    this.service = createService({
      document,
      handlers,
      sqlite: this.sqlite,
      namespace,
      now: this.now,
      before: (c) =>
        c.url.pathname.startsWith("/api/0/") &&
        !this.restTokens.includes(bearerToken(c.request) ?? "")
          ? error(
              401,
              bearerToken(c.request)
                ? "Invalid token"
                : "Authentication credentials were not provided.",
            )
          : undefined,
      notFound: () => error(404, "The requested resource does not exist"),
      onError: () => error(400, "invalid request body"),
    })
    this.app = this.service.app
  }

  async fetch(request: Request): Promise<Response> {
    if (
      request.method !== "POST" ||
      !/\/api\/[^/]+\/(envelope|store|minidump)\/$/.test(new URL(request.url).pathname)
    )
      return this.service.fetch(request)
    const wire = new Uint8Array(await request.clone().arrayBuffer())
    if (wire.length > this.maxPayloadBytes)
      return error(413, "request content exceeded size limits")
    let decoded = wire
    const encoding = request.headers.get("content-encoding")
    if (encoding) {
      if (!["gzip", "deflate"].includes(encoding)) return error(400, "invalid compression format")
      try {
        const stream = new Blob([wire])
          .stream()
          .pipeThrough(new DecompressionStream(encoding as "gzip" | "deflate"))
        const reader = stream.getReader()
        const parts: Uint8Array[] = []
        let bytes = 0
        for (;;) {
          const result = await reader.read()
          if (result.done) break
          bytes += result.value.byteLength
          if (bytes > this.maxPayloadBytes) {
            await reader.cancel()
            return error(413, "request content exceeded size limits")
          }
          parts.push(result.value)
        }
        decoded = new Uint8Array(bytes)
        let offset = 0
        for (const part of parts) {
          decoded.set(part, offset)
          offset += part.length
        }
      } catch {
        return error(400, "invalid compression format")
      }
    }
    // Keep the original Request identity: the shared runtime attaches fault effects to it.
    this.raw.set(request, { wire, decoded })
    return this.service.fetch(request)
  }
  async reset(): Promise<void> {
    await this.service.reset()
    this.state.ensureSeeded()
  }
  /** Explicit programmatic raw capture access. Admin diagnostics expose encrypted bytes only. */
  async rawEnvelope(id: string): Promise<Uint8Array | undefined> {
    const captured = this.state.envelopes.get(id)
    return captured ? unseal(captured.raw, await this.key) : undefined
  }
  private iso(): string {
    return new Date(this.now()).toISOString()
  }
  private scrub(value: unknown): unknown {
    return redact(value, this.state.current().sensitivePaths)
  }

  private ingestAuth(c: OperationContext, envelope: Envelope): Response | undefined {
    const project = this.state.projects.get(c.params.project ?? "")
    if (!project) return error(403, "event submission rejected with_reason: ProjectId")
    const header = c.request.headers.get("x-sentry-auth")
    const query = c.url.searchParams.get("sentry_key")
    if (header && query) return error(401, "multiple authorization payloads detected")
    let key: string | undefined
    let version: string | null = null
    if (header) {
      if (!header.startsWith("Sentry ")) return error(401, "bad x-sentry-auth header")
      key = /(?:^|[,\s])sentry_key=([^,\s]+)/.exec(header)?.[1]
      version = /(?:^|[,\s])sentry_version=([^,\s]+)/.exec(header)?.[1] ?? null
      if (!key) return error(401, "bad x-sentry-auth header")
    } else if (query) {
      key = query
      version = c.url.searchParams.get("sentry_version")
    } else if (typeof envelope.headers.dsn === "string") {
      try {
        const dsn = new URL(envelope.headers.dsn)
        key = dsn.username
        if (dsn.pathname.split("/").at(-1) !== project.id)
          return error(403, "event submission rejected with_reason: ProjectId")
      } catch {
        return error(401, "bad envelope authentication header")
      }
    }
    if (!key) return error(401, "missing authorization information")
    if (!/^[a-fA-F0-9]{32}$/.test(key)) return error(400, "bad sentry DSN public key")
    if (version && (!/^\d+$/.test(version) || Number(version) > 7))
      return error(400, `unsupported protocol version (${version})`)
    if (key !== project.publicKey)
      return error(403, "event submission rejected with_reason: ProjectKey")
    return undefined
  }
  private async minidump(c: OperationContext, bytes: Uint8Array): Promise<Envelope> {
    let dump = bytes
    let data: JsonObject = {}
    let name = "upload_file_minidump"
    const attachments: EnvelopeItem[] = []
    if ((c.request.headers.get("content-type") ?? "").startsWith("multipart/form-data")) {
      const form = await new Response(bytes.slice(), { headers: c.request.headers }).formData()
      const file = form.get("upload_file_minidump")
      if (!(file instanceof Blob)) throw new Error("missing minidump")
      dump = new Uint8Array(await file.arrayBuffer())
      if (file instanceof File) name = file.name
      const value = form.get("sentry")
      if (typeof value === "string") data = parseJson(encode(value))
      for (const [field, value] of form) {
        if (field !== "upload_file_minidump" && value instanceof Blob)
          attachments.push({
            headers: {
              type: "attachment",
              filename: value instanceof File ? value.name : field,
              content_type: value.type || "application/octet-stream",
            },
            payload: new Uint8Array(await value.arrayBuffer()),
          })
      }
    }
    const magic = new TextDecoder().decode(dump.slice(0, 4))
    if (dump.length < 4 || (magic !== "MDMP" && magic !== "PMDM"))
      throw new Error("invalid minidump")
    return {
      headers: {},
      items: [
        {
          headers: { type: "event" },
          payload: encode(JSON.stringify({ platform: "native", ...data })),
        },
        {
          headers: {
            type: "attachment",
            filename: name,
            content_type: "application/x-dmp",
            attachment_type: "event.minidump",
          },
          payload: dump,
        },
        ...attachments,
      ],
    }
  }
  private async ingest(
    c: OperationContext,
    kind: "envelope" | "store" | "minidump",
  ): Promise<Response> {
    const raw = this.raw.get(c.request)
    if (!raw || raw.decoded.length === 0) return error(400, "empty request body")
    let envelope: Envelope
    try {
      envelope =
        kind === "envelope"
          ? parseEnvelope(raw.decoded)
          : kind === "minidump"
            ? await this.minidump(c, raw.decoded)
            : { headers: {}, items: [{ headers: { type: "event" }, payload: raw.decoded }] }
    } catch (e) {
      return error(
        400,
        e instanceof Error && ["invalid minidump", "missing minidump"].includes(e.message)
          ? e.message
          : kind === "envelope"
            ? "invalid event envelope"
            : "invalid request body",
      )
    }
    const auth = this.ingestAuth(c, envelope)
    if (auth) return auth
    if (faultEffect(c.request, "rate_limited") !== undefined)
      return json(
        429,
        {
          detail:
            "Sentry dropped data due to a quota or internal rate limit being reached. This will not affect your application. See https://docs.sentry.io/product/accounts/quotas/ for more information.",
        },
        { "x-sentry-rate-limits": "60:error:organization", "retry-after": "60" },
      )
    if (faultEffect(c.request, "item_rejected") !== undefined)
      return error(403, "event submission rejected with_reason: EventFiltered")
    const projectId = c.params.project as string
    let id: string | undefined
    const events: { item: EnvelopeItem; data: JsonObject }[] = []
    const sessions: JsonObject[] = []
    const reports: JsonObject[] = []
    const settings = this.state.current()
    const kept = envelope.items.filter((item) => !settings.rejectItems.includes(item.headers.type))
    try {
      id = eventId(envelope.headers.event_id)
      for (const item of kept) {
        if (["event", "transaction"].includes(item.headers.type)) {
          const data = parseJson(item.payload)
          const itemId = eventId(data.event_id)
          if (id && itemId && id !== itemId) throw new Error("invalid event id")
          id ??= itemId
          if (events.length > 0) throw new Error("invalid event envelope")
          if (
            data.timestamp !== undefined &&
            !Number.isFinite(
              typeof data.timestamp === "number"
                ? data.timestamp
                : Date.parse(String(data.timestamp)) / 1000,
            )
          )
            throw new Error("invalid request body")
          events.push({ item, data })
        } else if (["session", "sessions"].includes(item.headers.type))
          sessions.push(parseJson(item.payload))
        else if (item.headers.type === "client_report") reports.push(parseJson(item.payload))
      }
    } catch (e) {
      return error(400, e instanceof Error ? e.message : "invalid request body")
    }
    const hasEvent = events.length > 0 || kept.some((item) => item.headers.type === "attachment")
    if (hasEvent && !id) id = this.state.nextEventId()
    const outputId = id
    const response = () =>
      kind === "minidump" && outputId
        ? new Response(outputId.replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, "$1-$2-$3-$4-$5"), {
            headers: { "content-type": "text/plain; charset=utf-8" },
          })
        : json(200, outputId ? { id: outputId } : {})
    // Event IDs dedupe per project. Replays neither regroup nor duplicate attachments/captures.
    if (outputId && this.state.events.has(this.state.eventKey(projectId, outputId)))
      return response()
    const key = await this.key
    const sealed = await seal(raw.wire, key)
    const sealedAttachments = await Promise.all(
      kept
        .filter((item) => item.headers.type === "attachment")
        .map(async (item) => ({ item, raw: await seal(item.payload, key) })),
    )
    this.sqlite.transaction(() => {
      // Encryption is asynchronous; recheck inside the transaction for concurrent replay safety.
      if (outputId && this.state.events.has(this.state.eventKey(projectId, outputId))) return
      const envelopeId = this.state.ids.next("envelope_")
      const receivedAt = this.iso()
      const sanitizedHeaders = object(this.scrub(envelope.headers))
      delete sanitizedHeaders.dsn
      this.state.envelopes.insert(envelopeId, {
        id: envelopeId,
        projectId,
        eventId: outputId ?? null,
        receivedAt,
        headers: sanitizedHeaders,
        items: envelope.items.map((item) => ({
          type: item.headers.type,
          bytes: item.payload.length,
          headers: object(this.scrub(item.headers)),
          rejected: settings.rejectItems.includes(item.headers.type),
        })),
        raw: sealed,
      })
      for (const { item, data: input } of events) {
        if (!outputId) continue
        const data = object(this.scrub(input))
        // Relay LogEntry accepts legacy message=false and discards that value.
        if (data.message === false) delete data.message
        // Production personal attributes are deliberately not retained; user.id is the fake fixture identity.
        if (data.user)
          data.user = object(data.user).id === undefined ? null : { id: object(data.user).id }
        const type =
          item.headers.type === "transaction" || data.type === "transaction"
            ? "transaction"
            : "error"
        const timestamp =
          input.timestamp === undefined
            ? this.now() / 1000
            : typeof input.timestamp === "number"
              ? input.timestamp
              : Date.parse(String(input.timestamp)) / 1000
        const eventTitle = title(data)
        let groupId: string | null = null
        if (type !== "transaction") {
          const fingerprint =
            Array.isArray(data.fingerprint) && data.fingerprint.length > 0
              ? JSON.stringify(data.fingerprint)
              : settings.grouping === "message"
                ? String(data.message ?? eventTitle)
                : JSON.stringify({
                    title: eventTitle,
                    frames:
                      object(
                        object(
                          Array.isArray(object(data.exception).values)
                            ? (object(data.exception).values as unknown[]).at(-1)
                            : undefined,
                        ).stacktrace,
                      ).frames ?? [],
                  })
          const previous = this.state.issues
            .list()
            .find(
              ({ value }) => value.projectId === projectId && value.fingerprint === fingerprint,
            )?.value
          groupId = previous?.id ?? String(this.state.issues.nextSequence())
          const issue: IssueRecord = {
            id: groupId,
            projectId,
            fingerprint,
            title: eventTitle,
            level: String(data.level ?? "error"),
            count: (previous?.count ?? 0) + 1,
            firstSeen: previous?.firstSeen ?? receivedAt,
            lastSeen: receivedAt,
            status: previous?.status ?? "unresolved",
            latestEventId: outputId,
          }
          if (previous) this.state.issues.update(groupId, issue)
          else this.state.issues.insert(groupId, issue)
        }
        const captured: CapturedEvent = {
          event_id: outputId,
          projectId,
          receivedAt,
          timestamp,
          type,
          title: eventTitle,
          groupId,
          data: { ...data, event_id: outputId, timestamp },
        }
        this.state.events.insert(this.state.eventKey(projectId, outputId), captured)
        if (
          typeof data.release === "string" &&
          !this.state.releases.has(`${projectId}:${data.release}`)
        )
          this.state.releases.insert(`${projectId}:${data.release}`, {
            projectId,
            version: data.release,
            dateCreated: receivedAt,
          })
      }
      // Attachments may precede their event item and preserve binary newlines exactly.
      for (const { item, raw: attachmentRaw } of sealedAttachments) {
        const attachmentId = String(this.state.attachments.nextSequence())
        this.state.attachments.insert(attachmentId, {
          id: attachmentId,
          projectId,
          eventId: outputId as string,
          name: String(item.headers.filename ?? "attachment"),
          contentType: String(item.headers.content_type ?? "application/octet-stream"),
          size: item.payload.length,
          raw: attachmentRaw,
        })
      }
      for (const session of sessions) {
        const sessionKey = `${projectId}:${String(session.sid ?? this.state.ids.next("session_"))}`
        this.state.sessions.insert(sessionKey, { ...object(this.scrub(session)), projectId })
      }
      for (const report of reports)
        this.state.clientReports.insert(this.state.ids.next("report_"), {
          ...object(this.scrub(report)),
          projectId,
        })
    })
    return annotateResponse(response(), outputId ? { ids: { eventId: outputId } } : {})
  }

  private project(c: OperationContext): ProjectFixture | undefined {
    return this.state.project(c.params.organization ?? "", c.params.project ?? "")
  }
  private filtered(event: CapturedEvent, url: URL): boolean {
    const release = url.searchParams.get("release")
    const trace = url.searchParams.get("trace")
    const tag = url.searchParams.get("tag")
    if (release && event.data.release !== release) return false
    if (trace && object(object(event.data.contexts).trace).trace_id !== trace) return false
    if (tag) {
      const split = tag.indexOf(":")
      if (
        split < 1 ||
        String(object(event.data.tags)[tag.slice(0, split)]) !== tag.slice(split + 1)
      )
        return false
    }
    const query = url.searchParams.get("query") ?? ""
    for (const term of query.split(/\s+/).filter(Boolean)) {
      const [key, ...rest] = term.split(":")
      const value = rest.join(":")
      if (key === "is") continue
      if (key === "release" && event.data.release !== value) return false
      else if (key === "trace" && object(object(event.data.contexts).trace).trace_id !== value)
        return false
      else if (
        key !== "release" &&
        key !== "trace" &&
        value &&
        String(object(event.data.tags)[key ?? ""]) !== value
      )
        return false
      else if (!value && !event.title.toLowerCase().includes(term.toLowerCase())) return false
    }
    return true
  }
  /** Normalized assertion data; no headers, raw attachments or unfiltered request body. */
  captured(url: URL): CapturedEvent[] {
    return this.state.events
      .list()
      .map(({ value }) => value)
      .filter(
        (e) =>
          (!url.searchParams.get("project") || e.projectId === url.searchParams.get("project")) &&
          this.filtered(e, url),
      )
  }
  private eventWire(event: CapturedEvent, full = true): JsonObject {
    const data = event.data
    const entries: JsonObject[] = []
    for (const [key, type] of [
      ["exception", "exception"],
      ["breadcrumbs", "breadcrumbs"],
      ["request", "request"],
    ]) {
      if (full && key && data[key] !== undefined) entries.push({ type, data: data[key] })
    }
    const tags = Object.entries(object(data.tags)).map(([key, value]) => ({
      key,
      value: String(value),
    }))
    for (const key of ["release", "environment", "level"]) {
      if (data[key] !== undefined && !tags.some((tag) => tag.key === key))
        tags.push({ key, value: String(data[key]) })
    }
    return {
      // Vendor response fields must win over unknown incoming event attributes.
      ...(full ? data : {}),
      id: event.event_id,
      eventID: event.event_id,
      groupID: event.groupId,
      projectID: event.projectId,
      dateCreated: new Date(event.timestamp * 1000).toISOString(),
      dateReceived: event.receivedAt,
      title: event.title,
      message:
        typeof data.message === "string"
          ? data.message
          : String(object(data.logentry).formatted ?? ""),
      platform: String(data.platform ?? "other"),
      type: event.type,
      "event.type": event.type,
      tags,
      entries,
      user: data.user ?? null,
      contexts: data.contexts ?? {},
      metadata: { title: event.title },
    }
  }
  issueWire(issue: IssueRecord): JsonObject {
    const project = this.state.projects.get(issue.projectId) as ProjectFixture
    return {
      id: issue.id,
      shortId: `${project.slug.toUpperCase()}-${issue.id}`,
      title: issue.title,
      count: String(issue.count),
      firstSeen: issue.firstSeen,
      lastSeen: issue.lastSeen,
      level: issue.level,
      status: issue.status,
      statusDetails: {},
      project: { id: project.id, name: project.name, slug: project.slug },
      metadata: { title: issue.title },
      type: "error",
      issueType: "error",
      issueCategory: "error",
      culprit: "",
      logger: null,
      userCount: new Set(
        this.state.events
          .list()
          .filter(({ value }) => value.groupId === issue.id)
          .map(({ value }) => object(value.data.user).id)
          .filter((id) => id !== undefined),
      ).size,
      annotations: [],
      assignedTo: null,
      hasSeen: false,
      isBookmarked: false,
      isPublic: false,
      isSubscribed: false,
      numComments: 0,
      subscriptionDetails: null,
      stats: {},
    }
  }
  private page(c: OperationContext, rows: unknown[], cap = 100): Response {
    const limit = Number(c.url.searchParams.get("limit") ?? Math.min(100, cap))
    const cursor = c.url.searchParams.get("cursor") ?? "0:0:0"
    const match = /^0:(\d+):([01])$/.exec(cursor)
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > cap || !match)
      return error(400, "Invalid cursor or page size")
    const offset = Number(match[1])
    if (!Number.isSafeInteger(offset)) return error(400, "Invalid cursor")
    const base = new URL(c.url)
    const namespace = c.request.headers.get("x-emulates-namespace")
    if (namespace && namespace !== "default")
      base.pathname = `${this.adminPrefix}/ns/${encodeURIComponent(namespace)}${base.pathname}`
    const link = (rel: string, position: number, results: boolean, previous: boolean) => {
      const url = new URL(base)
      const nextCursor = `0:${position}:${previous ? 1 : 0}`
      url.searchParams.set("cursor", nextCursor)
      return `<${url}>; rel="${rel}"; results="${results}"; cursor="${nextCursor}"`
    }
    return json(200, rows.slice(offset, offset + limit), {
      link: [
        link("previous", Math.max(0, offset - limit), offset > 0, true),
        link("next", offset + limit, offset + limit < rows.length, false),
      ].join(", "),
    })
  }
  private listEvents(c: OperationContext): Response {
    const project = this.project(c)
    if (!project) return error(404, "The requested resource does not exist")
    const full = ["true", "1"].includes(c.url.searchParams.get("full") ?? "")
    const rows = this.state.events
      .list()
      .map(({ value }) => value)
      .filter((e) => e.projectId === project.id && e.type === "error" && this.filtered(e, c.url))
    return this.page(
      c,
      rows.map((e) => this.eventWire(e, full)),
      full ? 10 : 100,
    )
  }
  private getEvent(c: OperationContext): Response {
    const project = this.project(c)
    const event =
      project && this.state.events.get(this.state.eventKey(project.id, c.params.event ?? ""))
    return event
      ? json(200, this.eventWire(event))
      : error(404, "The requested resource does not exist")
  }
  private listIssues(c: OperationContext): Response {
    const project = this.project(c)
    if (!project) return error(404, "The requested resource does not exist")
    const query = c.url.searchParams.get("query") ?? "is:unresolved"
    const status = /(?:^|\s)is:(unresolved|resolved|ignored)(?:\s|$)/.exec(query)?.[1]
    const issues = this.state.issues
      .list()
      .map(({ value }) => value)
      .filter(
        (i) =>
          i.projectId === project.id &&
          (!status || i.status === status) &&
          this.state.events
            .list()
            .some(({ value }) => value.groupId === i.id && this.filtered(value, c.url)),
      )
      .sort((a, b) => b.lastSeen.localeCompare(a.lastSeen))
    return this.page(
      c,
      issues.map((i) => this.issueWire(i)),
    )
  }
  private scopedIssue(c: OperationContext): IssueRecord | undefined {
    const issue = this.state.issues.get(c.params.issue ?? "")
    if (!issue || !c.params.organization) return issue
    const project = this.state.projects.get(issue.projectId)
    return project &&
      [project.organization.slug, project.organization.id].includes(c.params.organization)
      ? issue
      : undefined
  }
  private getIssue(c: OperationContext): Response {
    const issue = this.scopedIssue(c)
    return issue
      ? json(200, this.issueWire(issue))
      : error(404, "The requested resource does not exist")
  }
  private updateIssue(c: OperationContext): Response {
    const issue = this.scopedIssue(c)
    if (!issue) return error(404, "The requested resource does not exist")
    const status = c.body.kind === "json" ? object(c.body.value).status : undefined
    if (status !== "resolved" && status !== "unresolved" && status !== "ignored")
      return error(400, "Invalid status")
    const updated: IssueRecord = { ...issue, status }
    this.state.issues.update(issue.id, updated)
    return json(200, this.issueWire(updated))
  }
  private attachmentWire(a: AttachmentRecord): JsonObject {
    return { id: a.id, name: a.name, size: a.size, mimetype: a.contentType, headers: {} }
  }
  private listAttachments(c: OperationContext): Response {
    const project = this.project(c)
    if (!project || !this.state.events.has(this.state.eventKey(project.id, c.params.event ?? "")))
      return error(404, "The requested resource does not exist")
    const rows = this.state.attachments
      .list({ order: "oldest" })
      .map(({ value }) => value)
      .filter((a) => a.projectId === project.id && a.eventId === c.params.event)
    return this.page(
      c,
      rows.map((a) => this.attachmentWire(a)),
    )
  }
  private async getAttachment(c: OperationContext): Promise<Response> {
    const project = this.project(c)
    const a = this.state.attachments.get(c.params.attachment ?? "")
    if (!project || !a || a.projectId !== project.id || a.eventId !== c.params.event)
      return error(404, "The requested resource does not exist")
    if (["true", "1"].includes(c.url.searchParams.get("download") ?? "")) {
      const bytes = await unseal(a.raw, await this.key)
      return new Response(bytes.slice(), {
        headers: {
          "content-type": a.contentType,
          "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(a.name)}`,
        },
      })
    }
    return json(200, this.attachmentWire(a))
  }
}

export type { SentryRuntime, SentryRuntimeOptions } from "./runtime.js"
export { createRuntime, SENTRY_PRESETS } from "./runtime.js"
