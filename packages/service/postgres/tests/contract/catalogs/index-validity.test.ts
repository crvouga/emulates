import { expect, test } from "bun:test";
import { Database, PostgresError, Snapshot } from "../../../src/index.ts";
import { errorParity, parity, parityTyped, sequenceParity } from "../helpers.ts";

// pg_index.indisvalid and the state a failed concurrent index build leaves behind (#326).
// Oracle: PGlite (PostgreSQL 18.3) for everything it can express. A build that is interrupted
// rather than failing on its data cannot be provoked in PGlite, so that part pins the documented
// behavior: https://www.postgresql.org/docs/18/sql-createindex.html#SQL-CREATEINDEX-CONCURRENTLY
// and https://www.postgresql.org/docs/18/catalog-pg-index.html

const A = { messageTier: "A" } as const;

/** The reported query: invalid indexes of a schema, by name. */
const invalidIn = (schema: string): string => `SELECT c.relname AS name FROM pg_index i
  JOIN pg_class c ON c.oid = i.indexrelid JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = '${schema}' AND NOT i.indisvalid ORDER BY c.relname`;
const invalid = invalidIn("public");
/** Every user index with its three build-state flags. */
const flags = `SELECT n.nspname, c.relname, i.indisvalid, i.indisready, i.indislive FROM pg_index i
  JOIN pg_class c ON c.oid = i.indexrelid JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema' ORDER BY 1, 2`;
const duplicated = ["CREATE TABLE t (id integer, v integer)", "INSERT INTO t VALUES (1, 1), (2, 1)"];

// --- 1. every completed index is valid; the filter returns no rows ---

parity("the invalid-index filter is empty, not an error, on a fresh database", [], invalid);

parity("the bare column reads on a fresh database", [], "SELECT i.indisvalid FROM pg_index i WHERE false");

parityTyped(
  "every kind of completed index is valid, ready and live",
  [
    "CREATE TABLE t (id integer PRIMARY KEY, email text UNIQUE, v integer, w text)",
    "CREATE INDEX t_v_idx ON t (v)",
    "CREATE UNIQUE INDEX t_w_idx ON t (w)",
    "CREATE INDEX CONCURRENTLY t_v_concurrent ON t (v)",
    "CREATE UNIQUE INDEX CONCURRENTLY t_w_concurrent ON t (lower(w))",
    "CREATE INDEX t_partial ON t (v) WHERE v > 0",
    "CREATE INDEX t_hash ON t USING hash (w)",
  ],
  flags,
);

parity(
  "the filter stays empty with only completed indexes",
  ["CREATE TABLE t (id integer PRIMARY KEY, v integer)", "CREATE INDEX CONCURRENTLY t_v_idx ON t (v)"],
  invalid,
);

sequenceParity(
  "CREATE INDEX CONCURRENTLY IF NOT EXISTS is quiet about an index that exists",
  ["CREATE TABLE t (id integer)"],
  [
    { sql: "CREATE INDEX CONCURRENTLY IF NOT EXISTS t_id_idx ON t (id)" },
    { sql: "CREATE INDEX CONCURRENTLY IF NOT EXISTS t_id_idx ON t (id)" },
    { sql: "CREATE INDEX CONCURRENTLY t_id_idx ON t (id)" },
    { sql: flags, query: true },
  ],
);

// --- 2. a failed concurrent build leaves a visible invalid index ---

sequenceParity("a concurrent unique build that hits duplicates fails and leaves the index, invalid", duplicated, [
  { sql: "CREATE UNIQUE INDEX CONCURRENTLY failed_idx ON t (v)" },
  { sql: invalid, query: true },
  { sql: flags, query: true },
  // the invalid index is a real catalog entry: it has a definition, and its name is taken
  { sql: "SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' ORDER BY 1", query: true },
  {
    sql: "SELECT c.relkind, i.indisunique FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid WHERE c.relname = 'failed_idx'",
    query: true,
  },
  { sql: "CREATE UNIQUE INDEX CONCURRENTLY failed_idx ON t (v)" },
  { sql: "CREATE INDEX failed_idx ON t (id)" },
]);

sequenceParity("the same build without CONCURRENTLY fails and leaves nothing", duplicated, [
  { sql: "CREATE UNIQUE INDEX failed_idx ON t (v)" },
  { sql: flags, query: true },
]);

