import type { CatalogCase } from "./run.ts";

export const ALTER_SET_CASES: CatalogCase[] = [
  // regression: emulates-postgres-set-default (#319)
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
  // regression: emulates-postgres-set-not-null (#318)
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
];
