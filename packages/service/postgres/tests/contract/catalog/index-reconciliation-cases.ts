import { expect } from "bun:test";
import type { PostgresError } from "../../../src/index.ts";
import type { CatalogCase } from "./run.ts";

/**
 * Index and catalog introspection as schema-reconciliation code uses it (#320, #326,
 * #329, #330, #331). Listed in the CAT section of the scenario catalog; the
 * behavior-by-behavior proof is in tests/contract/catalogs/ (index-validity,
 * index-definitions, index-comments, regnamespace, table-statistics).
 */

const invalid = `SELECT c.relname AS name FROM pg_index i
JOIN pg_class c ON c.oid = i.indexrelid JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND NOT i.indisvalid`;
const tableStats = `SELECT c.relname, COALESCE(s.n_live_tup, 0)::bigint AS n_live_tup
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid
WHERE n.nspname = current_schema() AND c.relkind = 'r' ORDER BY c.relname`;
const comments = `SELECT i.relname AS indexname, d.description FROM pg_class i
JOIN pg_index ix ON ix.indexrelid = i.oid
LEFT JOIN pg_description d ON d.objoid = i.oid AND d.objsubid = 0
WHERE i.relname LIKE 'autoidx_%' ORDER BY i.relname`;
const userIndexes = `SELECT t.relname AS tablename, i.relname AS indexname, pg_get_indexdef(i.oid) AS indexdef,
  ix.indisunique, ix.indisprimary, ix.indisvalid FROM pg_index ix JOIN pg_class i ON i.oid = ix.indexrelid
  JOIN pg_class t ON t.oid = ix.indrelid JOIN pg_namespace n ON n.oid = t.relnamespace
  WHERE n.nspname = current_schema() AND t.relkind = 'r' ORDER BY i.relname`;
const indexedTable = ["CREATE TABLE t (id int)", "CREATE INDEX t_id_idx ON t (id)"];
// PostgreSQL reports its counters some time after a statement; ask for them before ANALYZE and before reading
const flush = { sql: "SELECT count(*) AS flushed FROM (SELECT pg_stat_force_next_flush()) AS f", query: true };