sequenceParity("an invalid unique index does not enforce uniqueness; valid ones still do", duplicated, [
  { sql: "CREATE UNIQUE INDEX t_id_idx ON t (id)" },
  { sql: "CREATE UNIQUE INDEX CONCURRENTLY failed_idx ON t (v)" },
  { sql: "INSERT INTO t VALUES (3, 1)" },
  { sql: "INSERT INTO t VALUES (3, 2)" },
  { sql: "SELECT id, v FROM t ORDER BY id", query: true },
]);

sequenceParity(
  "the join reports the schema of an invalid index, and schemas do not leak into each other",
  [],
  [
    { sql: "CREATE SCHEMA app" },
    { sql: "CREATE TABLE t (v integer)" },
    { sql: "CREATE TABLE app.t (v integer)" },
    { sql: "INSERT INTO app.t VALUES (1), (1)" },
    { sql: "CREATE UNIQUE INDEX CONCURRENTLY same_name ON t (v)" },
    { sql: "CREATE UNIQUE INDEX CONCURRENTLY same_name ON app.t (v)" },
    { sql: invalid, query: true },
    { sql: invalidIn("app"), query: true },
    { sql: flags, query: true },
    {
      sql: `SELECT n.nspname, t.relname AS tablename, c.relname AS indexname FROM pg_index i
      JOIN pg_class c ON c.oid = i.indexrelid JOIN pg_class t ON t.oid = i.indrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace AND n.oid = t.relnamespace WHERE NOT i.indisvalid`,
      query: true,
    },
  ],
);

// --- 3. dropping or repairing the index updates the catalog ---

sequenceParity("DROP INDEX removes an invalid index and the name can be built again", duplicated, [
  { sql: "CREATE UNIQUE INDEX CONCURRENTLY failed_idx ON t (v)" },
  { sql: "DROP INDEX failed_idx" },
  { sql: invalid, query: true },
  { sql: "DELETE FROM t WHERE id = 2" },
  { sql: "CREATE UNIQUE INDEX CONCURRENTLY failed_idx ON t (v)" },
  { sql: flags, query: true },
  { sql: "INSERT INTO t VALUES (3, 1)" },
]);

sequenceParity("DROP INDEX CONCURRENTLY removes an invalid index too", duplicated, [
  { sql: "CREATE UNIQUE INDEX CONCURRENTLY failed_idx ON t (v)" },
  { sql: "DROP INDEX CONCURRENTLY failed_idx" },
  { sql: flags, query: true },
  { sql: "DROP INDEX CONCURRENTLY IF EXISTS failed_idx" },
]);

sequenceParity("REINDEX INDEX fails while the duplicates remain and repairs the index once they are gone", duplicated, [
  { sql: "CREATE UNIQUE INDEX CONCURRENTLY failed_idx ON t (v)" },
  { sql: "REINDEX INDEX failed_idx" },
  { sql: invalid, query: true },
  { sql: "DELETE FROM t WHERE id = 2" },
  { sql: "REINDEX INDEX failed_idx" },
  { sql: invalid, query: true },
  { sql: flags, query: true },
  // repaired means enforced
  { sql: "INSERT INTO t VALUES (3, 1)" },
]);

sequenceParity("REINDEX TABLE and REINDEX SCHEMA rebuild invalid indexes as well", duplicated, [
  { sql: "CREATE UNIQUE INDEX CONCURRENTLY failed_idx ON t (v)" },
  { sql: "REINDEX TABLE t" },
  { sql: "REINDEX SCHEMA public" },
  { sql: invalid, query: true },
  { sql: "DELETE FROM t WHERE id = 2" },
  { sql: "REINDEX TABLE t" },
  { sql: invalid, query: true },
  { sql: "INSERT INTO t VALUES (2, 1)" },
  { sql: "REINDEX (VERBOSE) SCHEMA public" },
  { sql: "REINDEX DATABASE" },
  { sql: "REINDEX SYSTEM" },
  { sql: flags, query: true },
]);

sequenceParity("a failed REINDEX INDEX CONCURRENTLY leaves its transient _ccnew index behind, invalid", duplicated, [
  { sql: "CREATE UNIQUE INDEX CONCURRENTLY failed_idx ON t (v)" },
  { sql: "REINDEX INDEX CONCURRENTLY failed_idx" },
  { sql: invalid, query: true },
  { sql: "SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' ORDER BY 1", query: true },
  { sql: "REINDEX INDEX CONCURRENTLY failed_idx" },
  { sql: invalid, query: true },
  { sql: "DROP INDEX failed_idx_ccnew, failed_idx_ccnew1" },
  { sql: "DELETE FROM t WHERE id = 2" },
  { sql: "REINDEX INDEX CONCURRENTLY failed_idx" },
  { sql: flags, query: true },
  { sql: "INSERT INTO t VALUES (3, 1)" },
]);

