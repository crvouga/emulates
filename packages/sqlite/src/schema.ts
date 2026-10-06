import type { SqliteClient } from "./client.js"
import { type Migration, migrate } from "./migrate.js"

/**
 * Core Emulators service schema: namespaced JSON records and counters.
 *
 * Applied on every service boot via {@link migrateCore}.
 */
export const CORE_MIGRATIONS: readonly Migration[] = [
  {
    id: "20260322_core_records_sequences",
    sql: `
      CREATE TABLE IF NOT EXISTS emulators_records (
        namespace TEXT NOT NULL,
        collection TEXT NOT NULL,
        id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        value TEXT NOT NULL,
        PRIMARY KEY (namespace, collection, id)
      );
      CREATE INDEX IF NOT EXISTS emulators_records_seq
        ON emulators_records (namespace, collection, seq);
      CREATE TABLE IF NOT EXISTS emulators_sequences (
        namespace TEXT NOT NULL,
        name TEXT NOT NULL,
        kind TEXT NOT NULL,
        value INTEGER NOT NULL,
        PRIMARY KEY (namespace, name, kind)
      );
    `,
  },
]

/** Apply {@link CORE_MIGRATIONS} (idempotent). */
export const migrateCore = (sqlite: SqliteClient): void => {
  migrate(sqlite, CORE_MIGRATIONS)
}

/** Delete every record and sequence belonging to `namespace`. */
export const clearNamespace = (sqlite: SqliteClient, namespace: string): void => {
  sqlite.transaction(() => {
    sqlite.prepare("DELETE FROM emulators_records WHERE namespace = ?").run(namespace)
    sqlite.prepare("DELETE FROM emulators_sequences WHERE namespace = ?").run(namespace)
  })
}
