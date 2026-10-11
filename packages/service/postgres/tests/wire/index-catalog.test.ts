import { expect, test } from "bun:test";
import pg from "pg";
import { Database, Snapshot } from "../../src/index.ts";
import { type PostgresServer, serve } from "../../src/wire/index.ts";

// Index and catalog introspection over the wire protocol (#320, #326, #329, #330, #331).

const OID = { bool: 16, name: 19, int8: 20, int4: 23, text: 25, oid: 26, regnamespace: 4089 } as const;

async function withServer(
  run: (server: PostgresServer, database: Database, connect: () => Promise<pg.Client>) => Promise<void>,
) {
  const database = new Database();
  const server = await serve({ database });
  const clients: pg.Client[] = [];
  const connect = async () => {
    const client = new pg.Client({ connectionString: server.connectionString });
    await client.connect();
    clients.push(client);
    return client;
  };
  try {
    await run(server, database, connect);
  } finally {
    for (const client of clients) await client.end();
    await server.close();
    database.close();
  }
}

const invalid = `SELECT c.relname AS name, n.nspname AS schema FROM pg_index i
  JOIN pg_class c ON c.oid = i.indexrelid JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = $1 AND NOT i.indisvalid ORDER BY 1`;

test("#326: the catalog query does not poison a transaction; invalid SQL still does (25P02)", () =>
  withServer(async (_server, _database, connect) => {
    const client = await connect();
    await client.query("CREATE TABLE example (id integer)");
    await client.query("CREATE INDEX example_idx ON example (id)");
    await client.query("BEGIN");
    const flag = await client.query("SELECT i.indisvalid FROM pg_index i");
    expect(flag.rows).toEqual([{ indisvalid: true }]);
    expect(flag.fields[0]!.dataTypeID).toBe(OID.bool);
    expect((await client.query(invalid, ["public"])).rows).toEqual([]);
    // the transaction is still usable: the next statements run and commit
    await client.query("INSERT INTO example VALUES (1)");
    await client.query("COMMIT");
    expect((await client.query("SELECT count(*)::int AS n FROM example")).rows).toEqual([{ n: 1 }]);

    await client.query("BEGIN");
    await expect(client.query("SELECT i.no_such_column FROM pg_index i")).rejects.toMatchObject({ code: "42703" });
    await expect(client.query(invalid, ["public"])).rejects.toMatchObject({ code: "25P02" });
    await expect(client.query("INSERT INTO example VALUES (2)")).rejects.toMatchObject({ code: "25P02" });
    await client.query("ROLLBACK");
    expect((await client.query(invalid, ["public"])).rows).toEqual([]);
    expect((await client.query("SELECT count(*)::int AS n FROM example")).rows).toEqual([{ n: 1 }]);
  }));

test("#326: server.fault interrupts a concurrent build; the invalid index is visible to every connection and repairable", () =>
  withServer(async (server, _database, connect) => {
    const client = await connect();
    const other = await connect();
    await client.query("CREATE SCHEMA app");
    await client.query("CREATE TABLE app.example (id integer)");
    server.fault({ failConcurrentIndexBuild: "57014" });
    await expect(client.query("CREATE INDEX CONCURRENTLY interrupted_idx ON app.example (id)")).rejects.toMatchObject({
      code: "57014",
    });
    // the failed statement did not roll the catalog entry back, and the session is not in a failed transaction
    expect((await other.query(invalid, ["app"])).rows).toEqual([{ name: "interrupted_idx", schema: "app" }]);
    expect((await client.query(invalid, ["public"])).rows).toEqual([]);
    expect(server.faultState()).toEqual({});
    await other.query("REINDEX INDEX app.interrupted_idx");
    expect((await client.query(invalid, ["app"])).rows).toEqual([]);

    // a REINDEX CONCURRENTLY that is interrupted leaves its transient index
    server.fault({ failConcurrentIndexBuild: "40P01" });
    await expect(client.query("REINDEX INDEX CONCURRENTLY app.interrupted_idx")).rejects.toMatchObject({
      code: "40P01",
    });
    expect((await other.query(invalid, ["app"])).rows).toEqual([{ name: "interrupted_idx_ccnew", schema: "app" }]);
    await other.query("DROP INDEX CONCURRENTLY app.interrupted_idx_ccnew");
    expect((await client.query(invalid, ["app"])).rows).toEqual([]);
  }));

