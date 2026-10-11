import { afterAll, beforeAll, expect, test } from "bun:test";
import pg from "pg";
import { type PostgresServer, serve } from "../../src/wire/index.ts";

// The ALTER TABLE and catalog forms of issues #318, #319, #332, #333 and #334 were reported
// through a `pg` client. SQL behavior is proven against the oracle in tests/contract; this
// pins that the same statements, results and SQLSTATEs travel over the wire protocol.

let server: PostgresServer;
let client: pg.Client;

beforeAll(async () => {
  server = await serve({ port: 0 });
  client = new pg.Client({ connectionString: server.connectionString });
  await client.connect();
});

afterAll(async () => {
  await client.end();
  await server.close();
});

async function sqlstate(sql: string): Promise<string | undefined> {
  try {
    await client.query(sql);
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

test("SET NOT NULL and SET DEFAULT over the wire", async () => {
  await client.query("CREATE TABLE example (id int, body text, created_at timestamptz)");
  await client.query("INSERT INTO example (id) VALUES (1)");
  expect(await sqlstate("ALTER TABLE example ALTER COLUMN body SET NOT NULL")).toBe("23502");
  await client.query("UPDATE example SET body = 'x'");
  await client.query("ALTER TABLE example ALTER COLUMN body SET NOT NULL");
  await client.query("ALTER TABLE example ALTER COLUMN created_at SET DEFAULT now()");
  expect(await sqlstate("INSERT INTO example (id, body) VALUES (2, NULL)")).toBe("23502");
  const columns = await client.query(
    "SELECT column_name, is_nullable, column_default FROM information_schema.columns WHERE table_name = 'example' ORDER BY ordinal_position",
  );
  expect(columns.rows).toEqual([
    { column_name: "id", is_nullable: "YES", column_default: null },
    { column_name: "body", is_nullable: "NO", column_default: null },
    { column_name: "created_at", is_nullable: "YES", column_default: "now()" },
  ]);
});

test("a failed ALTER TABLE inside a transaction is undone by ROLLBACK", async () => {
  await client.query("CREATE TABLE rolled (id int, body text)");
  await client.query("INSERT INTO rolled VALUES (1, NULL)");
  await client.query("BEGIN");
  await client.query("ALTER TABLE rolled ALTER COLUMN id SET NOT NULL");
  expect(await sqlstate("ALTER TABLE rolled ALTER COLUMN body SET NOT NULL")).toBe("23502");
  expect(await sqlstate("SELECT 1")).toBe("25P02");
  await client.query("ROLLBACK");
  const columns = await client.query(
    "SELECT is_nullable FROM information_schema.columns WHERE table_name = 'rolled' ORDER BY ordinal_position",
  );
  expect(columns.rows).toEqual([{ is_nullable: "YES" }, { is_nullable: "YES" }]);
});

test("SET STORAGE and SET UNLOGGED over the wire", async () => {
  await client.query("CREATE TABLE kv (id integer, value text)");
  await client.query("ALTER TABLE kv ALTER COLUMN value SET STORAGE MAIN");
  expect(await sqlstate("ALTER TABLE kv ALTER COLUMN id SET STORAGE MAIN")).toBe("0A000");
  expect(await sqlstate("ALTER TABLE kv ALTER COLUMN value SET STORAGE bogus")).toBe("22023");
  expect(await sqlstate("ALTER TABLE kv ALTER COLUMN missing SET STORAGE MAIN")).toBe("42703");
  await client.query("ALTER TABLE kv SET UNLOGGED");
  const catalog = await client.query(
    "SELECT c.relpersistence, a.attname, a.attstorage FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid WHERE c.relname = 'kv' ORDER BY a.attnum",
  );
  expect(catalog.rows).toEqual([
    { relpersistence: "u", attname: "id", attstorage: "p" },
    { relpersistence: "u", attname: "value", attstorage: "m" },
  ]);
});

test("extension catalogs over the wire", async () => {
  const unavailable = await client.query("SELECT default_version FROM pg_available_extensions WHERE name = 'hypopg'");
  expect(unavailable.rows).toEqual([]);
  expect(await sqlstate("CREATE EXTENSION hypopg")).toBe("0A000");
  await client.query("CREATE EXTENSION IF NOT EXISTS pg_trgm");
  const installed = await client.query("SELECT extname, extversion FROM pg_extension ORDER BY extname");
  expect(installed.rows).toEqual([
    { extname: "pg_trgm", extversion: "1.6" },
    { extname: "plpgsql", extversion: "1.0" },
  ]);
  await client.query("DROP EXTENSION pg_trgm");
  expect(await sqlstate("DROP EXTENSION pg_trgm")).toBe("42704");
});
