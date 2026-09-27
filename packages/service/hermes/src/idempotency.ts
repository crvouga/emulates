import { Collection } from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"
import { canonicalFingerprintInput, sha256 } from "./fingerprint.js"
import { HermesError, type HermesRuns, type RunRecord, record } from "./runs.js"

type Scope = { profile: string; identity: string }
type Reservation = { fingerprint: string; runId: string; scope: string }
/** Python str.strip whitespace differs from JavaScript trim (notably U+0085). */
export const strip = (value: string): string => {
  const whitespace = (point: number) =>
    (point >= 9 && point <= 13) ||
    (point >= 28 && point <= 32) ||
    (point >= 0x2000 && point <= 0x200a) ||
    [0x85, 0xa0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000].includes(point)
  let start = 0
  let end = value.length
  while (start < end && whitespace(value.charCodeAt(start))) start++
  while (end > start && whitespace(value.charCodeAt(end - 1))) end--
  return value.slice(start, end)
}
const defaultScope: Scope = { profile: "default", identity: "unauthenticated-test-listener" }

/** Explicit synthetic listener/profile scope; never derive identity from credentials. */
export class HermesIdempotency {
  private readonly settings: Collection<Scope>
  private readonly reservations: Collection<Reservation>
  private readonly owners: Collection<{ scope: string }>
  constructor(
    private readonly sqlite: SqliteClient,
    namespace: string,
    private readonly runs: HermesRuns,
  ) {
    this.settings = new Collection(sqlite, namespace, "hermes-scope")
    this.reservations = new Collection(sqlite, namespace, "hermes-idempotency")
    this.owners = new Collection(sqlite, namespace, "hermes-owners")
  }
  setScope(body: unknown): Scope {
    if (
      !record(body) ||
      Object.keys(body).some((k) => !["profile", "identity"].includes(k)) ||
      typeof body.profile !== "string" ||
      !body.profile ||
      body.profile.includes("\0") ||
      typeof body.identity !== "string" ||
      !body.identity ||
      body.identity.includes("\0")
    )
      throw new HermesError(
        400,
        "scope: expected nonempty synthetic profile and identity without NUL",
      )
    const scope = { profile: body.profile, identity: body.identity }
    this.settings.insert("current", scope)
    return scope
  }
  scope(): Promise<string> {
    const { profile, identity } = this.settings.get("current") ?? defaultScope
    return sha256(`${profile}\0${identity}`)
  }
  async get(id: string): Promise<RunRecord> {
    const scope = await this.scope()
    if (this.owners.get(id)?.scope !== scope)
      throw new HermesError(404, `Run not found: ${id}`, "run_not_found")
    return this.runs.get(id)
  }
  async submit(
    raw: string,
    key: string,
    memoryKey: string,
  ): Promise<{ run: RunRecord; replayed: boolean }> {
    let body: unknown
    try {
      body = JSON.parse(raw)
    } catch {
      throw new HermesError(400, "Invalid JSON")
    }
    if (key.length > 255 || /[^\x21-\x7e]/.test(key))
      throw new HermesError(
        400,
        "Idempotency-Key must be 1-255 visible ASCII characters",
        "invalid_idempotency_key",
      )
    this.runs.validate(body)
    const scopePromise = this.scope()
    const fingerprintPromise = key
      ? sha256(canonicalFingerprintInput(raw, memoryKey))
      : Promise.resolve("")
    const [scope, fingerprint] = await Promise.all([scopePromise, fingerprintPromise])
    const reservationId = JSON.stringify([scope, key])
    // No async work inside the shared SQLite transaction: racing facades cannot
    // both observe a missing reservation and create distinct runs.
    return this.sqlite.transaction(() => {
      const existing = key ? this.reservations.get(reservationId) : undefined
      if (existing) {
        if (existing.fingerprint !== fingerprint)
          throw new HermesError(
            409,
            "Idempotency-Key was already used with a different request payload",
            "idempotency_key_conflict",
          )
        return { run: this.runs.get(existing.runId), replayed: true }
      }
      const run = this.runs.create(body)
      this.owners.insert(run.run_id, { scope })
      if (key) this.reservations.insert(reservationId, { fingerprint, runId: run.run_id, scope })
      return { run, replayed: false }
    })
  }
}