test("#326: index commands PostgreSQL refuses in a transaction block are 25001 over the wire", () =>
  withServer(async (_server, _database, connect) => {
    const client = await connect();
    await client.query("CREATE TABLE example (id integer)");
    await client.query("CREATE INDEX example_idx ON example (id)");
    for (const [sql, message] of [
      ["DROP INDEX CONCURRENTLY example_idx", "DROP INDEX CONCURRENTLY cannot run inside a transaction block"],
      ["REINDEX INDEX CONCURRENTLY example_idx", "REINDEX CONCURRENTLY cannot run inside a transaction block"],
      ["REINDEX SCHEMA public", "REINDEX SCHEMA cannot run inside a transaction block"],
    ] as const) {
      await client.query("BEGIN");
      await expect(client.query(sql)).rejects.toMatchObject({ code: "25001", message });
      await client.query("ROLLBACK");
    }
    // outside a transaction they all run
    await client.query("REINDEX SCHEMA public");
    await client.query("REINDEX INDEX CONCURRENTLY example_idx");
    await client.query("BEGIN");
    await client.query("REINDEX INDEX example_idx");
    await client.query("COMMIT");
    await client.query("DROP INDEX CONCURRENTLY example_idx");
    expect((await client.query("SELECT count(*)::int AS n FROM pg_index")).rows).toEqual([{ n: 0 }]);
  }));

test("#331: an index comment is isolated to its transaction until COMMIT, and gone after ROLLBACK", () =>
  withServer(async (_server, database, connect) => {
    const writer = await connect();
    const reader = await connect();
    const comments = `SELECT i.relname, d.description FROM pg_class i JOIN pg_index ix ON ix.indexrelid = i.oid
      LEFT JOIN pg_description d ON d.objoid = i.oid AND d.objsubid = 0 ORDER BY 1`;
    await writer.query("CREATE TABLE t (id integer)");
    await writer.query("CREATE INDEX autoidx_t_id ON t (id)");
    expect((await reader.query(comments)).rows).toEqual([{ relname: "autoidx_t_id", description: null }]);

    await writer.query("BEGIN");
    await writer.query("COMMENT ON INDEX autoidx_t_id IS 'managed index'");
    expect((await writer.query(comments)).rows).toEqual([{ relname: "autoidx_t_id", description: "managed index" }]);
    expect((await reader.query(comments)).rows).toEqual([{ relname: "autoidx_t_id", description: null }]);
    await writer.query("COMMIT");
    expect((await reader.query(comments)).rows).toEqual([{ relname: "autoidx_t_id", description: "managed index" }]);

    await writer.query("BEGIN");
    await writer.query("COMMENT ON INDEX autoidx_t_id IS 'replaced'");
    await writer.query("ROLLBACK");
    expect((await reader.query(comments)).rows).toEqual([{ relname: "autoidx_t_id", description: "managed index" }]);

    await expect(reader.query("COMMENT ON INDEX missing_idx IS 'x'")).rejects.toMatchObject({ code: "42P01" });
    // the committed comment is in the engine the server fronts, and in its snapshots
    const restored = Snapshot.decode(database.snapshot().encode()).open();
    try {
      expect(restored.query("SELECT description FROM pg_description")).toEqual([{ description: "managed index" }]);
    } finally {
      restored.close();
    }
    await writer.query("DROP INDEX autoidx_t_id");
    expect((await reader.query("SELECT count(*)::int AS n FROM pg_description")).rows).toEqual([{ n: 0 }]);
  }));

test("#320: the statistics join has the same shape, types and values over the wire as through the sync API", () =>
  withServer(async (_server, database, connect) => {
    const client = await connect();
    await client.query("CREATE SCHEMA app");
    await client.query("CREATE TABLE example (id integer PRIMARY KEY)");
    await client.query("CREATE TABLE app.other (id integer)");
    await client.query("INSERT INTO example VALUES (1), (2), (3)");
    await client.query("ANALYZE example");
    const joined = `SELECT c.relname, COALESCE(s.n_live_tup, 0)::bigint AS n_live_tup
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid
      WHERE n.nspname = current_schema() AND c.relkind = 'r' ORDER BY c.relname`;
    const wire = await client.query(joined);
    const sync = database.prepare(joined).result();
    expect(wire.fields.map((field) => field.name)).toEqual(sync.columns);
    expect(sync.columnTypes).toEqual(["name", "int8"]);
    expect(wire.fields.map((field) => field.dataTypeID)).toEqual([OID.name, OID.int8]);
    // pg returns int8 as a string; the sync API as a bigint
    expect(wire.rows).toEqual([{ relname: "example", n_live_tup: "3" }]);
    expect(sync.rows).toEqual([{ relname: "example", n_live_tup: 3n }]);

    const bare =
      "SELECT relid, schemaname, relname, n_live_tup, analyze_count, idx_scan FROM pg_stat_user_tables ORDER BY 2, 3";
    const bareWire = await client.query(bare);
    const bareSync = database.prepare(bare).result();
    expect(bareSync.columnTypes).toEqual(["oid", "name", "name", "int8", "int8", "int8"]);
    expect(bareWire.fields.map((field) => field.dataTypeID)).toEqual([
      OID.oid,
      OID.name,
      OID.name,
      OID.int8,
      OID.int8,
      OID.int8,
    ]);
    expect(
      bareWire.rows.map((row) => [row.schemaname, row.relname, row.n_live_tup, row.analyze_count, row.idx_scan]),
    ).toEqual([
      ["app", "other", "0", "0", null],
      ["public", "example", "3", "1", "0"],
    ]);
    expect(bareWire.rows.map((row) => Number(row.relid))).toEqual(bareSync.rows.map((row) => row.relid as number));

    // another connection sees the same statistics, and a schema-scoped session sees its own schema
    const scoped = await connect();
    await scoped.query("SET search_path = app");
    expect((await scoped.query(joined)).rows).toEqual([{ relname: "other", n_live_tup: "0" }]);
    await expect(scoped.query("ANALYZE missing_table")).rejects.toMatchObject({ code: "42P01" });
  }));

