import { expect, test } from "bun:test";
import { Database, Snapshot } from "../../../src/index.ts";
import { errorParity, parity, parityTyped, sequenceParity } from "../helpers.ts";

// pg_stat_user_tables, ANALYZE and index usage statistics (#320).
// Oracle: PGlite (PostgreSQL 18.3),
// https://www.postgresql.org/docs/18/monitoring-stats.html#MONITORING-PG-STAT-ALL-TABLES-VIEW
// https://www.postgresql.org/docs/18/sql-analyze.html
//
// PostgreSQL collects these counters asynchronously: a backend reports its pending counts some
// time after the statement, and an ANALYZE that runs before they are reported is later added to
// by them. Here the counters are always current. So every differential read below is taken once
// PostgreSQL has caught up: pg_stat_force_next_flush() goes before each ANALYZE and each read
// that depends on row activity. The engine's immediate answer is pinned by CAT-table-stat-04.

const A = { messageTier: "A" } as const;

/** The reported query: user tables of the current schema with their live-row estimate. */
const tableStats = `SELECT c.relname, COALESCE(s.n_live_tup, 0)::bigint AS n_live_tup
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid
  WHERE n.nspname = current_schema() AND c.relkind = 'r' ORDER BY c.relname`;
// The oracle is one long-lived session: temporary tables other tests left behind live in its
// pg_temp schema and show in these views. Every other read goes through a user-schema filter.
const TABLES = "(SELECT * FROM pg_stat_user_tables WHERE schemaname !~ '^pg_')";
const INDEXES = "(SELECT * FROM pg_stat_user_indexes WHERE schemaname !~ '^pg_')";
const live = `SELECT schemaname, relname, n_live_tup FROM ${TABLES} AS stats ORDER BY 1, 2`;
/** Have PostgreSQL report its pending counters; one row either way, so the step compares equal. */
const FLUSH = "SELECT count(*) AS flushed FROM (SELECT pg_stat_force_next_flush()) AS f";
const flush = { sql: FLUSH, query: true };
/** ANALYZE once nothing is pending, so the estimate it stores is not added to afterwards. */
const analyze = (target = "") => [flush, { sql: `ANALYZE ${target}`.trim() }];
const twoSchemas = [
  "CREATE SCHEMA app",
  "CREATE TABLE example (id integer)",
  "CREATE TABLE app.example (id integer, v text)",
  "CREATE TABLE app.other (id integer PRIMARY KEY)",
];

// --- 1. every user table, and nothing else; relid joins to pg_class.oid across schemas ---

parity("the bare reported query runs on an empty database", [], `SELECT relid, n_live_tup FROM ${TABLES} AS stats`);

parity(
  "every user table appears once with its schema and name, and relid is its pg_class oid",
  twoSchemas,
  `SELECT s.schemaname, s.relname, n.nspname AS class_schema, c.relname AS class_name, c.relkind
   FROM ${TABLES} s JOIN pg_class c ON c.oid = s.relid JOIN pg_namespace n ON n.oid = c.relnamespace
   ORDER BY 1, 2`,
);

parity(
  "the join is one row per table: no relid is shared or missing",
  twoSchemas,
  `SELECT count(*) AS stat_rows, count(DISTINCT s.relid) AS distinct_relids,
          (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE c.relkind = 'r' AND n.nspname IN ('public', 'app')) AS tables
   FROM ${TABLES} s`,
);

parity(
  "system relations do not appear",
  twoSchemas,
  // read from the view itself: the catalogs have tables, and none of them is a user table
  `SELECT count(*) AS system_rows FROM pg_stat_user_tables
   WHERE schemaname IN ('pg_catalog', 'information_schema', 'pg_toast')`,
);

parity(
  "views, sequences and indexes are not tables; a materialized view is reported",
  [
    "CREATE TABLE t (id integer PRIMARY KEY)",
    "CREATE VIEW v AS SELECT id FROM t",
    "CREATE SEQUENCE sq",
    "CREATE INDEX t_id_idx ON t (id)",
    "CREATE MATERIALIZED VIEW mv AS SELECT 1 AS one",
  ],
  `SELECT s.relname, c.relkind FROM ${TABLES} s JOIN pg_class c ON c.oid = s.relid ORDER BY 1`,
);

// --- 2. n_live_tup is a bigint that reflects the rows ---

