import { expect, test } from "bun:test";
import { Database, Snapshot } from "../../../src/index.ts";
import { errorParity, parity, parityTyped, sequenceParity } from "../helpers.ts";

// Persisted index comments and pg_description (#331).
// Oracle: PGlite (PostgreSQL 18.3), https://www.postgresql.org/docs/18/catalog-pg-description.html

const A = { messageTier: "A" } as const;
const indexed = ["CREATE TABLE t (id integer PRIMARY KEY, v integer)", "CREATE INDEX autoidx_t_id ON t (id)"];

/** The reported query: every index with its comment, NULL when it has none. */
const comments = `SELECT i.relname, d.description FROM pg_class i
  JOIN pg_index ix ON ix.indexrelid = i.oid
  LEFT JOIN pg_description d ON d.objoid = i.oid AND d.objsubid = 0
  WHERE i.relname LIKE 'autoidx%' ORDER BY i.relname`;
const rows = `SELECT c.relname, d.description FROM pg_description d JOIN pg_class c ON c.oid = d.objoid
  WHERE d.classoid = 1259 AND c.relkind = 'i' ORDER BY c.relname`;

// --- 1. no comment joins to NULL; a comment is a pg_description row for the index ---

parity("an uncommented index joins to a NULL description", indexed, comments);

parity(
  "COMMENT ON INDEX makes the description visible",
  [...indexed, "COMMENT ON INDEX autoidx_t_id IS 'managed index'"],
  comments,
);

parity(
  "the row names the index by oid, pg_class as its catalog, and subobject 0",
  [...indexed, "COMMENT ON INDEX autoidx_t_id IS 'managed index'"],
  // classoid is compared as a value: 1259 is pg_class in the oracle (system catalogs are not rows of pg_class here)
  `SELECT d.objoid = i.oid AS is_index_oid, d.objoid <> ix.indrelid AS not_the_table, d.classoid, d.objsubid, d.description
   FROM pg_description d JOIN pg_class i ON i.oid = d.objoid JOIN pg_index ix ON ix.indexrelid = i.oid
   WHERE i.relname = 'autoidx_t_id'`,
);

parityTyped(
  "pg_description column types",
  [...indexed, "COMMENT ON INDEX autoidx_t_id IS 'managed index'"],
  `SELECT d.objoid > 0 AS objoid_set, d.classoid, d.objsubid, d.description
   FROM pg_description d JOIN pg_class i ON i.oid = d.objoid WHERE i.relname = 'autoidx_t_id'`,
);

parity(
  "obj_description reads the same comment",
  [...indexed, "COMMENT ON INDEX autoidx_t_id IS 'managed index'"],
  `SELECT obj_description((SELECT oid FROM pg_class WHERE relname = 'autoidx_t_id'), 'pg_class') AS with_catalog,
          obj_description((SELECT oid FROM pg_class WHERE relname = 'autoidx_t_id')) AS without_catalog,
          obj_description((SELECT oid FROM pg_class WHERE relname = 'autoidx_t_id'), 'pg_namespace') AS other_catalog`,
);

parity(
  "a schema-qualified name and a quoted name address the index",
  [
    "CREATE SCHEMA app",
    "CREATE TABLE app.t (id integer)",
    'CREATE INDEX "Auto Idx" ON app.t (id)',
    `COMMENT ON INDEX app."Auto Idx" IS 'qualified'`,
  ],
  rows,
);

// --- 2. replacing updates the row, clearing removes it ---

sequenceParity("a comment is replaced, then cleared with NULL, then with an empty string", indexed, [
  { sql: "COMMENT ON INDEX autoidx_t_id IS 'first'" },
  { sql: rows, query: true },
  { sql: "COMMENT ON INDEX autoidx_t_id IS 'second'" },
  { sql: rows, query: true },
  { sql: "SELECT count(*) AS n FROM pg_description WHERE description IN ('first', 'second')", query: true },
  { sql: "COMMENT ON INDEX autoidx_t_id IS NULL" },
  { sql: rows, query: true },
  { sql: comments, query: true },
  { sql: "COMMENT ON INDEX autoidx_t_id IS 'third'" },
  { sql: "COMMENT ON INDEX autoidx_t_id IS ''" },
  { sql: rows, query: true },
  // clearing a comment that is not there is not an error
  { sql: "COMMENT ON INDEX autoidx_t_id IS NULL" },
]);

