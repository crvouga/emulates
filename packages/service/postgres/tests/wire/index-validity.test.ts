import { expect, test } from "bun:test";
import pg from "pg";
import { Database, Snapshot } from "../../src/index.ts";
import { serve } from "../../src/wire/index.ts";

// regression: mockingbird-postgres-index-validity (#326)
test("wire failures retain invalid concurrent indexes across snapshot encoding", async () => {
  const database = new Database();
  const server = await serve({ database });
  const client = new pg.Client({ connectionString: server.connectionString });
  await client.connect();
  try {
    await client.query("CREATE TABLE t (id int)");
    await client.query("INSERT INTO t VALUES (1), (1)");
    await expect(client.query("CREATE UNIQUE INDEX CONCURRENTLY failed_idx ON t (id)")).rejects.toMatchObject({
      code: "23505",
    });
    await client.query("BEGIN");
    const result = await client.query(`SELECT c.relname AS name FROM pg_index i
      JOIN pg_class c ON c.oid = i.indexrelid WHERE NOT i.indisvalid`);
    expect(result.rows).toEqual([{ name: "failed_idx" }]);
    await client.query("COMMIT");
    const restored = Snapshot.decode(database.snapshot().encode()).open();
    try {
      expect(restored.query("SELECT indisvalid FROM pg_index")).toEqual([{ indisvalid: false }]);
    } finally {
      restored.close();
    }
    await client.query("DROP INDEX failed_idx");
    await client.query("CREATE INDEX CONCURRENTLY failed_idx ON t (id)");
    expect((await client.query("SELECT indisvalid FROM pg_index")).rows).toEqual([{ indisvalid: true }]);
    await client.query("BEGIN");
    await expect(client.query("CREATE INDEX CONCURRENTLY refused_idx ON t (id)")).rejects.toMatchObject({
      code: "25001",
    });
    await expect(client.query("SELECT 1")).rejects.toMatchObject({ code: "25P02" });
    await client.query("ROLLBACK");
  } finally {
    await client.end();
    await server.close();
    database.close();
  }
});