parityTyped(
  "relid, schemaname, relname and n_live_tup have PostgreSQL's types",
  ["CREATE TABLE t (id integer)", "INSERT INTO t VALUES (1), (2)", FLUSH, "ANALYZE t"],
  `SELECT relid > 0 AS has_relid, schemaname, relname, n_live_tup FROM ${TABLES} AS stats`,
);

parityTyped(
  "the reported join yields name and bigint",
  ["CREATE TABLE t (id integer)", "INSERT INTO t VALUES (1), (2)", FLUSH, "ANALYZE t"],
  tableStats,
);

sequenceParity(
  "ANALYZE makes n_live_tup the table's row count, after inserts, deletes and TRUNCATE",
  ["CREATE TABLE t (id integer)"],
  [
    ...analyze("t"),
    { sql: live, query: true },
    { sql: "INSERT INTO t SELECT g FROM generate_series(1, 7) AS g" },
    ...analyze("t"),
    { sql: live, query: true },
    { sql: tableStats, query: true },
    { sql: "DELETE FROM t WHERE id > 4" },
    ...analyze("t"),
    { sql: live, query: true },
    { sql: "UPDATE t SET id = id + 10" },
    ...analyze(),
    { sql: live, query: true },
    { sql: "TRUNCATE t" },
    ...analyze("t"),
    { sql: live, query: true },
  ],
);

sequenceParity(
  "the estimate catches up without ANALYZE once the counters are reported",
  ["CREATE TABLE t (id integer)"],
  [
    { sql: "INSERT INTO t VALUES (1), (2), (3)" },
    flush,
    { sql: live, query: true },
    { sql: "DELETE FROM t WHERE id = 1" },
    flush,
    { sql: live, query: true },
  ],
);

sequenceParity("analyze_count and last_analyze record ANALYZE, per table", twoSchemas, [
  {
    sql: `SELECT schemaname, relname, analyze_count, last_analyze IS NULL AS never FROM ${TABLES} AS stats ORDER BY 1, 2`,
    query: true,
  },
  { sql: "ANALYZE example" },
  { sql: "ANALYZE VERBOSE app.example" },
  { sql: "ANALYZE (VERBOSE, SKIP_LOCKED) app.example (id, v)" },
  { sql: "ANALYSE app.example" },
  // a table named twice is analyzed twice
  { sql: "ANALYZE example, example" },
  {
    sql: `SELECT schemaname, relname, analyze_count, last_analyze IS NULL AS never FROM ${TABLES} AS stats ORDER BY 1, 2`,
    query: true,
  },
  { sql: "ANALYZE" },
  { sql: `SELECT schemaname, relname, analyze_count FROM ${TABLES} AS stats ORDER BY 1, 2`, query: true },
]);

parityTyped(
  "the ANALYZE bookkeeping columns have PostgreSQL's types",
  ["CREATE TABLE t (id integer)", "ANALYZE t"],
  `SELECT analyze_count, last_analyze IS NOT NULL AS analyzed, last_analyze FROM ${TABLES} AS stats WHERE false`,
);

sequenceParity(
  "ANALYZE of a view or an index is skipped, not an error",
  ["CREATE TABLE t (id integer)", "CREATE VIEW v AS SELECT id FROM t", "CREATE INDEX t_id_idx ON t (id)"],
  [
    { sql: "ANALYZE v" },
    { sql: "ANALYZE t_id_idx" },
    { sql: `SELECT relname, analyze_count FROM ${TABLES} AS stats ORDER BY 1`, query: true },
  ],
);

errorParity("ANALYZE of a missing table is 42P01", [], "ANALYZE missing_table", "undefined_table", A);
errorParity("ANALYZE in a missing schema is 3F000", [], "ANALYZE nope.missing_table", undefined, A);
errorParity(
  "ANALYZE of a missing column is 42703",
  ["CREATE TABLE t (id integer)"],
  "ANALYZE t (nope)",
  "undefined_column",
  A,
);
errorParity(
  "ANALYZE naming a column twice is 42701",
  ["CREATE TABLE t (id integer)"],
  "ANALYZE t (id, id)",
  undefined,
  A,
);
errorParity(
  "an unknown ANALYZE option is a syntax error",
  ["CREATE TABLE t (id integer)"],
  "ANALYZE (BOGUS) t",
  "syntax",
  A,
);

