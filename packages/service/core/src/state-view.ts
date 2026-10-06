import type { SqliteClient } from "@emulates/sqlite-client"
import { Collection } from "./collection.js"
import type { AdminRoutes } from "./control.js"

export const STATE_FIELD_KINDS = [
  "string",
  "number",
  "boolean",
  "null",
  "object",
  "array",
  "unknown",
] as const

export type StateFieldKind = (typeof STATE_FIELD_KINDS)[number]

/** JSON-safe annotations a bespoke admin UI may read. The default UI shows them as text. */
export type StateMeta = Readonly<Record<string, string | number | boolean | null>>

export type StateField = {
  name: string
  kind: StateFieldKind
  optional: boolean
  description?: string
  /** One level of nested object fields. */
  fields?: StateField[]
  meta?: StateMeta
}

/**
 * What a service knows about a collection before any row exists.
 * Stored rows still appear, including fields this declaration does not mention.
 */
export type StateDeclaration = {
  name: string
  label?: string
  description?: string
  fields?: readonly StateField[]
  meta?: StateMeta
}

export type StateCollectionView = {
  name: string
  label: string
  description?: string
  count: number
  /** `mixed` when a declaration and stored rows both contribute fields. */
  source: "declared" | "inferred" | "mixed"
  fields: StateField[]
  meta?: StateMeta
}

/** The shape of one namespace, for an admin UI that has never seen the service before. */
export type StateView = {
  namespace: string
  storageNamespace: string
  collections: StateCollectionView[]
}

export type StateRecord = {
  id: string
  seq: number
  value: unknown
}

export type StatePage = {
  collection: string
  count: number
  records: StateRecord[]
  next: number | null
}

export type StateFailure = { ok: false; status: number; message: string }
export type StateResult<T> = { ok: true; value: T } | StateFailure

const COLLECTION_NAME = /^[A-Za-z0-9_.@:-]{1,200}$/
const RECORD_ID = /^[^\s/]{1,256}$/
const SAMPLE = 25
const WALK_LIMIT = 10_000
const SKIP_CTORS = new Set(["Hono", "HonoRequest", "Router"])

const fail = (status: number, message: string): StateFailure => ({ ok: false, status, message })

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const kindOf = (value: unknown): StateFieldKind => {
  if (value === null) return "null"
  if (Array.isArray(value)) return "array"
  switch (typeof value) {
    case "string":
      return "string"
    case "number":
      return Number.isFinite(value) ? "number" : "unknown"
    case "boolean":
      return "boolean"
    case "object":
      return "object"
    default:
      return "unknown"
  }
}

