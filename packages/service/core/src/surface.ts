import type { SqliteClient } from "@crvouga/mockingbird-sqlite"
import type { Clock, ClockState } from "./clock.js"
import type { CredentialRegistry } from "./credentials.js"
import type { FaultRegistry, FaultRule } from "./faults.js"
import type { Journal } from "./journal.js"
import type { Metrics } from "./metrics.js"
import type { Rng } from "./rng.js"
import type { NamespaceSnapshot } from "./snapshot.js"
import type { StateView } from "./state-view.js"

/**
 * What every mock can be called with. A service may accept more fields — accounts,
 * catalogs, webhook endpoints — and those stay optional so `createRuntime()` and
 * `createRuntime({ seed, adminKey })` work everywhere.
 */
export type MockCreateOptions = {
  sqlite?: SqliteClient
  clock?: Clock
  seed?: number | string
  adminKey?: string
}

/** A checkpoint head the admin client can show. Services may return a richer object. */
export type MockCheckpoint = {
  readonly id: string
  readonly branch: string
  readonly parent: string | null
  readonly at: number
}

/** The instance behind one namespace. Vendor methods sit beside these, not instead of them. */
export type MockInstanceSurface = {
  fetch(request: Request): Promise<Response>
  reset(): Promise<void>
}

/**
 * The interface every mock runtime implements.
 *
 * Assignability is one way: a service may add methods (`tick`, a typed webhook hub,
 * account directories) and narrower property types. Removing or renaming a member
 * fails the typecheck. The HTTP control plane (`/health`, `/__admin/*`) is the same
 * contract on the wire; {@link STANDARD_ADMIN_ROUTES} is that list.
 */
export type MockSurface = {
  readonly name: string
  fetch(request: Request): Promise<Response>
  readonly clock: Clock
  readonly faults: FaultRegistry
  readonly metrics: Metrics
  readonly journal: Journal
  readonly rng: Rng
  readonly credentials: CredentialRegistry
  /** Present on every runtime. `undefined` when the service has no outbound webhooks. */
  readonly webhooks: unknown
  applyPreset(name: string, namespace?: string, overrides?: Partial<FaultRule>): FaultRule[]
  instance(namespace?: string): MockInstanceSurface
  namespaces(): string[]
  reset(namespace?: string): Promise<void>
  snapshot(namespace?: string): NamespaceSnapshot
  restore(snapshot: NamespaceSnapshot, namespace?: string): void
  checkpoint(namespace?: string, branch?: string): MockCheckpoint
  branch(name: string, options?: { namespace?: string; at?: string }): MockCheckpoint
  checkout(checkpoint: string, options?: { namespace?: string; branch?: string }): void
  timeline(namespace?: string): {
    head(branch?: string): { readonly id: string } | undefined
    branches(): Readonly<Record<string, string>>
  }
  /** Collections in `namespace`, declared by the service and inferred from stored rows. */
  state(namespace?: string): StateView
  readonly sqlite: SqliteClient
}

/**
 * Keep a service's own runtime type while proving it is a {@link MockSurface}.
 * Extra members stay. A missing member is a type error at the definition.
 */
export const defineMock = <T extends MockSurface>(runtime: T): T => runtime

/** Clock state is part of the surface so admin clients can render it without a cast. */
export type MockClockState = ClockState

/**
 * Admin routes every mock answers. A service adds its own keys beside these.
 * A key in this list keeps the shared handler, so the state API and the admin UI
 * stay the same when a service also ships vendor-specific controls.
 */
export const STANDARD_ADMIN_ROUTES = [
  "GET /",
  "POST /reset",
  "GET /namespaces",
  "GET /clock",
  "POST /clock",
  "GET /faults",
  "POST /faults",
  "DELETE /faults",
  "POST /snapshots",
  "POST /snapshots/:id/restore",
  "DELETE /snapshots/:id",
  "GET /timeline",
  "POST /checkpoints",
  "POST /branches/:name",
  "POST /branches/:name/checkout",
  "GET /requests",
  "DELETE /requests",
  "GET /metrics",
  "DELETE /metrics",
  "GET /credentials",
  "PUT /credentials",
  "DELETE /credentials",
  "GET /state",
  "GET /state/:collection",
  "GET /state/:collection/:id",
  "POST /state/:collection",
  "PUT /state/:collection/:id",
  "PATCH /state/:collection/:id",
  "DELETE /state/:collection/:id",
  "GET /ui",
  "GET /ui/",
  "GET /ui/manifest",
] as const

export type StandardAdminRoute = (typeof STANDARD_ADMIN_ROUTES)[number]

/** A panel the default admin shell mounts after the shared views. */
export type AdminPanel = {
  /** DOM id suffix. Lowercase letters, digits, and hyphens. */
  id: string
  title: string
  description?: string
  /** Markup placed inside the panel body. The service author owns it. */
  html: string
  /**
   * Function body called as `(root, api) => void` once the shell has loaded.
   * `root` is the panel body. `api` is `{ get, send, namespace }` against `/__admin`.
   */
  script?: string
}

/**
 * How a service customizes the admin UI without leaving the shared shell.
 * `panels` add views. `render` replaces the document and can call `defaultHtml()`
 * to wrap the shared shell instead of discarding it.
 */
export type AdminUi = {
  panels?: readonly AdminPanel[]
  render?: (input: { service: string; defaultHtml: () => string }) => string
}

const PANEL_ID = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/

/** Reject a panel id the shell cannot mount. Called when the runtime is created. */
export const assertAdminUi = (ui: AdminUi | undefined): void => {
  if (!ui?.panels) return
  const seen = new Set<string>()
  for (const panel of ui.panels) {
    if (!PANEL_ID.test(panel.id)) {
      throw new RangeError(`admin panel id must match ${PANEL_ID}: ${JSON.stringify(panel.id)}`)
    }
    if (seen.has(panel.id)) throw new RangeError(`duplicate admin panel id ${panel.id}`)
    seen.add(panel.id)
    if (panel.title.trim() === "") throw new RangeError(`admin panel ${panel.id} needs a title`)
  }
}