// --- 3. dropping the index removes its comment; the name does not bring it back ---

sequenceParity("DROP INDEX removes the comment and a new index of the same name starts without one", indexed, [
  { sql: "COMMENT ON INDEX autoidx_t_id IS 'managed index'" },
  { sql: "DROP INDEX autoidx_t_id" },
  { sql: "SELECT count(*) AS n FROM pg_description WHERE description = 'managed index'", query: true },
  { sql: "CREATE INDEX autoidx_t_id ON t (id)" },
  { sql: comments, query: true },
  { sql: rows, query: true },
]);

sequenceParity(
  "dropping the table or the schema removes the comments of its indexes",
  [],
  [
    { sql: "CREATE SCHEMA app" },
    { sql: "CREATE TABLE t (id integer)" },
    { sql: "CREATE TABLE app.t (id integer)" },
    { sql: "CREATE INDEX autoidx_a ON t (id)" },
    { sql: "CREATE INDEX autoidx_b ON app.t (id)" },
    { sql: "COMMENT ON INDEX autoidx_a IS 'a'" },
    { sql: "COMMENT ON INDEX app.autoidx_b IS 'b'" },
    { sql: rows, query: true },
    { sql: "DROP TABLE t" },
    { sql: rows, query: true },
    { sql: "DROP SCHEMA app CASCADE" },
    { sql: rows, query: true },
  ],
);

sequenceParity("a comment stays with its index through a rename", indexed, [
  { sql: "COMMENT ON INDEX autoidx_t_id IS 'kept'" },
  { sql: "ALTER INDEX autoidx_t_id RENAME TO autoidx_renamed" },
  { sql: rows, query: true },
  { sql: "ALTER TABLE t RENAME TO t2" },
  { sql: rows, query: true },
]);

sequenceParity("the index behind a PRIMARY KEY takes a comment like any other", indexed, [
  { sql: "COMMENT ON INDEX t_pkey IS 'primary key index'" },
  { sql: rows, query: true },
  { sql: "ALTER TABLE t RENAME CONSTRAINT t_pkey TO t_primary" },
  { sql: rows, query: true },
  { sql: "ALTER TABLE t DROP CONSTRAINT t_primary" },
  { sql: rows, query: true },
]);

// --- 4. transactions, and a missing target ---

sequenceParity("a comment made in a rolled-back transaction is gone; a committed one stays", indexed, [
  { sql: "COMMENT ON INDEX autoidx_t_id IS 'before'" },
  { sql: "BEGIN" },
  { sql: "COMMENT ON INDEX autoidx_t_id IS 'inside'" },
  { sql: rows, query: true },
  { sql: "ROLLBACK" },
  { sql: rows, query: true },
  { sql: "BEGIN" },
  { sql: "COMMENT ON INDEX autoidx_t_id IS NULL" },
  { sql: "ROLLBACK" },
  { sql: rows, query: true },
  { sql: "BEGIN" },
  { sql: "COMMENT ON INDEX autoidx_t_id IS 'committed'" },
  { sql: "COMMIT" },
  { sql: rows, query: true },
]);

sequenceParity("ROLLBACK TO SAVEPOINT restores the comment as of the savepoint", indexed, [
  { sql: "BEGIN" },
  { sql: "COMMENT ON INDEX autoidx_t_id IS 'outer'" },
  { sql: "SAVEPOINT s" },
  { sql: "COMMENT ON INDEX autoidx_t_id IS 'inner'" },
  { sql: "ROLLBACK TO SAVEPOINT s" },
  { sql: rows, query: true },
  { sql: "COMMIT" },
  { sql: rows, query: true },
]);