const humanize = (name: string): string => {
  const words = name.replace(/[@:_-]+/g, " ").trim()
  if (words === "") return name
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/** Drop values that cannot ride in a JSON admin response. */
export const jsonValue = (value: unknown): StateResult<unknown> => {
  if (value === undefined) return fail(400, "value is required")
  try {
    return { ok: true, value: JSON.parse(JSON.stringify(value)) as unknown }
  } catch {
    return fail(400, "value must be JSON")
  }
}

const ctorName = (value: object): string => {
  const ctor = (value as { constructor?: { name?: string } }).constructor
  return typeof ctor?.name === "string" ? ctor.name : ""
}

const isSqlite = (value: object): boolean =>
  "prepare" in value &&
  typeof (value as { prepare?: unknown }).prepare === "function" &&
  "transaction" in value

/** Every Collection hanging off `root`, including ones stored in maps. */
export const discoverCollections = (root: unknown): Collection<unknown>[] => {
  const found: Collection<unknown>[] = []
  const seen = new Set<object>()
  const visit = (value: unknown, depth: number): void => {
    if (found.length + seen.size > WALK_LIMIT) return
    if (value === null || typeof value !== "object") return
    if (seen.has(value)) return
    seen.add(value)
    if (value instanceof Collection) {
      found.push(value as Collection<unknown>)
      return
    }
    if (value instanceof Map) {
      for (const child of value.values()) visit(child, depth + 1)
      return
    }
    if (value instanceof Set) {
      for (const child of value.values()) visit(child, depth + 1)
      return
    }
    if (depth > 6 || isSqlite(value) || SKIP_CTORS.has(ctorName(value))) return
    if (Array.isArray(value)) {
      const cap = Math.min(value.length, 32)
      for (let i = 0; i < cap; i++) visit(value[i], depth + 1)
      return
    }
    let children: unknown[]
    try {
      children = Object.values(value)
    } catch {
      return
    }
    for (const child of children) visit(child, depth + 1)
  }
  visit(root, 0)
  return found
}

const storedNames = (sqlite: SqliteClient, namespace: string): string[] => {
  const records = sqlite
    .prepare("SELECT DISTINCT collection AS name FROM emulators_records WHERE namespace = ?")
    .all<{ name: string }>(namespace)
  const sequences = sqlite
    .prepare(
      "SELECT DISTINCT name FROM emulators_sequences WHERE namespace = ? AND kind = 'collection'",
    )
    .all<{ name: string }>(namespace)
  return [...records, ...sequences].map((row) => row.name)
}

type FieldAccum = {
  name: string
  kinds: Set<StateFieldKind>
  present: number
  nested: Map<string, FieldAccum>
}

const blankAccum = (name: string): FieldAccum => ({
  name,
  kinds: new Set(),
  present: 0,
  nested: new Map(),
})

const absorb = (accum: FieldAccum, value: unknown): void => {
  const kind = kindOf(value)
  accum.kinds.add(kind)
  accum.present++
  if (!isRecord(value)) return
  for (const [key, child] of Object.entries(value)) {
    const nested = accum.nested.get(key) ?? blankAccum(key)
    absorb(nested, child)
    accum.nested.set(key, nested)
  }
}

const finishField = (accum: FieldAccum, samples: number): StateField => {
  const kinds = [...accum.kinds]
  const kind = kinds.length === 1 ? (kinds[0] as StateFieldKind) : "unknown"
  const field: StateField = {
    name: accum.name,
    kind,
    optional: accum.present < samples || kinds.includes("null"),
  }
  if (accum.nested.size > 0) {
    field.fields = [...accum.nested.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((child) => finishField(child, accum.present))
  }
  return field
}

const inferFields = (records: StateRecord[]): StateField[] => {
  if (records.length === 0) return []
  const sample = records.slice(0, SAMPLE)
  const objects = sample.filter((record) => isRecord(record.value))
  if (objects.length === 0) {
    const kinds = new Set(sample.map((record) => kindOf(record.value)))
    const list = [...kinds]
    return [
      {
        name: "(value)",
        kind: list.length === 1 ? (list[0] as StateFieldKind) : "unknown",
        optional: false,
      },
    ]
  }
  const root = new Map<string, FieldAccum>()
  for (const record of objects) {
    for (const [key, value] of Object.entries(record.value as Record<string, unknown>)) {
      const accum = root.get(key) ?? blankAccum(key)
      absorb(accum, value)
      root.set(key, accum)
    }
  }
  return [...root.values()]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((accum) => finishField(accum, objects.length))
}

const mergeFields = (
  declared: readonly StateField[] | undefined,
  inferred: StateField[],
): StateField[] => {
  const byName = new Map<string, StateField>()
  for (const field of inferred) byName.set(field.name, field)
  const ordered: StateField[] = []
  const seen = new Set<string>()
  for (const field of declared ?? []) {
    const found = byName.get(field.name)
    seen.add(field.name)
    if (!found) {
      ordered.push({ ...field, optional: field.optional })
      continue
    }
    ordered.push({
      ...found,
      kind: field.kind === "unknown" ? found.kind : field.kind,
      optional: field.optional || found.optional,
      ...(field.description !== undefined ? { description: field.description } : {}),
      ...(field.meta !== undefined ? { meta: field.meta } : {}),
      ...(field.fields !== undefined
        ? { fields: mergeFields(field.fields, found.fields ?? []) }
        : {}),
    })
  }
  for (const field of inferred) {
    if (!seen.has(field.name)) ordered.push(field)
  }
  return ordered
}

const collectionOf = (sqlite: SqliteClient, namespace: string, name: string) =>
  new Collection<unknown>(sqlite, namespace, name)

const readRecord = (collection: Collection<unknown>, id: string): StateRecord | undefined => {
  const rows = collection.list({ where: (_value, _seq) => true, order: "oldest" })
  const row = rows.find((entry) => entry.id === id)
  return row ? { id: row.id, seq: row.seq, value: row.value } : undefined
}

export type StateScope = {
  sqlite: SqliteClient
  /** Public namespace name a request selects. */
  namespace: string
  /** Namespace key used in `emulators_records`. */
  storageNamespace: string
  /** Service instance, walked for Collection fields. */
  root: unknown
  declarations?: readonly StateDeclaration[]
}

/** Describe every collection in a namespace. Empty declared collections are included. */
export const inspectState = (scope: StateScope): StateView => {
  const declared = new Map<string, StateDeclaration>()
  for (const declaration of scope.declarations ?? []) {
    if (COLLECTION_NAME.test(declaration.name)) declared.set(declaration.name, declaration)
  }
  const names = new Set<string>(declared.keys())
  for (const name of storedNames(scope.sqlite, scope.storageNamespace)) names.add(name)
  for (const collection of discoverCollections(scope.root)) {
    if (collection.namespace === scope.storageNamespace) names.add(collection.collectionName)
  }
  const collections: StateCollectionView[] = []
  for (const name of names) {
    if (!COLLECTION_NAME.test(name)) continue
    const declaration = declared.get(name)
    const collection = collectionOf(scope.sqlite, scope.storageNamespace, name)
    const records = collection
      .list({ order: "newest" })
      .slice(0, SAMPLE)
      .map((row) => ({ id: row.id, seq: row.seq, value: row.value }))
    const inferred = inferFields(records)
    const fields = mergeFields(declaration?.fields, inferred)
    const source =
      declaration && records.length > 0 ? "mixed" : declaration ? "declared" : "inferred"
    collections.push({
      name,
      label: declaration?.label ?? humanize(name),
      ...(declaration?.description !== undefined ? { description: declaration.description } : {}),
      count: collection.count(),
      source,
      fields,
      ...(declaration?.meta !== undefined ? { meta: declaration.meta } : {}),
    })
  }
  const order = new Map<string, number>()
  for (const [index, item] of (scope.declarations ?? []).entries()) order.set(item.name, index)
  collections.sort((a, b) => {
    const left = order.get(a.name)
    const right = order.get(b.name)
    if (left !== undefined && right !== undefined) return left - right
    if (left !== undefined) return -1
    if (right !== undefined) return 1
    return a.name.localeCompare(b.name)
  })
  return {
    namespace: scope.namespace,
    storageNamespace: scope.storageNamespace,
    collections,
  }
}

export type StateQuery = {
  limit?: number
  after?: number
  order?: "newest" | "oldest"
}

const pageOf = (
  sqlite: SqliteClient,
  storageNamespace: string,
  name: string,
  query: StateQuery,
): StateResult<StatePage> => {
  if (!COLLECTION_NAME.test(name)) return fail(400, "collection name is not allowed")
  const limit = query.limit ?? 50
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    return fail(400, "limit must be an integer from 1 to 200")
  }
  const order = query.order ?? "newest"
  if (order !== "newest" && order !== "oldest")
    return fail(400, 'order must be "newest" or "oldest"')
  const collection = collectionOf(sqlite, storageNamespace, name)
  const rows = collection.list({ order }).filter((row) => {
    if (query.after === undefined) return true
    return order === "newest" ? row.seq < query.after : row.seq > query.after
  })
  const slice = rows.slice(0, limit)
  const last = slice.at(-1)
  return {
    ok: true,
    value: {
      collection: name,
      count: collection.count(),
      records: slice.map((row) => ({ id: row.id, seq: row.seq, value: row.value })),
      next: rows.length > limit && last ? last.seq : null,
    },
  }
}

export const readStatePage = (
  scope: Pick<StateScope, "sqlite" | "storageNamespace">,
  name: string,
  query: StateQuery = {},
): StateResult<StatePage> => pageOf(scope.sqlite, scope.storageNamespace, name, query)

export const readStateRecord = (
  scope: Pick<StateScope, "sqlite" | "storageNamespace">,
  name: string,
  id: string,
): StateResult<StateRecord> => {
  if (!COLLECTION_NAME.test(name)) return fail(400, "collection name is not allowed")
  if (!RECORD_ID.test(id)) return fail(400, "record id is not allowed")
  const record = readRecord(collectionOf(scope.sqlite, scope.storageNamespace, name), id)
  return record ? { ok: true, value: record } : fail(404, `no record ${id} in ${name}`)
}

const requireId = (id: string): StateResult<string> =>
  RECORD_ID.test(id) ? { ok: true, value: id } : fail(400, "id must be a single path segment")

export const createStateRecord = (
  scope: Pick<StateScope, "sqlite" | "storageNamespace">,
  name: string,
  input: { id?: string; value: unknown },
): StateResult<StateRecord> => {
  if (!COLLECTION_NAME.test(name)) return fail(400, "collection name is not allowed")
  const parsed = jsonValue(input.value)
  if (!parsed.ok) return parsed
  const collection = collectionOf(scope.sqlite, scope.storageNamespace, name)
  const id = input.id ?? `${name}_${collection.nextSequence()}`
  const checked = requireId(id)
  if (!checked.ok) return checked
  if (collection.has(checked.value)) return fail(409, `record ${checked.value} already exists`)
  const stored = collection.insert(checked.value, parsed.value)
  return { ok: true, value: { id: checked.value, seq: stored.seq, value: stored.value } }
}

export const replaceStateRecord = (
  scope: Pick<StateScope, "sqlite" | "storageNamespace">,
  name: string,
  id: string,
  value: unknown,
): StateResult<StateRecord> => {
  if (!COLLECTION_NAME.test(name)) return fail(400, "collection name is not allowed")
  const checked = requireId(id)
  if (!checked.ok) return checked
  const parsed = jsonValue(value)
  if (!parsed.ok) return parsed
  const collection = collectionOf(scope.sqlite, scope.storageNamespace, name)
  if (!collection.has(checked.value)) return fail(404, `no record ${checked.value} in ${name}`)
  const stored = collection.update(checked.value, parsed.value)
  if (!stored) return fail(404, `no record ${checked.value} in ${name}`)
  return { ok: true, value: { id: checked.value, seq: stored.seq, value: stored.value } }
}

export const patchStateRecord = (
  scope: Pick<StateScope, "sqlite" | "storageNamespace">,
  name: string,
  id: string,
  value: unknown,
): StateResult<StateRecord> => {
  const current = readStateRecord(scope, name, id)
  if (!current.ok) return current
  const parsed = jsonValue(value)
  if (!parsed.ok) return parsed
  const next =
    isRecord(current.value.value) && isRecord(parsed.value)
      ? { ...current.value.value, ...parsed.value }
      : parsed.value
  return replaceStateRecord(scope, name, id, next)
}

export const deleteStateRecord = (
  scope: Pick<StateScope, "sqlite" | "storageNamespace">,
  name: string,
  id: string,
): StateResult<{ id: string }> => {
  if (!COLLECTION_NAME.test(name)) return fail(400, "collection name is not allowed")
  const checked = requireId(id)
  if (!checked.ok) return checked
  const collection = collectionOf(scope.sqlite, scope.storageNamespace, name)
  return collection.delete(checked.value)
    ? { ok: true, value: { id: checked.value } }
    : fail(404, `no record ${checked.value} in ${name}`)
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  })

