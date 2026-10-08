/*! Adapted from vercel-labs/emulate (Apache-2.0), modified for Mockingbird. See port.json, LICENSE_EMULATE and THIRD_PARTY_NOTICES.md. */
import { Collection as Records, bootSqlite } from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"

export interface Entity {
  id: number
  created_at: string
  updated_at: string
}
export type InsertInput<T extends Entity> = Omit<T, "id" | "created_at" | "updated_at"> & { id?: number }
export type FilterFn<T> = (item: T) => boolean
export type SortFn<T> = (a: T, b: T) => number
export interface QueryOptions<T> {
  filter?: FilterFn<T>
  sort?: SortFn<T>
  page?: number
  per_page?: number
}
export interface PaginatedResult<T> {
  items: T[]
  total_count: number
  page: number
  per_page: number
  has_next: boolean
  has_prev: boolean
}

/** Provider entities live in the same namespace and history as every native service. */
export class Collection<T extends Entity> {
  readonly fieldNames: string[]
  private readonly records: Records<T>
  constructor(readonly store: Store, readonly name: string, fields: (keyof T)[] = []) {
    this.fieldNames = fields.map(String).sort()
    this.records = new Records(store.sqlite, store.namespace, name)
  }
  insert(data: InsertInput<T>): T {
    const key = `id:${this.name}`
    const next = this.store.meta.get(key) as number | undefined ?? 1
    const id = data.id != null && data.id > 0 ? data.id : next
    this.store.meta.insert(key, Math.max(next, id + 1))
    const item = { ...data, id, created_at: this.store.isoNow(), updated_at: this.store.isoNow() } as T
    this.records.insert(String(id), item)
    return item
  }
  get(id: number): T | undefined { return this.records.get(String(id)) }
  findBy(field: keyof T, value: T[keyof T] | string | number): T[] {
    return this.all().filter(item => this.fieldNames.includes(String(field)) ? String(item[field]) === String(value) : item[field] === value)
  }
  findOneBy(field: keyof T, value: T[keyof T] | string | number): T | undefined { return this.findBy(field, value)[0] }
  update(id: number, data: Partial<T>): T | undefined {
    const existing = this.get(id)
    if (!existing) return undefined
    const item = { ...existing, ...data, id, updated_at: this.store.isoNow() }
    this.records.update(String(id), item)
    return item
  }
  delete(id: number): boolean { return this.records.delete(String(id)) }
  all(): T[] { return this.records.list({ order: "oldest" }).map(row => row.value) }
  count(filter?: FilterFn<T>): number { return filter ? this.all().filter(filter).length : this.records.count() }
  clear(): void {
    for (const row of this.records.list()) this.records.delete(row.id)
    this.store.meta.delete(`id:${this.name}`)
  }
  query(options: QueryOptions<T> = {}): PaginatedResult<T> {
    let items = this.all()
    if (options.filter) items = items.filter(options.filter)
    if (options.sort) items.sort(options.sort)
    const total_count = items.length
    const page = options.page ?? 1
    const per_page = Math.min(options.per_page ?? 30, 100)
    const start = (page - 1) * per_page
    return { items: items.slice(start, start + per_page), total_count, page, per_page, has_next: start + per_page < total_count, has_prev: page > 1 }
  }
}

export function serializeValue(value: unknown): unknown {
  if (value instanceof Map) return { __type: "Map", entries: [...value].map(([k,v]) => [serializeValue(k), serializeValue(v)]) }
  if (value instanceof Set) return { __type: "Set", values: [...value].map(serializeValue) }
  if (value instanceof Uint8Array) return { __type: "Bytes", values: [...value] }
  if (Array.isArray(value)) return value.map(serializeValue)
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k,v]) => [k, serializeValue(v)]))
  return value
}
export function deserializeValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(deserializeValue)
  if (value !== null && typeof value === "object") {
    const tagged = value as Record<string, unknown>
    if (tagged.__type === "Map") return new Map((tagged.entries as [unknown,unknown][]).map(([k,v]) => [deserializeValue(k),deserializeValue(v)]))
    if (tagged.__type === "Set") return new Set((tagged.values as unknown[]).map(deserializeValue))
    if (tagged.__type === "Bytes") return new Uint8Array(tagged.values as number[])
    return Object.fromEntries(Object.entries(tagged).map(([k,v]) => [k, deserializeValue(v)]))
  }
  return value
}

export class Store {
  readonly meta: Records<unknown>
  private readonly collections = new Map<string, Collection<Entity>>()
  private readonly data = new Map<string, unknown>()
  constructor(readonly sqlite: SqliteClient = bootSqlite(), readonly namespace: string = "provider", readonly now: () => number = () => Date.now()) {
    this.meta = new Records(sqlite, namespace, "provider_metadata")
  }
  isoNow(): string { return new Date(this.now()).toISOString() }
  collection<T extends Entity>(name: string, fields: (keyof T)[] = []): Collection<T> {
    let collection = this.collections.get(name)
    if (collection && fields.length && fields.map(String).sort().join() !== collection.fieldNames.join()) throw new Error(`Conflicting indexes for ${name}`)
    if (!collection) {
      collection = new Collection(this, name, fields as (keyof Entity)[])
      this.collections.set(name, collection)
    }
    return collection as unknown as Collection<T>
  }
  getData<V>(key: string): V | undefined {
    if (!this.data.has(key)) {
      const value = this.meta.get(`data:${key}`)
      if (value !== undefined) this.data.set(key, deserializeValue(value))
    }
    return this.data.get(key) as V | undefined
  }
  setData<V>(key: string, value: V): void { this.data.set(key, value) }
  /** Drop request caches so checkout/reset and namespace selection always read SQLite. */
  begin(): void { this.data.clear() }
  flush(): void {
    for (const [key,value] of this.data) {
      const id = `data:${key}`
      const serialized = serializeValue(value)
      if (this.meta.has(id)) this.meta.update(id, serialized)
      else this.meta.insert(id, serialized)
    }
    this.data.clear()
  }
  reset(): void {
    for (const collection of this.collections.values()) collection.clear()
    for (const row of this.meta.list()) this.meta.delete(row.id)
    this.data.clear()
  }
}