sequenceParity(
  "an index created and commented in a rolled-back transaction leaves nothing behind",
  ["CREATE TABLE t (id integer)"],
  [
    { sql: "BEGIN" },
    { sql: "CREATE INDEX autoidx_t_id ON t (id)" },
    { sql: "COMMENT ON INDEX autoidx_t_id IS 'inside'" },
    { sql: "ROLLBACK" },
    { sql: "SELECT count(*) AS n FROM pg_description WHERE description = 'inside'", query: true },
    { sql: "CREATE INDEX autoidx_t_id ON t (id)" },
    { sql: comments, query: true },
  ],
);

errorParity("a missing index is 42P01", indexed, "COMMENT ON INDEX missing_idx IS 'x'", "undefined_table", A);
errorParity(
  "a missing index in an existing schema is 42P01",
  indexed,
  "COMMENT ON INDEX public.missing_idx IS 'x'",
  "undefined_table",
  A,
);
errorParity(
  "clearing the comment of a missing index is 42P01 too",
  indexed,
  "COMMENT ON INDEX missing_idx IS NULL",
  "undefined_table",
  A,
);
errorParity("a missing schema is 3F000", indexed, "COMMENT ON INDEX nope.autoidx_t_id IS 'x'", undefined, A);
errorParity("a table is not an index", indexed, "COMMENT ON INDEX t IS 'x'", undefined, A);

sequenceParity(
  "an index outside the search path needs its schema",
  ["CREATE SCHEMA app", "CREATE TABLE app.t (id integer)", "CREATE INDEX autoidx_app ON app.t (id)"],
  [
    { sql: "COMMENT ON INDEX autoidx_app IS 'x'" },
    { sql: "SET search_path = app" },
    { sql: "COMMENT ON INDEX autoidx_app IS 'found'" },
    { sql: "SET search_path = public" },
    { sql: rows, query: true },
  ],
);

test("index comments are part of a snapshot and of every branch opened from it", () => {
  const db = new Database();
  let restored: Database | undefined;
  let branch: Database | undefined;
  try {
    db.exec("CREATE TABLE t (id integer PRIMARY KEY); CREATE INDEX autoidx_t_id ON t (id)");
    db.exec("COMMENT ON INDEX autoidx_t_id IS 'managed index'; COMMENT ON INDEX t_pkey IS 'primary'");
    const before = db.query(rows);
    expect(before).toEqual([
      { relname: "autoidx_t_id", description: "managed index" },
      { relname: "t_pkey", description: "primary" },
    ]);
    const snapshot = db.snapshot();
    restored = Snapshot.decode(snapshot.encode()).open();
    expect(restored.query(rows)).toEqual(before);
    // a branch has its own comments: changing one side leaves the other alone
    branch = db.branch(snapshot);
    branch.exec("COMMENT ON INDEX autoidx_t_id IS 'branch only'");
    db.exec("COMMENT ON INDEX t_pkey IS NULL");
    expect(branch.query(rows)).toEqual([
      { relname: "autoidx_t_id", description: "branch only" },
      { relname: "t_pkey", description: "primary" },
    ]);
    expect(db.query(rows)).toEqual([{ relname: "autoidx_t_id", description: "managed index" }]);
    expect(restored.query(rows)).toEqual(before);
  } finally {
    branch?.close();
    restored?.close();
    db.close();
  }
});

test("a database with equal comments encodes to the same bytes however it got them", () => {
  const direct = new Database();
  const edited = new Database();
  try {
    const schema = "CREATE TABLE t (id integer); CREATE INDEX autoidx_t_id ON t (id); ";
    direct.exec(`${schema}COMMENT ON INDEX autoidx_t_id IS 'final'`);
    edited.exec(`${schema}COMMENT ON INDEX autoidx_t_id IS 'draft'`);
    edited.exec("COMMENT ON INDEX autoidx_t_id IS NULL; COMMENT ON INDEX autoidx_t_id IS 'final'");
    expect(edited.snapshot().encode()).toEqual(direct.snapshot().encode());
  } finally {
    direct.close();
    edited.close();
  }
});