const adminError = (status: number, message: string): Response =>
  json(status, { error: { type: "emulators_admin", message } })

const fromResult = <T>(result: StateResult<T>, status: number): Response =>
  result.ok ? json(status, result.value) : adminError(result.status, result.message)

const integerParam = (value: string | null): number | undefined | "bad" => {
  if (value === null) return undefined
  if (!/^-?\d+$/.test(value)) return "bad"
  return Number(value)
}

export type StateRoutes = {
  /** Open the public namespace and return the scope the state routes read. */
  open(namespace: string): StateScope
  /** Called after a successful write so Timeline records the new rows. */
  afterWrite?(namespace: string): void
}

/** The shared `/__admin/state*` routes. Registered after service routes so this key always wins. */
export const stateAdminRoutes = (routes: StateRoutes): AdminRoutes => {
  const open = (namespace: string): StateResult<StateScope> => {
    try {
      return { ok: true, value: routes.open(namespace) }
    } catch (error) {
      return fail(400, error instanceof Error ? error.message : String(error))
    }
  }
  const wrote = (namespace: string) => {
    routes.afterWrite?.(namespace)
  }
  return {
    "GET /state": ({ namespace }) => {
      const scope = open(namespace)
      return fromResult(scope.ok ? { ok: true, value: inspectState(scope.value) } : scope, 200)
    },
    "GET /state/:collection": ({ namespace, params, url }) => {
      const scope = open(namespace)
      if (!scope.ok) return fromResult(scope, 200)
      const limit = integerParam(url.searchParams.get("limit"))
      const after = integerParam(url.searchParams.get("after"))
      if (limit === "bad") return adminError(400, "limit: expected an integer")
      if (after === "bad") return adminError(400, "after: expected a sequence number")
      const order = url.searchParams.get("order")
      return fromResult(
        readStatePage(scope.value, params.collection ?? "", {
          ...(limit !== undefined ? { limit } : {}),
          ...(after !== undefined ? { after } : {}),
          ...(order === "newest" || order === "oldest" ? { order } : {}),
        }),
        200,
      )
    },
    "GET /state/:collection/:id": ({ namespace, params }) => {
      const scope = open(namespace)
      if (!scope.ok) return fromResult(scope, 200)
      return fromResult(readStateRecord(scope.value, params.collection ?? "", params.id ?? ""), 200)
    },
    "POST /state/:collection": ({ namespace, params, body }) => {
      const scope = open(namespace)
      if (!scope.ok) return fromResult(scope, 201)
      if (!isRecord(body) || !("value" in body)) {
        return adminError(400, 'expected {"id?": "<id>", "value": <json>}')
      }
      const id = body.id
      if (id !== undefined && typeof id !== "string") return adminError(400, "id must be a string")
      const created = createStateRecord(scope.value, params.collection ?? "", {
        ...(typeof id === "string" ? { id } : {}),
        value: body.value,
      })
      if (created.ok) wrote(namespace)
      return fromResult(created, 201)
    },
    "PUT /state/:collection/:id": ({ namespace, params, body }) => {
      const scope = open(namespace)
      if (!scope.ok) return fromResult(scope, 200)
      if (!isRecord(body) || !("value" in body))
        return adminError(400, 'expected {"value": <json>}')
      const replaced = replaceStateRecord(
        scope.value,
        params.collection ?? "",
        params.id ?? "",
        body.value,
      )
      if (replaced.ok) wrote(namespace)
      return fromResult(replaced, 200)
    },
    "PATCH /state/:collection/:id": ({ namespace, params, body }) => {
      const scope = open(namespace)
      if (!scope.ok) return fromResult(scope, 200)
      if (!isRecord(body) || !("value" in body))
        return adminError(400, 'expected {"value": <json>}')
      const patched = patchStateRecord(
        scope.value,
        params.collection ?? "",
        params.id ?? "",
        body.value,
      )
      if (patched.ok) wrote(namespace)
      return fromResult(patched, 200)
    },
    "DELETE /state/:collection/:id": ({ namespace, params }) => {
      const scope = open(namespace)
      if (!scope.ok) return fromResult(scope, 200)
      const removed = deleteStateRecord(scope.value, params.collection ?? "", params.id ?? "")
      if (removed.ok) wrote(namespace)
      return fromResult(removed, 200)
    },
  }
}