sequenceParity("REINDEX TABLE CONCURRENTLY skips an invalid index instead of rebuilding it", duplicated, [
  { sql: "CREATE INDEX t_id_idx ON t (id)" },
  { sql: "CREATE UNIQUE INDEX CONCURRENTLY failed_idx ON t (v)" },
  { sql: "REINDEX TABLE CONCURRENTLY t" },
  { sql: "REINDEX (CONCURRENTLY) TABLE t" },
  { sql: flags, query: true },
]);

sequenceParity(
  "REINDEX keeps a valid index valid, and its catalog rows consistent",
  ["CREATE TABLE t (id integer PRIMARY KEY, v integer)", "CREATE INDEX t_v_idx ON t (v)"],
  [
    { sql: "REINDEX INDEX t_v_idx" },
    { sql: "REINDEX INDEX t_pkey" },
    { sql: "REINDEX INDEX CONCURRENTLY t_pkey" },
    { sql: "REINDEX TABLE t" },
    { sql: flags, query: true },
    {
      sql: `SELECT co.conname, ci.relname AS index FROM pg_constraint co JOIN pg_class ci ON ci.oid = co.conindid
      WHERE co.contype = 'p' AND co.conrelid = (SELECT oid FROM pg_class WHERE relname = 't')`,
      query: true,
    },
    { sql: "INSERT INTO t VALUES (1, 1)" },
    { sql: "INSERT INTO t VALUES (1, 2)" },
  ],
);

errorParity("REINDEX INDEX of a missing index is 42P01", [], "REINDEX INDEX missing_idx", "undefined_table", A);
errorParity("REINDEX INDEX of a table is 42809", ["CREATE TABLE t (id integer)"], "REINDEX INDEX t", undefined, A);
errorParity("REINDEX TABLE of a missing table is 42P01", [], "REINDEX TABLE missing_table", "undefined_table", A);
errorParity(
  "REINDEX TABLE of an index is 42809",
  ["CREATE TABLE t (id integer)", "CREATE INDEX t_id_idx ON t (id)"],
  "REINDEX TABLE t_id_idx",
  undefined,
  A,
);
errorParity("REINDEX SCHEMA of a missing schema is 3F000", [], "REINDEX SCHEMA missing_schema", undefined, A);
errorParity(
  "REINDEX DATABASE of another database is refused",
  [],
  "REINDEX DATABASE some_other_database",
  undefined,
  A,
);
errorParity(
  "an unknown REINDEX option is a syntax error",
  ["CREATE TABLE t (id integer)"],
  "REINDEX (BOGUS) TABLE t",
  "syntax",
  A,
);
errorParity("DROP INDEX of a missing index is 42704", [], "DROP INDEX missing_idx", "undefined_object", A);
errorParity("DROP INDEX of a table is 42809", ["CREATE TABLE t (id integer)"], "DROP INDEX t", undefined, A);

// --- 4. the catalog query does not poison a transaction; refused commands are 25001 ---

sequenceParity(
  "the catalog query runs inside BEGIN and the transaction carries on",
  ["CREATE TABLE t (id integer)", "CREATE INDEX t_id_idx ON t (id)"],
  [
    { sql: "BEGIN" },
    { sql: invalid, query: true },
    {
      sql: "SELECT i.indisvalid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE c.relname = 't_id_idx'",
      query: true,
    },
    { sql: "INSERT INTO t VALUES (1)" },
    { sql: "SELECT current_schema() AS schema", query: true },
    { sql: "COMMIT" },
    { sql: "SELECT count(*) AS n FROM t", query: true },
  ],
);

for (const [command, sql] of [
  ["CREATE INDEX CONCURRENTLY", "CREATE INDEX CONCURRENTLY t_v_idx ON t (v)"],
  ["DROP INDEX CONCURRENTLY", "DROP INDEX CONCURRENTLY t_id_idx"],
  ["REINDEX CONCURRENTLY", "REINDEX INDEX CONCURRENTLY t_id_idx"],
  ["REINDEX TABLE CONCURRENTLY", "REINDEX TABLE CONCURRENTLY t"],
  ["REINDEX SCHEMA", "REINDEX SCHEMA public"],
  ["REINDEX DATABASE", "REINDEX DATABASE"],
] as const) {
  errorParity(
    `${command} cannot run inside a transaction block`,
    ["CREATE TABLE t (id integer, v integer)", "CREATE INDEX t_id_idx ON t (id)", "BEGIN"],
    sql,
    undefined,
    A,
  );
}