test("#329: regnamespace over the wire: type oid, text output, the catalog predicate and a bound parameter", () =>
  withServer(async (_server, _database, connect) => {
    const client = await connect();
    await client.query('CREATE SCHEMA "Mixed Case"');
    await client.query("CREATE TABLE kv (id integer)");
    const cast = await client.query(
      `SELECT 'public'::regnamespace AS ns, '"Mixed Case"'::regnamespace AS mixed, 999::regnamespace AS unknown`,
    );
    expect(cast.fields.map((field) => field.dataTypeID)).toEqual([
      OID.regnamespace,
      OID.regnamespace,
      OID.regnamespace,
    ]);
    expect(cast.rows).toEqual([{ ns: "public", mixed: '"Mixed Case"', unknown: "999" }]);
    const predicate = await client.query(
      "SELECT relpersistence FROM pg_class WHERE relname = 'kv' AND relnamespace = current_schema()::regnamespace",
    );
    expect(predicate.rows).toEqual([{ relpersistence: "p" }]);
    const bound = await client.query(
      "SELECT relname FROM pg_class WHERE relname = 'kv' AND relnamespace = $1::regnamespace",
      ["public"],
    );
    expect(bound.rows).toEqual([{ relname: "kv" }]);
    await expect(client.query("SELECT $1::regnamespace", ["missing_schema"])).rejects.toMatchObject({ code: "3F000" });
    await expect(client.query("SELECT $1::regnamespace", ["a.b"])).rejects.toMatchObject({ code: "42602" });
    await expect(client.query("SELECT $1::regnamespace", ["4294967296"])).rejects.toMatchObject({ code: "22003" });
  }));

test("#330: index oids and definitions are the same over the wire as through the sync API", () =>
  withServer(async (_server, database, connect) => {
    const client = await connect();
    await client.query("CREATE TABLE t (id integer PRIMARY KEY, value text)");
    await client.query("CREATE INDEX t_value_idx ON t (lower(value)) WHERE value IS NOT NULL");
    const defs = `SELECT i.oid, i.relname, pg_get_indexdef(i.oid) AS indexdef, pg_get_indexdef(i.oid, 1, true) AS first
      FROM pg_index ix JOIN pg_class i ON i.oid = ix.indexrelid ORDER BY i.relname`;
    const wire = await client.query(defs);
    const sync = database.prepare(defs).result();
    expect(wire.fields.map((field) => field.dataTypeID)).toEqual([OID.oid, OID.name, OID.text, OID.text]);
    expect(wire.rows.map((row) => ({ ...row, oid: Number(row.oid) }))).toEqual(sync.rows);
    expect(wire.rows.map((row) => row.indexdef)).toEqual([
      "CREATE UNIQUE INDEX t_pkey ON public.t USING btree (id)",
      "CREATE INDEX t_value_idx ON public.t USING btree (lower(value)) WHERE (value IS NOT NULL)",
    ]);
    const byOid = await client.query("SELECT pg_get_indexdef($1::oid) AS indexdef", [wire.rows[1]!.oid]);
    expect(byOid.rows).toEqual([{ indexdef: wire.rows[1]!.indexdef }]);
    // DDL in a rolled-back wire transaction leaves the oids alone
    await client.query("BEGIN");
    await client.query("ALTER INDEX t_value_idx RENAME TO renamed_idx");
    await client.query("ROLLBACK");
    expect((await client.query(defs)).rows).toEqual(wire.rows);
  }));
