import type { SqliteClient } from "@emulators/sqlite-client"

/** Every stored record carries a monotonically increasing sequence for stable ordering. */
export type Stored<T> = { seq: number; value: T }

export type ListRecordsOptions<T> = {
  /** Keep only records passing the predicate. */
  where?: (value: T, seq: number) => boolean
  /** Sort order; default newest first. */
  order?: "newest" | "oldest"
}

type RecordRow = { id: string; seq: number; value: string }

/**
 * A SQLite-backed table of JSON records addressed by id. Ordering is by insertion
 * sequence, never by id lexicographic order, so list semantics stay stable.
 */
export class Collection<T> {
  constructor(
    private readonly sqlite: SqliteClient,
    /** Storage namespace. Admin introspection uses this to ignore another namespace's tables. */
    readonly namespace: string,
    /** Table name inside the namespace. Stable across resets of the rows themselves. */
    readonly collectionName: string,
  ) {}

  private bumpCollectionSeq(): number {
    const row = this.sqlite
      .prepare(
        "SELECT value FROM emulators_sequences WHERE namespace = ? AND name = ? AND kind = 'collection'",
      )
      .get<{ value: number }>(this.namespace, this.collectionName)
    const next = (row?.value ?? 0) + 1
    this.sqlite
      .prepare(
        `INSERT INTO emulators_sequences (namespace, name, kind, value) VALUES (?, ?, 'collection', ?)
         ON CONFLICT(namespace, name, kind) DO UPDATE SET value = excluded.value`,
      )
      .run(this.namespace, this.collectionName, next)
    return next
  }

  nextSequence(): number {
    return this.sqlite.transaction(() => this.bumpCollectionSeq())
  }

  get(id: string): T | undefined {
    const row = this.sqlite
      .prepare(
        "SELECT value FROM emulators_records WHERE namespace = ? AND collection = ? AND id = ?",
      )
      .get<{ value: string }>(this.namespace, this.collectionName, id)
    if (!row) return undefined
    return (JSON.parse(row.value) as Stored<T>).value
  }

  has(id: string): boolean {
    const row = this.sqlite
      .prepare(
        "SELECT 1 AS ok FROM emulators_records WHERE namespace = ? AND collection = ? AND id = ?",
      )
      .get<{ ok: number }>(this.namespace, this.collectionName, id)
    return row !== undefined
  }

  /** Insert a new record, assigning it the next sequence number. */
  insert(id: string, value: T): Stored<T> {
    return this.sqlite.transaction(() => {
      const seq = this.bumpCollectionSeq()
      const stored = { seq, value }
      this.sqlite
        .prepare(
          `INSERT INTO emulators_records (namespace, collection, id, seq, value)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(namespace, collection, id) DO UPDATE SET seq = excluded.seq, value = excluded.value`,
        )
        .run(this.namespace, this.collectionName, id, seq, JSON.stringify(stored))
      return stored
    })
  }

  /** Replace an existing record's value, keeping its position. */
  update(id: string, value: T): Stored<T> | undefined {
    return this.sqlite.transaction(() => {
      const row = this.sqlite
        .prepare(
          "SELECT seq, value FROM emulators_records WHERE namespace = ? AND collection = ? AND id = ?",
        )
        .get<{ seq: number; value: string }>(this.namespace, this.collectionName, id)
      if (!row) return undefined
      const stored = { seq: row.seq, value }
      this.sqlite
        .prepare(
          "UPDATE emulators_records SET value = ? WHERE namespace = ? AND collection = ? AND id = ?",
        )
        .run(JSON.stringify(stored), this.namespace, this.collectionName, id)
      return stored
    })
  }

  delete(id: string): boolean {
    const result = this.sqlite
      .prepare("DELETE FROM emulators_records WHERE namespace = ? AND collection = ? AND id = ?")
      .run(this.namespace, this.collectionName, id)
    return result.changes > 0
  }

  /** How many records the collection holds, without reading them. */
  count(): number {
    const row = this.sqlite
      .prepare("SELECT COUNT(*) AS n FROM emulators_records WHERE namespace = ? AND collection = ?")
      .get<{ n: number }>(this.namespace, this.collectionName)
    return Number(row?.n ?? 0)
  }

  list(options: ListRecordsOptions<T> = {}): Array<Stored<T> & { id: string }> {
    const rows = this.sqlite
      .prepare(
        "SELECT id, seq, value FROM emulators_records WHERE namespace = ? AND collection = ?",
      )
      .all<RecordRow>(this.namespace, this.collectionName)
    const out: Array<Stored<T> & { id: string }> = []
    for (const row of rows) {
      const stored = JSON.parse(row.value) as Stored<T>
      if (options.where && !options.where(stored.value, stored.seq)) continue
      out.push({ id: row.id, seq: stored.seq, value: stored.value })
    }
    out.sort((a, b) => (options.order === "oldest" ? a.seq - b.seq : b.seq - a.seq))
    return out
  }
}