sequenceParity(
  "plain REINDEX INDEX and REINDEX TABLE are allowed in a transaction",
  ["CREATE TABLE t (id integer)", "CREATE INDEX t_id_idx ON t (id)"],
  [
    { sql: "BEGIN" },
    { sql: "REINDEX INDEX t_id_idx" },
    { sql: "REINDEX TABLE t" },
    { sql: "COMMIT" },
    { sql: flags, query: true },
  ],
);

// --- test control: a concurrent build that is interrupted (not differential, see the header) ---

const flagsOf = (db: Database) =>
  db.query<{ relname: string; indisvalid: boolean; indisready: boolean; indislive: boolean }>(
    `SELECT c.relname, i.indisvalid, i.indisready, i.indislive FROM pg_index i
     JOIN pg_class c ON c.oid = i.indexrelid ORDER BY c.relname`,
  );
const sqlStateOf = (run: () => unknown): string | undefined => {
  try {
    run();
  } catch (error) {
    return error instanceof PostgresError ? error.sqlState : String(error);
  }
  return undefined;
};

test("Database.fault interrupts the next concurrent build and leaves the index invalid", () => {
  const db = new Database();
  try {
    db.exec("CREATE SCHEMA app; CREATE TABLE app.t (id integer, v integer); INSERT INTO app.t VALUES (1, 1), (2, 2)");
    db.fault({ concurrentIndexBuild: "57014" });
    // an ordinary build is not a concurrent one: the fault stays armed
    db.exec("CREATE INDEX t_id_idx ON app.t (id)");
    let message = "";
    try {
      db.exec("CREATE INDEX CONCURRENTLY interrupted_idx ON app.t (v)");
    } catch (error) {
      expect(error).toBeInstanceOf(PostgresError);
      expect((error as PostgresError).sqlState).toBe("57014");
      message = (error as PostgresError).message;
    }
    expect(message).toBe("canceling statement due to user request");
    expect(flagsOf(db)).toEqual([
      { relname: "interrupted_idx", indisvalid: false, indisready: false, indislive: true },
      { relname: "t_id_idx", indisvalid: true, indisready: true, indislive: true },
    ]);
    // the reported join names the index and its schema
    expect(db.query(invalidIn("app"))).toEqual([{ name: "interrupted_idx" }]);
    expect(db.query(invalid)).toEqual([]);
    expect(db.query("SELECT indexdef FROM pg_indexes WHERE indexname = 'interrupted_idx'")).toEqual([
      { indexdef: "CREATE INDEX interrupted_idx ON app.t USING btree (v)" },
    ]);
    // one shot: the next concurrent build completes
    db.exec("CREATE INDEX CONCURRENTLY second_idx ON app.t (v)");
    expect(db.query(invalidIn("app"))).toEqual([{ name: "interrupted_idx" }]);
    // the name is taken until the invalid index is dropped or rebuilt
    expect(sqlStateOf(() => db.exec("CREATE INDEX CONCURRENTLY interrupted_idx ON app.t (v)"))).toBe("42P07");
    db.exec("REINDEX INDEX app.interrupted_idx");
    expect(db.query(invalidIn("app"))).toEqual([]);
  } finally {
    db.close();
  }
});

test("the recommended recovery works: drop the invalid index and build it again", () => {
  const db = new Database();
  try {
    db.exec("CREATE TABLE t (id integer)");
    db.fault({ concurrentIndexBuild: "40P01" });
    expect(sqlStateOf(() => db.exec("CREATE UNIQUE INDEX CONCURRENTLY t_id_idx ON t (id)"))).toBe("40P01");
    expect(db.query(invalid)).toEqual([{ name: "t_id_idx" }]);
    // an invalid unique index is not maintained, so it does not reject duplicates
    db.exec("INSERT INTO t VALUES (1), (1)");
    db.exec("DROP INDEX t_id_idx");
    expect(db.query(invalid)).toEqual([]);
    expect(sqlStateOf(() => db.exec("CREATE UNIQUE INDEX CONCURRENTLY t_id_idx ON t (id)"))).toBe("23505");
    db.exec("DELETE FROM t; DROP INDEX t_id_idx; CREATE UNIQUE INDEX CONCURRENTLY t_id_idx ON t (id)");
    expect(flagsOf(db)).toEqual([{ relname: "t_id_idx", indisvalid: true, indisready: true, indislive: true }]);
  } finally {
    db.close();
  }
});

