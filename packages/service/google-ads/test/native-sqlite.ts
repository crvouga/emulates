import { Database } from "bun:sqlite"
import type { SqliteClient, SqliteValue } from "@emulates/sqlite-client"
/** Real SQLite keeps the 21000-record paging fixture practical; other tests use the portable engine. */
export function nativeSqlite(): SqliteClient & { close(): void } {
  const db = new Database(":memory:")
  return {
    exec: (sql) => {
      db.exec(sql)
    },
    transaction: (fn) => db.transaction(fn)(),
    close: () => db.close(),
    prepare: (sql) => {
      const statement = db.prepare(sql)
      return {
        run: (...params) =>
          statement.run(...params.map((p) => (typeof p === "boolean" ? Number(p) : p))),
        all: <T>(...params: SqliteValue[]) =>
          statement.all(...params.map((p) => (typeof p === "boolean" ? Number(p) : p))) as T[],
        get: <T>(...params: SqliteValue[]) =>
          (statement.get(...params.map((p) => (typeof p === "boolean" ? Number(p) : p))) ??
            undefined) as T | undefined,
      }
    },
  }
}