sequenceParity(
  "a failing ANALYZE analyzes none of its tables",
  ["CREATE TABLE t (id integer)"],
  [
    { sql: "ANALYZE t, missing_table" },
    { sql: `SELECT relname, analyze_count FROM ${TABLES} AS stats ORDER BY 1`, query: true },
  ],
);

// --- 3. create / drop and schema isolation ---

sequenceParity(
  "tables enter and leave the view with CREATE and DROP",
  [],
  [
    { sql: tableStats, query: true },
    { sql: "CREATE TABLE a (id integer)" },
    { sql: "CREATE TABLE b (id integer)" },
    { sql: "INSERT INTO a VALUES (1), (2)" },
    ...analyze(),
    { sql: tableStats, query: true },
    { sql: "DROP TABLE a" },
    { sql: tableStats, query: true },
    { sql: live, query: true },
    // a new table of a dropped table's name starts over
    { sql: "CREATE TABLE a (id integer)" },
    { sql: "ANALYZE a" },
    { sql: `SELECT relname, n_live_tup, analyze_count FROM ${TABLES} AS stats ORDER BY 1`, query: true },
  ],
);

sequenceParity("the current_schema() filter sees only its own schema's tables", twoSchemas, [
  { sql: "INSERT INTO example VALUES (1), (2), (3)" },
  { sql: "INSERT INTO app.example VALUES (1, 'a')" },
  ...analyze(),
  { sql: tableStats, query: true },
  { sql: "SET search_path = app" },
  { sql: tableStats, query: true },
  { sql: "SET search_path = public" },
  { sql: live, query: true },
  { sql: "DROP TABLE app.example" },
  { sql: live, query: true },
  { sql: "DROP SCHEMA app CASCADE" },
  { sql: live, query: true },
]);

sequenceParity(
  "renames and schema moves keep relid and the estimate",
  ["CREATE SCHEMA app", "CREATE TABLE t (id integer)", "INSERT INTO t VALUES (1), (2)", FLUSH, "ANALYZE t"],
  [
    { sql: `CREATE TABLE saved AS SELECT relid::bigint AS relid FROM ${TABLES} AS stats WHERE relname = 't'` },
    { sql: "ALTER TABLE t RENAME TO renamed" },
    { sql: "ALTER TABLE renamed SET SCHEMA app" },
    { sql: "ALTER SCHEMA app RENAME TO app2" },
    {
      sql: `SELECT s.schemaname, s.relname, s.n_live_tup, s.analyze_count, s.relid = (SELECT relid FROM saved) AS same_relid
          FROM ${TABLES} s WHERE s.relname = 'renamed'`,
      query: true,
    },
  ],
);

// --- 4. shape of the whole view, and of pg_stat_user_indexes ---

parity(
  "SELECT * has PostgreSQL 18's columns in its order",
  ["CREATE TABLE t (id integer)"],
  `SELECT * FROM ${TABLES} AS stats WHERE false`,
);

parityTyped(
  "every column has PostgreSQL's type",
  ["CREATE TABLE t (id integer PRIMARY KEY)", "ANALYZE t"],
  // last_analyze differs by the clock; its type is checked above, the rest of a fresh analyzed row compares
  `SELECT schemaname, relname, seq_scan, last_seq_scan, seq_tup_read, idx_scan, last_idx_scan, idx_tup_fetch,
          n_tup_ins, n_tup_upd, n_tup_del, n_tup_hot_upd, n_tup_newpage_upd, n_live_tup, n_dead_tup,
          n_mod_since_analyze, n_ins_since_vacuum, last_vacuum, last_autovacuum, last_autoanalyze,
          vacuum_count, autovacuum_count, analyze_count, autoanalyze_count,
          total_vacuum_time, total_autovacuum_time, total_autoanalyze_time
   FROM ${TABLES} AS stats`,
);

parity(
  "idx_scan is NULL for a table without an index and a count for one that has any",
  ["CREATE TABLE plain (id integer)", "CREATE TABLE keyed (id integer PRIMARY KEY)", "ANALYZE"],
  `SELECT relname, idx_scan, idx_tup_fetch FROM ${TABLES} AS stats ORDER BY 1`,
);

parity(
  "pg_stat_user_indexes has PostgreSQL 18's columns in its order",
  [],
  `SELECT * FROM ${INDEXES} AS stats WHERE false`,
);

