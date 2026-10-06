import { Database } from "@emulates/sqlite"
import type { SqliteClient } from "./client.js"

/** Construct the default in-memory SQLite client (`@emulates/sqlite`). */
export const createDefaultSqlite = (): SqliteClient => new Database()

/** Use the injected client, or fall back to {@link createDefaultSqlite}. */
export const resolveSqlite = (sqlite?: SqliteClient): SqliteClient =>
  sqlite ?? createDefaultSqlite()