test("an interrupted REINDEX CONCURRENTLY leaves the original usable and a _ccnew index invalid", () => {
  const db = new Database();
  try {
    db.exec("CREATE TABLE t (id integer); CREATE UNIQUE INDEX t_id_idx ON t (id); INSERT INTO t VALUES (1)");
    db.fault({ concurrentIndexBuild: "57014" });
    expect(sqlStateOf(() => db.exec("REINDEX INDEX CONCURRENTLY t_id_idx"))).toBe("57014");
    expect(flagsOf(db)).toEqual([
      { relname: "t_id_idx", indisvalid: true, indisready: true, indislive: true },
      { relname: "t_id_idx_ccnew", indisvalid: false, indisready: false, indislive: true },
    ]);
    expect(sqlStateOf(() => db.exec("INSERT INTO t VALUES (1)"))).toBe("23505");
    db.exec("DROP INDEX t_id_idx_ccnew");
    db.exec("REINDEX INDEX CONCURRENTLY t_id_idx");
    expect(db.query(invalid)).toEqual([]);
  } finally {
    db.close();
  }
});

test("an armed fault is not part of a snapshot and survives a rollback", () => {
  const db = new Database();
  let fork: Database | undefined;
  try {
    db.exec("CREATE TABLE t (id integer)");
    db.fault({ concurrentIndexBuild: "57014" });
    fork = db.snapshot().open();
    fork.exec("CREATE INDEX CONCURRENTLY t_id_idx ON t (id)");
    expect(fork.query(invalid)).toEqual([]);
    db.exec("BEGIN; INSERT INTO t VALUES (1); ROLLBACK");
    expect(sqlStateOf(() => db.exec("CREATE INDEX CONCURRENTLY t_id_idx ON t (id)"))).toBe("57014");
    expect(db.query(invalid)).toEqual([{ name: "t_id_idx" }]);
  } finally {
    fork?.close();
    db.close();
  }
});

test("an invalid index is still invalid after a snapshot round trip, in every schema", () => {
  const db = new Database();
  let restored: Database | undefined;
  try {
    db.exec("CREATE SCHEMA app; CREATE TABLE t (v integer); CREATE TABLE app.t (v integer)");
    db.exec("INSERT INTO t VALUES (1), (1); CREATE INDEX t_ok_idx ON t (v)");
    expect(sqlStateOf(() => db.exec("CREATE UNIQUE INDEX CONCURRENTLY failed_idx ON t (v)"))).toBe("23505");
    db.fault({ concurrentIndexBuild: "57014" });
    expect(sqlStateOf(() => db.exec("CREATE INDEX CONCURRENTLY interrupted_idx ON app.t (v)"))).toBe("57014");
    const joined = `SELECT n.nspname, t.relname AS tablename, c.relname AS indexname, i.indisvalid FROM pg_index i
      JOIN pg_class c ON c.oid = i.indexrelid JOIN pg_class t ON t.oid = i.indrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace ORDER BY 1, 3`;
    const before = db.query(joined);
    expect(before).toEqual([
      { nspname: "app", tablename: "t", indexname: "interrupted_idx", indisvalid: false },
      { nspname: "public", tablename: "t", indexname: "failed_idx", indisvalid: false },
      { nspname: "public", tablename: "t", indexname: "t_ok_idx", indisvalid: true },
    ]);
    restored = Snapshot.decode(db.snapshot().encode()).open();
    expect(restored.query(joined)).toEqual(before);
    // and it can still be repaired there
    restored.exec("DELETE FROM t; REINDEX INDEX failed_idx; REINDEX INDEX app.interrupted_idx");
    expect(restored.query(invalid)).toEqual([]);
    expect(restored.query(invalidIn("app"))).toEqual([]);
    expect(db.query(invalid)).toEqual([{ name: "failed_idx" }]);
  } finally {
    restored?.close();
    db.close();
  }
});

test("the sync API has no aborted-transaction state: a failed statement leaves the transaction usable", () => {
  // documented difference 3 (COMPATIBILITY.md); the wire server keeps 25P02, see tests/wire/index-catalog.test.ts
  const db = new Database();
  try {
    db.exec("CREATE TABLE t (id integer); BEGIN");
    expect(db.query(invalid)).toEqual([]);
    expect(sqlStateOf(() => db.query("SELECT nope FROM t"))).toBe("42703");
    expect(db.query("SELECT 1 AS one")).toEqual([{ one: 1 }]);
    db.exec("ROLLBACK");
  } finally {
    db.close();
  }
});