export const INDEX_RECONCILIATION_CASES: CatalogCase[] = [
  // regression: mockingbird-postgres-index-validity (#326)
  { id: "CAT-index-valid-01", kind: "parity", sql: invalid },
  {
    id: "CAT-index-valid-02",
    kind: "sequence",
    setup: indexedTable,
    steps: [
      { sql: "BEGIN" },
      { sql: invalid, query: true },
      { sql: "SELECT current_schema() AS schema", query: true },
      { sql: "COMMIT" },
    ],
  },
  {
    id: "CAT-index-valid-03",
    kind: "parity",
    typed: true,
    setup: [
      ...indexedTable,
      "ALTER TABLE t ADD PRIMARY KEY (id)",
      "CREATE INDEX CONCURRENTLY t_concurrent_idx ON t (id)",
    ],
    sql: `SELECT c.relname, i.indisvalid, i.indisready, i.indislive FROM pg_index i
      JOIN pg_class c ON c.oid = i.indexrelid JOIN pg_class t ON t.oid = i.indrelid WHERE t.relname = 't' ORDER BY 1`,
  },
  {
    id: "CAT-index-valid-04",
    kind: "sequence",
    setup: ["CREATE TABLE t (id int)", "INSERT INTO t VALUES (1), (1)"],
    steps: [
      { sql: "CREATE UNIQUE INDEX CONCURRENTLY failed_idx ON t (id)" },
      { sql: invalid, query: true },
      {
        sql: `SELECT n.nspname, c.relname, i.indisvalid, i.indisready, i.indislive FROM pg_index i
          JOIN pg_class c ON c.oid = i.indexrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relname = 'failed_idx'`,
        query: true,
      },
      { sql: "DROP INDEX failed_idx" },
      { sql: invalid, query: true },
      { sql: "CREATE INDEX CONCURRENTLY failed_idx ON t (id)" },
      { sql: invalid, query: true },
    ],
  },
  {
    id: "CAT-index-valid-05",
    kind: "error",
    setup: ["CREATE TABLE t (id int)", "BEGIN"],
    sql: "CREATE INDEX CONCURRENTLY t_id_idx ON t (id)",
    messageTier: "A",
  },
  {
    id: "CAT-index-valid-06",
    kind: "sequence",
    setup: ["CREATE TABLE t (id int, v int)", "INSERT INTO t VALUES (1, 1), (2, 1)"],
    steps: [
      { sql: "CREATE UNIQUE INDEX CONCURRENTLY failed_idx ON t (v)" },
      { sql: "REINDEX INDEX failed_idx" },
      { sql: invalid, query: true },
      { sql: "DELETE FROM t WHERE id = 2" },
      { sql: "REINDEX INDEX failed_idx" },
      { sql: invalid, query: true },
      { sql: "INSERT INTO t VALUES (3, 1)" },
    ],
  },
  {
    id: "CAT-index-valid-07",
    kind: "divergence",
    fn: (db) => {
      db.exec("CREATE TABLE t (id int)");
      db.fault({ concurrentIndexBuild: "57014" });
      let code: string | undefined;
      try {
        db.exec("CREATE INDEX CONCURRENTLY interrupted_idx ON t (id)");
      } catch (error) {
        code = (error as PostgresError).sqlState;
      }
      expect(code).toBe("57014");
      expect(db.query(invalid)).toEqual([{ name: "interrupted_idx" }]);
      expect(db.query("SELECT indisvalid, indisready, indislive FROM pg_index")).toEqual([
        { indisvalid: false, indisready: false, indislive: true },
      ]);
      db.exec("REINDEX INDEX interrupted_idx");
      expect(db.query(invalid)).toEqual([]);
    },
  },
  // regression: mockingbird-postgres-index-definitions (#330)
  {
    id: "CAT-index-def-01",
    kind: "parity",
    setup: [
      "CREATE TABLE t (id int, value text)",
      "CREATE INDEX t_id_idx ON t (id)",
      "CREATE UNIQUE INDEX t_value_idx ON t (value)",
    ],
    sql: userIndexes,
  },
  {
    id: "CAT-index-def-02",
    kind: "parity",
    setup: indexedTable,
    sql: "SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' ORDER BY indexname",
  },
  {
    id: "CAT-index-def-03",
    kind: "sequence",
    setup: ["CREATE TABLE t (id int PRIMARY KEY, email text UNIQUE, a int, b int, UNIQUE NULLS NOT DISTINCT (a, b))"],
    steps: [
      { sql: userIndexes, query: true },
      { sql: "SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' ORDER BY indexname", query: true },
      {
        sql: `SELECT co.conname, co.contype, ci.relname AS index_name, ci.relkind FROM pg_constraint co
          JOIN pg_class ci ON ci.oid = co.conindid WHERE co.contype IN ('p', 'u')
          AND co.conrelid = (SELECT oid FROM pg_class WHERE relname = 't') ORDER BY 1`,
        query: true,
      },
      {
        sql: `SELECT count(*) AS indexes, count(DISTINCT ix.indexrelid) AS distinct_oids,
          count(*) FILTER (WHERE ix.indexrelid = ix.indrelid) AS same_as_table
          FROM pg_index ix JOIN pg_class t ON t.oid = ix.indrelid WHERE t.relname = 't'`,
        query: true,
      },
    ],
  },
  {
    id: "CAT-index-def-04",
    kind: "parity",
    setup: [
      'CREATE TABLE "Order" ("user" int, total numeric, note varchar(40), placed date)',
      'CREATE INDEX "order" ON "Order" USING btree ("user" DESC NULLS LAST, lower(note)) INCLUDE (total) WHERE total > 0 AND note IN (\'a\', \'b\')',
      'CREATE INDEX order_hash ON "Order" USING hash (note)',
      "CREATE INDEX order_expr ON \"Order\" ((total * 2 + 1), COALESCE(note, 'none')) WHERE placed >= '2024-01-01'",
    ],
    sql: "SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' ORDER BY indexname",
  },
  {
    id: "CAT-index-def-05",
    kind: "parity",
    setup: [
      "CREATE TABLE t (a int, b int, c text)",
      "CREATE INDEX t_idx ON t (a DESC, (b + 1), lower(c)) INCLUDE (c) WHERE a > 0 AND b > 0",
    ],
    sql: `SELECT p AS position, pg_get_indexdef(i.oid, p, false) AS plain, pg_get_indexdef(i.oid, p, true) AS pretty,
        pg_get_indexdef(999999, p, true) AS missing_oid
      FROM pg_class i CROSS JOIN generate_series(-1, 5) AS p WHERE i.relname = 't_idx' ORDER BY p`,
  },
  // regression: mockingbird-postgres-index-comments (#331)
  {
    id: "CAT-index-comment-01",
    kind: "sequence",
    setup: ["CREATE TABLE t (id int)", "CREATE INDEX autoidx_t_id ON t (id)"],
    steps: [
      { sql: comments, query: true },
      { sql: "COMMENT ON INDEX autoidx_t_id IS 'managed index'" },
      { sql: comments, query: true },
      { sql: "COMMENT ON INDEX autoidx_t_id IS 'replaced'" },
      { sql: comments, query: true },
      { sql: "COMMENT ON INDEX autoidx_t_id IS NULL" },
      { sql: comments, query: true },
      { sql: "COMMENT ON INDEX autoidx_t_id IS 'managed again'" },
      { sql: "DROP INDEX autoidx_t_id" },
      { sql: comments, query: true },
      { sql: "CREATE INDEX autoidx_t_id ON t (id)" },
      { sql: comments, query: true },
    ],
  },
  {
    id: "CAT-index-comment-02",
    kind: "error",
    setup: ["CREATE TABLE t (id int)"],
    sql: "COMMENT ON INDEX missing_idx IS 'managed index'",
    messageTier: "A",
  },
  // regression: mockingbird-postgres-regnamespace (#329)
  {
    id: "CAT-namespace-01",
    kind: "parity",
    setup: ["CREATE TABLE kv (id int)"],
    sql: "SELECT relpersistence FROM pg_class WHERE relname = 'kv' AND relnamespace = current_schema()::regnamespace",
  },
  {
    id: "CAT-namespace-02",
    kind: "parity",
    setup: ['CREATE SCHEMA "Mixed Case"'],
    sql: `SELECT '"Mixed Case"'::regnamespace::text AS name`,
  },
  { id: "CAT-namespace-03", kind: "parity", sql: "SELECT 'pg_catalog'::regnamespace::oid AS oid" },
  { id: "CAT-namespace-04", kind: "parity", sql: "SELECT 999::regnamespace::text AS name" },
  {
    id: "CAT-namespace-05",
    kind: "error",
    sql: "SELECT 'missing_schema'::regnamespace",
    query: true,
    messageTier: "A",
  },
  { id: "CAT-namespace-06", kind: "error", sql: "SELECT '4294967296'::regnamespace", query: true, messageTier: "A" },
  { id: "CAT-namespace-07", kind: "error", sql: "SELECT 'not.one.name'::regnamespace", query: true, messageTier: "A" },
  // regression: mockingbird-postgres-table-statistics (#320)
  { id: "CAT-table-stat-01", kind: "parity", sql: tableStats },
  { id: "CAT-table-stat-02", kind: "parity", setup: ["CREATE TABLE t (id int)"], sql: tableStats },
  {
    id: "CAT-table-stat-03",
    kind: "sequence",
    setup: ["CREATE TABLE t (id int)", "INSERT INTO t VALUES (1), (2)"],
    steps: [
      flush,
      { sql: "ANALYZE t" },
      { sql: tableStats, query: true },
      { sql: "DROP TABLE t" },
      { sql: tableStats, query: true },
    ],
  },
  {
    id: "CAT-table-stat-04",
    kind: "divergence",
    fn: (db) => {
      db.exec("CREATE TABLE t (id int PRIMARY KEY)");
      db.exec("INSERT INTO t VALUES (1), (2), (3)");
      db.exec("DELETE FROM t WHERE id = 3");
      // current at once, with no ANALYZE and no reporting delay; the activity counters stay zero
      expect(
        db.query(
          "SELECT n_live_tup, n_tup_ins, n_tup_del, n_dead_tup, seq_scan, analyze_count FROM pg_stat_user_tables",
        ),
      ).toEqual([{ n_live_tup: 2n, n_tup_ins: 0n, n_tup_del: 0n, n_dead_tup: 0n, seq_scan: 0n, analyze_count: 0n }]);
      // idx_scan counts the key lookups the engine makes for SELECT
      db.query("SELECT id FROM t WHERE id = 1");
      expect(db.query("SELECT idx_scan FROM pg_stat_user_tables")).toEqual([{ idx_scan: 1n }]);
      expect(db.query("SELECT indexrelname, idx_scan FROM pg_stat_user_indexes")).toEqual([
        { indexrelname: "t_pkey", idx_scan: 1n },
      ]);
    },
  },
  // regression: mockingbird-postgres-index-statistics
  {
    id: "CAT-index-stat-01",
    kind: "parity",
    // scoped to public: the oracle session keeps other tests' temporary tables in pg_temp
    sql: "SELECT indexrelname, COALESCE(idx_scan, 0)::bigint AS idx_scan FROM pg_stat_user_indexes WHERE schemaname = 'public' ORDER BY indexrelname",
  },
  {
    id: "CAT-index-stat-02",
    kind: "parity",
    setup: indexedTable,
    sql: "SELECT schemaname, relname, indexrelname, idx_scan FROM pg_stat_user_indexes WHERE schemaname = 'public'",
  },
];
