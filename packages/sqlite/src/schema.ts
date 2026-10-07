import type { SqliteClient } from "./client.js"
import { type Migration, migrate } from "./migrate.js"

/**
 * Core Mockingbird service schema: namespaced JSON records and counters.
 *
 * Applied on every service boot via {@link migrateCore}.
 */
export const CORE_MIGRATIONS: readonly Migration[] = [
  {
    id: "20260322_core_records_sequences",
    sql: `
      CREATE TABLE IF NOT EXISTS mockingbird_records (
        namespace TEXT NOT NULL,
        collection TEXT NOT NULL,
        id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        value TEXT NOT NULL,
        PRIMARY KEY (namespace, collection, id)
      );
      CREATE INDEX IF NOT EXISTS mockingbird_records_seq
        ON mockingbird_records (namespace, collection, seq);
      CREATE TABLE IF NOT EXISTS mockingbird_sequences (
        namespace TEXT NOT NULL,
        name TEXT NOT NULL,
        kind TEXT NOT NULL,
        value INTEGER NOT NULL,
        PRIMARY KEY (namespace, name, kind)
      );
    `,
  },
]

/**
 * Table and index names from the unfinished Emulates rename.
 * Renamed in place so a database created under those names keeps its rows.
 */
const LEGACY_TABLES = [
  ["emulates_records", "mockingbird_records"],
  ["emulators_records", "mockingbird_records"],
  ["emulates_sequences", "mockingbird_sequences"],
  ["emulators_sequences", "mockingbird_sequences"],
] as const
const LEGACY_INDEXES = [
  ["emulates_records_seq", "mockingbird_records_seq"],
  ["emulators_records_seq", "mockingbird_records_seq"],
] as const

const namesOf = (sqlite: SqliteClient, type: "table" | "index"): Set<string> =>
  new Set(
    sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type = ?")
      .all<{ name: string }>(type)
      .map((row) => row.name),
  )

/** Apply {@link CORE_MIGRATIONS}, then rename a database that still uses the former table names. */
export const migrateCore = (sqlite: SqliteClient): void => {
  migrate(sqlite, CORE_MIGRATIONS)
  const tables = namesOf(sqlite, "table")
  const indexes = namesOf(sqlite, "index")
  sqlite.transaction(() => {
    for (const [from, to] of LEGACY_TABLES) {
      if (!tables.has(from) || tables.has(to)) continue
      sqlite.exec(`ALTER TABLE ${from} RENAME TO ${to}`)
      tables.delete(from)
      tables.add(to)
    }
    for (const [from, to] of LEGACY_INDEXES) {
      if (!indexes.has(from) || indexes.has(to)) continue
      // The sqlite port accepts ALTER TABLE, not ALTER INDEX.
      sqlite.exec(`DROP INDEX ${from}`)
      sqlite.exec(`CREATE INDEX ${to} ON mockingbird_records (namespace, collection, seq)`)
      indexes.delete(from)
      indexes.add(to)
    }
  })
}

/** Delete every record and sequence belonging to `namespace`. */
export const clearNamespace = (sqlite: SqliteClient, namespace: string): void => {
  sqlite.transaction(() => {
    sqlite.prepare("DELETE FROM mockingbird_records WHERE namespace = ?").run(namespace)
    sqlite.prepare("DELETE FROM mockingbird_sequences WHERE namespace = ?").run(namespace)
  })
}
