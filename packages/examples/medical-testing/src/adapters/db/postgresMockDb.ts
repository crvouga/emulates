import { type BindValue, Database } from "@crvouga/mockingbird-service-postgres"
import { createAdmin } from "@crvouga/mockingbird-service-postgres/admin"
import type { Db } from "../../app/ports/db.js"
import type { MockAdmin } from "../admin.js"

/**
 * The `Db` port, backed by Mockingbird's in-process, in-memory
 * Postgres-dialect engine. `Database.query` is synchronous — this wraps it
 * so the port's contract (real promises, like any Node pg client) holds
 * regardless of what's actually running underneath.
 */
export const createPostgresMockDb = (): { client: Db; admin: MockAdmin } => {
  const database = new Database({ now: "system" })
  const admin = createAdmin({ database })
  return {
    client: {
      query: async <T>(sql: string, params: readonly unknown[] = []) =>
        database.query<T>(sql, params as BindValue[]),
    },
    admin: { id: "postgres", label: "Postgres", fetch: (request) => admin.fetch(request) },
  }
}
