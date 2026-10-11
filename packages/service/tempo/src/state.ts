import { Collection } from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"
import type { DecodedSpan, WireResource, WireScope, WireSpan } from "./otlp.js"

/** Tempo's tenant when multi-tenancy is off (`util.FakeTenantID`). */
export const SINGLE_TENANT = "single-tenant"

/**
 * One ingested span, in the JSON shape `GET /api/traces/{id}` answers with, beside the hex ids
 * and the batch position it was exported at.
 */
export type StoredSpan = {
  tenant: string
  /** 32 lowercase hex characters. */
  traceId: string
  /** 16 lowercase hex characters. */
  spanId: string
  /** 16 lowercase hex characters, or `""` for a root span. */
  parentSpanId: string
  /** The export that carried the span and its `ResourceSpans` position: one batch of the trace. */
  batch: string
  /** Position of the span's `ScopeSpans` in that batch. */
  scopeIndex: number
  resource: WireResource
  resourceSchemaUrl: string
  scope: WireScope
  scopeSchemaUrl: string
  span: WireSpan
}

/** The response a gateway in front of Tempo gives a request it does not authenticate. */
export type UnauthorizedResponse = { status: number; body: string; contentType: string }

/** Per-namespace knobs, set through `PUT /__admin/settings`; cleared on reset. */
export type Settings = {
  /**
   * Bearer tokens the gateway in front of Tempo accepts. With no tokens and no users the
   * emulator behaves like a local Tempo: no authentication at all.
   */
  bearerTokens: string[]
  /** Basic-auth users the gateway accepts (Grafana Cloud: instance id and access token). */
  basicUsers: { username: string; password: string }[]
  /** What a request without acceptable credentials gets. */
  unauthorized: UnauthorizedResponse
  /**
   * Tempo's `multitenancy_enabled`: every request needs `X-Scope-OrgID`, and a tenant reads only
   * what it wrote. Off, the header is ignored and everything lands in `single-tenant`.
   */
  multitenancy: boolean
  /** Tempo's `left_pad_trace_ids` override: search answers 32-character trace ids. */
  leftPadTraceIds: boolean
  /** `query_frontend.search.default_result_limit`. */
  defaultLimit: number
  /** `query_frontend.search.max_result_limit`; `0` lifts the cap. */
  maxLimit: number
}

export const DEFAULT_SETTINGS: Settings = {
  bearerTokens: [],
  basicUsers: [],
  unauthorized: {
    status: 401,
    body: "Unauthorized\n",
    contentType: "text/plain; charset=utf-8",
  },
  multitenancy: false,
  leftPadTraceIds: false,
  defaultLimit: 20,
  maxLimit: 262_144,
}

export class TempoState {
  readonly spans: Collection<StoredSpan>
  readonly settings: Collection<Settings>

  constructor(
    sqlite: SqliteClient,
    namespace: string,
    private readonly seed: { settings: Partial<Settings> },
  ) {
    this.spans = new Collection(sqlite, namespace, "spans")
    this.settings = new Collection(sqlite, namespace, "settings")
    this.ensureSeeded()
  }

  /** Re-apply the settings after a reset. */
  ensureSeeded(): void {
    if (!this.settings.has("settings")) {
      this.settings.insert("settings", { ...DEFAULT_SETTINGS, ...this.seed.settings })
    }
  }

  current(): Settings {
    return { ...DEFAULT_SETTINGS, ...this.settings.get("settings") }
  }

  update(patch: Partial<Settings>): Settings {
    const next = { ...this.current(), ...patch }
    this.settings.insert("settings", next)
    return next
  }

  /**
   * Store one export's spans for `tenant`. A span id already stored for the trace is replaced
   * in place (Tempo's combiner keeps one span per id), so re-exporting is idempotent.
   */
  ingest(tenant: string, spans: readonly DecodedSpan[]): void {
    if (spans.length === 0) return
    const exportId = this.spans.nextSequence()
    for (const decoded of spans) {
      const id = `${decoded.traceId}:${decoded.spanId}:${tenant}`
      const stored: StoredSpan = {
        tenant,
        traceId: decoded.traceId,
        spanId: decoded.spanId,
        parentSpanId: decoded.parentSpanId,
        batch: `${exportId}.${decoded.resourceIndex}`,
        scopeIndex: decoded.scopeIndex,
        resource: decoded.resource,
        resourceSchemaUrl: decoded.resourceSchemaUrl,
        scope: decoded.scope,
        scopeSchemaUrl: decoded.scopeSchemaUrl,
        span: decoded.span,
      }
      if (this.spans.has(id)) this.spans.update(id, stored)
      else this.spans.insert(id, stored)
    }
  }

  /** Every stored span passing `filter`, in ingest order. */
  list(filter: (span: StoredSpan) => boolean = () => true): StoredSpan[] {
    return this.spans
      .list({ order: "oldest", where: (value) => filter(value) })
      .map((stored) => stored.value)
  }

  /** One tenant's spans grouped by trace id, each trace in ingest order. */
  traces(tenant: string): Map<string, StoredSpan[]> {
    const out = new Map<string, StoredSpan[]>()
    for (const span of this.list((s) => s.tenant === tenant)) {
      const trace = out.get(span.traceId)
      if (trace) trace.push(span)
      else out.set(span.traceId, [span])
    }
    return out
  }
}
