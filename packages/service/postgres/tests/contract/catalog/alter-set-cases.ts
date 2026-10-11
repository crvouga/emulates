import type { CatalogCase } from "./run.ts";

const ATTSTORAGE =
  "SELECT a.attname, a.attstorage FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid " +
  "WHERE c.relname = 't' AND a.attnum > 0 ORDER BY a.attnum";

/**
 * ALTER TABLE forms that change column and relation metadata. Listed in the DDL
 * section of the scenario catalog; the behavior-by-behavior proof is in
 * tests/contract/alter-table/set-*.test.ts.
 */
export const ALTER_SET_CASES: CatalogCase[] = [
  // regression: mockingbird-postgres-set-default (#319)
  {
    id: "DDL-alter-set-01",
    kind: "sequence",
    setup: ["CREATE TABLE t (v int)"],
    steps: [
      { sql: "ALTER TABLE t ALTER COLUMN v SET DEFAULT 7" },
      { sql: "INSERT INTO t DEFAULT VALUES" },
      { sql: "SELECT v FROM t", query: true },
    ],
  },
  // regression: mockingbird-postgres-set-not-null (#318)
  {
    id: "DDL-alter-set-02",
    kind: "sequence",
    setup: ["CREATE TABLE t (v int)"],
    steps: [
      { sql: "ALTER TABLE t ALTER COLUMN v SET NOT NULL" },
      { sql: "SELECT is_nullable FROM information_schema.columns WHERE table_name = 't'", query: true },
    ],
  },
  {
    id: "DDL-alter-set-03",
    kind: "error",
    setup: ["CREATE TABLE t (v int)", "INSERT INTO t VALUES (NULL)"],
    sql: "ALTER TABLE t ALTER COLUMN v SET NOT NULL",
    messageTier: "A",
  },
  {
    id: "DDL-alter-set-04",
    kind: "sequence",
    setup: ["CREATE TABLE t (v int NOT NULL)"],
    steps: [
      { sql: "ALTER TABLE t ALTER COLUMN v DROP NOT NULL" },
      { sql: "INSERT INTO t VALUES (NULL)" },
      { sql: "SELECT is_nullable FROM information_schema.columns WHERE table_name = 't'", query: true },
    ],
    compareFinalState: true,
  },
  {
    id: "DDL-alter-set-05",
    kind: "sequence",
    setup: ["CREATE TABLE t (n int, s text, at timestamptz, gone int DEFAULT 1)"],
    steps: [
      { sql: "ALTER TABLE t ALTER COLUMN n SET DEFAULT 1 + 2" },
      { sql: "ALTER TABLE t ALTER COLUMN s SET DEFAULT 'x' || 'y'" },
      { sql: "ALTER TABLE t ALTER COLUMN at SET DEFAULT now()" },
      { sql: "ALTER TABLE t ALTER COLUMN gone DROP DEFAULT" },
      {
        sql: "SELECT column_name, column_default FROM information_schema.columns WHERE table_name = 't' ORDER BY ordinal_position",
        query: true,
      },
    ],
  },
  // mockingbird-postgres-set-storage (#332)
  {
    id: "DDL-alter-set-06",
    kind: "sequence",
    setup: ["CREATE TABLE t (id int, v text, n numeric)"],
    steps: [
      { sql: ATTSTORAGE, query: true },
      { sql: "ALTER TABLE t ALTER COLUMN v SET STORAGE MAIN" },
      { sql: "ALTER TABLE t ALTER COLUMN n SET STORAGE EXTERNAL" },
      { sql: ATTSTORAGE, query: true },
      { sql: "ALTER TABLE t ALTER COLUMN v SET STORAGE DEFAULT" },
      { sql: ATTSTORAGE, query: true },
    ],
  },
  {
    id: "DDL-alter-set-07",
    kind: "error",
    setup: ["CREATE TABLE t (id int, v text)"],
    sql: "ALTER TABLE t ALTER COLUMN id SET STORAGE MAIN",
    messageTier: "A",
  },
  // mockingbird-postgres-unlogged (#333)
  {
    id: "DDL-alter-set-08",
    kind: "sequence",
    setup: [
      "CREATE TABLE t (id serial PRIMARY KEY, v text)",
      "CREATE UNLOGGED TABLE u (id int)",
      "INSERT INTO t (v) VALUES ('a')",
    ],
    steps: [
      { sql: "ALTER TABLE t SET UNLOGGED" },
      { sql: "ALTER TABLE u SET LOGGED" },
      {
        sql: "SELECT relname, relpersistence FROM pg_class WHERE relname IN ('t', 'u', 't_id_seq') ORDER BY relname",
        query: true,
      },
      { sql: "SELECT id, v FROM t", query: true },
    ],
    compareFinalState: true,
  },
  {
    id: "DDL-alter-set-09",
    kind: "error",
    setup: ["CREATE TABLE parent (id int PRIMARY KEY)", "CREATE TABLE child (parent_id int REFERENCES parent (id))"],
    sql: "ALTER TABLE parent SET UNLOGGED",
    messageTier: "A",
  },
];
