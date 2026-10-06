import type { CatalogCase } from "./run.ts";

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
const indexedTable = ["CREATE TABLE t (id int)", "CREATE INDEX t_id_idx ON t (id)"];

// regression: emulates-postgres-index-validity (#326)
export const INDEX_RECONCILIATION_CASES: CatalogCase[] = [
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
    setup: indexedTable,
    sql: "SELECT indisvalid FROM pg_index i JOIN pg_class c ON c.oid = i.indrelid WHERE c.relname = 't' AND c.relkind = 'r'",
  },
  {
    id: "CAT-index-valid-04",
    kind: "sequence",
    setup: ["CREATE TABLE t (id int)", "INSERT INTO t VALUES (1), (1)"],
    steps: [
      { sql: "CREATE UNIQUE INDEX CONCURRENTLY failed_idx ON t (id)" },
      { sql: invalid, query: true },
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
  // regression: emulates-postgres-index-definitions
  {
    id: "CAT-index-def-01",
    kind: "parity",
    setup: [
      "CREATE TABLE t (id int, value text)",
      "CREATE INDEX t_id_idx ON t (id)",
      "CREATE UNIQUE INDEX t_value_idx ON t (value)",
    ],
    sql: `SELECT i.relname AS indexname, t.relname AS tablename, pg_get_indexdef(i.oid) AS indexdef,
      ix.indisunique, ix.indisprimary, ix.indisvalid FROM pg_index ix JOIN pg_class i ON i.oid = ix.indexrelid
      JOIN pg_class t ON t.oid = ix.indrelid JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname = current_schema() AND t.relkind = 'r' ORDER BY i.relname`,
  },
  {
    id: "CAT-index-def-02",
    kind: "parity",
    setup: indexedTable,
    sql: "SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' ORDER BY indexname",
  },
  // regression: emulates-postgres-index-comments
  {
    id: "CAT-index-comment-01",
    kind: "sequence",
    setup: ["CREATE TABLE t (id int)", "CREATE INDEX autoidx_t_id ON t (id)"],
    steps: [
      { sql: comments, query: true },
      { sql: "COMMENT ON INDEX autoidx_t_id IS 'managed index'" },
      { sql: comments, query: true },
      { sql: "COMMENT ON INDEX autoidx_t_id IS NULL" },
      { sql: comments, query: true },
      { sql: "COMMENT ON INDEX autoidx_t_id IS 'managed again'" },
      { sql: "DROP INDEX autoidx_t_id" },
      { sql: comments, query: true },
    ],
  },
  // regression: emulates-postgres-regnamespace
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
  { id: "CAT-namespace-05", kind: "error", sql: "SELECT 'missing_schema'::regnamespace", messageTier: "A" },
  // regression: emulates-postgres-table-statistics (#320)
  { id: "CAT-table-stat-01", kind: "parity", sql: tableStats },
  { id: "CAT-table-stat-02", kind: "parity", setup: ["CREATE TABLE t (id int)"], sql: tableStats },
  {
    id: "CAT-table-stat-03",
    kind: "sequence",
    setup: ["CREATE TABLE t (id int)", "INSERT INTO t VALUES (1), (2)"],
    steps: [
      { sql: "ANALYZE t" },
      { sql: tableStats, query: true },
      { sql: "DROP TABLE t" },
      { sql: tableStats, query: true },
    ],
  },
  // regression: emulates-postgres-index-statistics
  {
    id: "CAT-index-stat-01",
    kind: "parity",
    sql: "SELECT indexrelname, COALESCE(idx_scan, 0)::bigint AS idx_scan FROM pg_stat_user_indexes ORDER BY indexrelname",
  },
  {
    id: "CAT-index-stat-02",
    kind: "parity",
    setup: indexedTable,
    sql: "SELECT schemaname, relname, indexrelname, idx_scan FROM pg_stat_user_indexes WHERE schemaname = 'public'",
  },
];