parityTyped(
  "pg_stat_user_indexes lists every index of every schema, constraint-backed ones included",
  [
    ...twoSchemas,
    "CREATE INDEX example_id_idx ON example (id)",
    "CREATE UNIQUE INDEX example_v_idx ON app.example (v)",
  ],
  `SELECT s.schemaname, s.relname, s.indexrelname, s.idx_scan, s.last_idx_scan, s.idx_tup_read, s.idx_tup_fetch,
          s.relid = t.oid AS relid_is_table, s.indexrelid = i.oid AS indexrelid_is_index
   FROM ${INDEXES} s JOIN pg_class t ON t.oid = s.relid JOIN pg_class i ON i.oid = s.indexrelid
   WHERE i.relname = s.indexrelname AND t.relname = s.relname ORDER BY 1, 2, 3`,
);

sequenceParity(
  "an index's row follows it through rename and disappears with DROP INDEX",
  ["CREATE TABLE t (id integer)", "CREATE INDEX t_id_idx ON t (id)"],
  [
    { sql: "ALTER INDEX t_id_idx RENAME TO t_renamed_idx" },
    { sql: `SELECT relname, indexrelname FROM ${INDEXES} AS stats ORDER BY 2`, query: true },
    { sql: "DROP INDEX t_renamed_idx" },
    { sql: `SELECT count(*) AS n FROM ${INDEXES} AS stats`, query: true },
  ],
);

// --- the engine's own choices (not differential) ---

test("statistics are restored with a snapshot and belong to the branch that changed them", () => {
  const db = new Database();
  let restored: Database | undefined;
  try {
    db.exec("CREATE SCHEMA app; CREATE TABLE t (id integer PRIMARY KEY); CREATE TABLE app.t (id integer)");
    db.exec("INSERT INTO t VALUES (1), (2), (3); INSERT INTO app.t VALUES (1); ANALYZE t; ANALYZE t");
    const stats = `SELECT s.schemaname, s.relname, s.relid, c.oid AS class_oid, s.n_live_tup, s.analyze_count,
                          s.last_analyze::text AS last_analyze
                   FROM pg_stat_user_tables s JOIN pg_class c ON c.oid = s.relid ORDER BY 1, 2`;
    const before = db.query<{ relid: number; class_oid: number; analyze_count: bigint; n_live_tup: bigint }>(stats);
    expect(before.map((row) => [row.n_live_tup, row.analyze_count])).toEqual([
      [1n, 0n],
      [3n, 2n],
    ]);
    expect(before.every((row) => row.relid === row.class_oid)).toBe(true);
    restored = Snapshot.decode(db.snapshot().encode()).open();
    expect(restored.query(stats)).toEqual(before);
    expect(restored.query(tableStats)).toEqual(db.query(tableStats));
    // writes after the snapshot stay on their own side
    restored.exec("INSERT INTO t VALUES (4); ANALYZE app.t");
    db.exec("DELETE FROM t WHERE id = 1");
    expect(restored.query(live)).toEqual([
      { schemaname: "app", relname: "t", n_live_tup: 1n },
      { schemaname: "public", relname: "t", n_live_tup: 4n },
    ]);
    expect(db.query(live)).toEqual([
      { schemaname: "app", relname: "t", n_live_tup: 1n },
      { schemaname: "public", relname: "t", n_live_tup: 2n },
    ]);
    expect(db.query(stats).map((row) => (row as { analyze_count: bigint }).analyze_count)).toEqual([0n, 2n]);
  } finally {
    restored?.close();
    db.close();
  }
});

test("ANALYZE is deterministic: last_analyze is the database clock, and a rollback undoes it", () => {
  const db = new Database({ now: new Date("2024-05-06T07:08:09.000Z") });
  try {
    db.exec("CREATE TABLE t (id integer); ANALYZE t");
    const read = "SELECT analyze_count, last_analyze::text AS last_analyze FROM pg_stat_user_tables";
    expect(db.query(read)).toEqual([{ analyze_count: 1n, last_analyze: "2024-05-06 07:08:09+00" }]);
    db.exec("BEGIN; ANALYZE t; ROLLBACK");
    expect(db.query(read)).toEqual([{ analyze_count: 1n, last_analyze: "2024-05-06 07:08:09+00" }]);
  } finally {
    db.close();
  }
});
