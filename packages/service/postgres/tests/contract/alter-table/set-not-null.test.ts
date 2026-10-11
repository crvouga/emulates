import { errorParity, sequenceParity } from "../helpers.ts";

// ALTER TABLE ... ALTER COLUMN ... SET / DROP NOT NULL (issue #318).

const NULLABLE =
  "SELECT column_name, is_nullable FROM information_schema.columns WHERE table_name = 'example' ORDER BY ordinal_position";
const ATTNOTNULL =
  "SELECT a.attname, a.attnotnull FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid " +
  "WHERE c.relname = 'example' AND a.attnum > 0 ORDER BY a.attnum";
const ROWS = "SELECT id, body FROM example ORDER BY id";
const NOT_NULL_CONSTRAINTS =
  "SELECT con.conname, con.contype FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid " +
  "WHERE c.relname = 'example' AND con.contype = 'n' ORDER BY con.conname";

// Behavior 1: no NULLs present -> succeeds, catalogs flip, later NULL writes fail with 23502.
sequenceParity(
  "SET NOT NULL on a column without NULLs updates the catalogs and rejects NULL writes",
  ["CREATE TABLE example (id int, body text)", "INSERT INTO example VALUES (1, 'a'), (2, 'b')"],
  [
    { sql: NULLABLE, query: true },
    { sql: "ALTER TABLE example ALTER COLUMN body SET NOT NULL" },
    { sql: NULLABLE, query: true },
    { sql: ATTNOTNULL, query: true },
    { sql: "INSERT INTO example VALUES (3, NULL)" },
    { sql: "INSERT INTO example (id) VALUES (3)" },
    { sql: "UPDATE example SET body = NULL WHERE id = 1" },
    { sql: "INSERT INTO example VALUES (3, 'c')" },
    { sql: ROWS, query: true },
  ],
  { compareFinalState: true },
);

sequenceParity(
  "pg_constraint gains and loses the not-null constraint with SET / DROP NOT NULL",
  ["CREATE TABLE example (id int PRIMARY KEY, body text)"],
  [
    { sql: NOT_NULL_CONSTRAINTS, query: true },
    { sql: "ALTER TABLE example ALTER COLUMN body SET NOT NULL" },
    { sql: NOT_NULL_CONSTRAINTS, query: true },
    { sql: "ALTER TABLE example ALTER COLUMN body DROP NOT NULL" },
    { sql: NOT_NULL_CONSTRAINTS, query: true },
  ],
);

errorParity(
  "INSERT of NULL after SET NOT NULL is a not-null violation",
  ["CREATE TABLE example (id int, body text)", "ALTER TABLE example ALTER COLUMN body SET NOT NULL"],
  "INSERT INTO example VALUES (1, NULL)",
  "constraint_notnull",
  { messageTier: "A" },
);

errorParity(
  "UPDATE to NULL after SET NOT NULL is a not-null violation",
  [
    "CREATE TABLE example (id int, body text)",
    "INSERT INTO example VALUES (1, 'a')",
    "ALTER TABLE example ALTER COLUMN body SET NOT NULL",
  ],
  "UPDATE example SET body = NULL",
  "constraint_notnull",
  { messageTier: "A" },
);

// Behavior 2: existing NULLs -> PostgreSQL's 23502, nothing changes.
errorParity(
  "SET NOT NULL with existing NULLs fails with PostgreSQL's SQLSTATE and message",
  ["CREATE TABLE example (id int, body text)", "INSERT INTO example VALUES (1, 'a'), (2, NULL)"],
  "ALTER TABLE example ALTER COLUMN body SET NOT NULL",
  "constraint_notnull",
  { messageTier: "A" },
);

sequenceParity(
  "a failed SET NOT NULL leaves the schema and the data unchanged",
  ["CREATE TABLE example (id int, body text)", "INSERT INTO example VALUES (1, 'a'), (2, NULL)"],
  [
    { sql: "ALTER TABLE example ALTER COLUMN body SET NOT NULL" },
    { sql: NULLABLE, query: true },
    { sql: ATTNOTNULL, query: true },
    { sql: ROWS, query: true },
    { sql: "INSERT INTO example VALUES (3, NULL)" },
    { sql: ROWS, query: true },
  ],
  { compareFinalState: true },
);

sequenceParity(
  "a multi-action ALTER TABLE whose later SET NOT NULL fails applies none of its actions",
  ["CREATE TABLE example (id int, body text, note text)", "INSERT INTO example VALUES (1, 'a', NULL)"],
  [
    {
      sql: "ALTER TABLE example ALTER COLUMN body SET NOT NULL, ALTER COLUMN id SET DEFAULT 9, ALTER COLUMN note SET NOT NULL",
    },
    { sql: NULLABLE, query: true },
    { sql: "INSERT INTO example (body) VALUES (NULL)" },
    { sql: "SELECT id, body, note FROM example ORDER BY id NULLS LAST", query: true },
  ],
  { compareFinalState: true },
);

sequenceParity(
  "a failed ADD COLUMN ... NOT NULL leaves no column behind",
  ["CREATE TABLE example (id int, body text)", "INSERT INTO example VALUES (1, 'a')"],
  [
    { sql: "ALTER TABLE example ADD COLUMN note text NOT NULL" },
    { sql: NULLABLE, query: true },
    { sql: "SELECT * FROM example", query: true },
    { sql: "ALTER TABLE example ADD COLUMN note text NOT NULL DEFAULT 'n'" },
    { sql: NULLABLE, query: true },
    { sql: "SELECT * FROM example", query: true },
  ],
  { compareFinalState: true },
);

// Behavior 3: DROP NOT NULL reverses it; repeating either form is a no-op success.
sequenceParity(
  "DROP NOT NULL reverses SET NOT NULL and both forms are repeatable",
  ["CREATE TABLE example (id int, body text)"],
  [
    { sql: "ALTER TABLE example ALTER COLUMN body SET NOT NULL" },
    { sql: "ALTER TABLE example ALTER COLUMN body SET NOT NULL" },
    { sql: NULLABLE, query: true },
    { sql: "INSERT INTO example VALUES (1, NULL)" },
    { sql: "ALTER TABLE example ALTER COLUMN body DROP NOT NULL" },
    { sql: NULLABLE, query: true },
    { sql: ATTNOTNULL, query: true },
    { sql: "INSERT INTO example VALUES (1, NULL)" },
    { sql: "ALTER TABLE example ALTER COLUMN body DROP NOT NULL" },
    { sql: "ALTER TABLE example ALTER body SET NOT NULL" },
    { sql: "UPDATE example SET body = 'filled'" },
    { sql: "ALTER TABLE example ALTER body SET NOT NULL" },
    { sql: NULLABLE, query: true },
    { sql: ROWS, query: true },
  ],
  { compareFinalState: true },
);

sequenceParity(
  "several SET / DROP NOT NULL actions in one ALTER TABLE apply together",
  ["CREATE TABLE example (id int NOT NULL, body text, note text)"],
  [
    {
      sql: "ALTER TABLE example ALTER COLUMN body SET NOT NULL, ALTER COLUMN note SET NOT NULL, ALTER COLUMN id DROP NOT NULL",
    },
    { sql: NULLABLE, query: true },
    { sql: "INSERT INTO example VALUES (NULL, 'b', 'n')" },
    { sql: "INSERT INTO example VALUES (1, 'b', NULL)" },
  ],
  { compareFinalState: true },
);

errorParity(
  "DROP NOT NULL on a primary-key column is rejected",
  ["CREATE TABLE example (id int PRIMARY KEY, body text)"],
  "ALTER TABLE example ALTER COLUMN id DROP NOT NULL",
  undefined,
  { messageTier: "A" },
);

errorParity(
  "DROP NOT NULL on an identity column is rejected",
  ["CREATE TABLE example (id int GENERATED ALWAYS AS IDENTITY, body text)"],
  "ALTER TABLE example ALTER COLUMN id DROP NOT NULL",
  undefined,
  { messageTier: "A" },
);

sequenceParity(
  "a rejected DROP NOT NULL keeps the column NOT NULL",
  [
    "CREATE TABLE example (id int PRIMARY KEY, body text)",
    "CREATE TABLE ident (id int GENERATED BY DEFAULT AS IDENTITY, body text)",
  ],
  [
    { sql: "ALTER TABLE example ALTER COLUMN id DROP NOT NULL" },
    { sql: "ALTER TABLE ident ALTER COLUMN id DROP NOT NULL" },
    { sql: NULLABLE, query: true },
    {
      sql: "SELECT column_name, is_nullable FROM information_schema.columns WHERE table_name = 'ident' ORDER BY ordinal_position",
      query: true,
    },
    { sql: "INSERT INTO example VALUES (NULL, 'x')" },
    { sql: "INSERT INTO ident VALUES (NULL, 'x')" },
  ],
);

errorParity(
  "SET NOT NULL on a missing column",
  ["CREATE TABLE example (id int, body text)"],
  "ALTER TABLE example ALTER COLUMN ghost SET NOT NULL",
  "undefined_column",
  { messageTier: "A" },
);

errorParity(
  "DROP NOT NULL on a missing column",
  ["CREATE TABLE example (id int, body text)"],
  "ALTER TABLE example ALTER COLUMN ghost DROP NOT NULL",
  "undefined_column",
  { messageTier: "A" },
);

errorParity(
  "SET NOT NULL on a missing table",
  [],
  "ALTER TABLE ghost ALTER COLUMN body SET NOT NULL",
  "undefined_table",
  {
    messageTier: "A",
  },
);

sequenceParity(
  "ALTER TABLE IF EXISTS on a missing table is a no-op for SET / DROP NOT NULL",
  [],
  [
    { sql: "ALTER TABLE IF EXISTS ghost ALTER COLUMN body SET NOT NULL" },
    { sql: "ALTER TABLE IF EXISTS ghost ALTER COLUMN body DROP NOT NULL" },
  ],
);

errorParity(
  "SET NOT NULL cannot be performed on a view",
  ["CREATE TABLE example (id int, body text)", "CREATE VIEW example_view AS SELECT id, body FROM example"],
  "ALTER TABLE example_view ALTER COLUMN body SET NOT NULL",
  undefined,
  { messageTier: "A" },
);

errorParity(
  "DROP NOT NULL cannot be performed on a view",
  ["CREATE TABLE example (id int, body text)", "CREATE VIEW example_view AS SELECT id, body FROM example"],
  "ALTER TABLE example_view ALTER COLUMN body DROP NOT NULL",
  undefined,
  { messageTier: "A" },
);

// Behavior 4: rollback / savepoints restore data and constraint state; quoted identifiers.
sequenceParity(
  "ROLLBACK restores both the data and the NOT NULL state",
  ["CREATE TABLE example (id int, body text)", "INSERT INTO example VALUES (1, 'a')"],
  [
    { sql: "BEGIN" },
    { sql: "ALTER TABLE example ALTER COLUMN body SET NOT NULL" },
    { sql: "INSERT INTO example VALUES (2, 'b')" },
    { sql: NULLABLE, query: true },
    { sql: "ROLLBACK" },
    { sql: NULLABLE, query: true },
    { sql: ATTNOTNULL, query: true },
    { sql: ROWS, query: true },
    { sql: "INSERT INTO example VALUES (3, NULL)" },
    { sql: ROWS, query: true },
  ],
  { compareFinalState: true },
);

sequenceParity(
  "ROLLBACK restores a dropped NOT NULL constraint",
  ["CREATE TABLE example (id int, body text NOT NULL)", "INSERT INTO example VALUES (1, 'a')"],
  [
    { sql: "BEGIN" },
    { sql: "ALTER TABLE example ALTER COLUMN body DROP NOT NULL" },
    { sql: "INSERT INTO example VALUES (2, NULL)" },
    { sql: ROWS, query: true },
    { sql: "ROLLBACK" },
    { sql: NULLABLE, query: true },
    { sql: ROWS, query: true },
    { sql: "INSERT INTO example VALUES (2, NULL)" },
  ],
  { compareFinalState: true },
);

sequenceParity(
  "ROLLBACK TO SAVEPOINT restores the constraint state at the savepoint, RELEASE keeps it",
  ["CREATE TABLE example (id int, body text)", "INSERT INTO example VALUES (1, 'a')"],
  [
    { sql: "BEGIN" },
    { sql: "SAVEPOINT before_constraint" },
    { sql: "ALTER TABLE example ALTER COLUMN body SET NOT NULL" },
    { sql: "INSERT INTO example VALUES (2, 'b')" },
    { sql: NULLABLE, query: true },
    { sql: "ROLLBACK TO SAVEPOINT before_constraint" },
    { sql: NULLABLE, query: true },
    { sql: ROWS, query: true },
    { sql: "INSERT INTO example VALUES (3, NULL)" },
    { sql: "UPDATE example SET body = 'c' WHERE id = 3" },
    { sql: "ALTER TABLE example ALTER COLUMN body SET NOT NULL" },
    { sql: "SAVEPOINT constrained" },
    { sql: "ALTER TABLE example ALTER COLUMN body DROP NOT NULL" },
    { sql: "INSERT INTO example VALUES (4, NULL)" },
    { sql: "ROLLBACK TO constrained" },
    { sql: "SAVEPOINT kept" },
    { sql: "ALTER TABLE example ALTER COLUMN id SET NOT NULL" },
    { sql: "RELEASE SAVEPOINT kept" },
    { sql: "COMMIT" },
    { sql: NULLABLE, query: true },
    { sql: ROWS, query: true },
    { sql: "INSERT INTO example VALUES (5, NULL)" },
    { sql: "INSERT INTO example VALUES (NULL, 'x')" },
  ],
  { compareFinalState: true },
);

const QUOTED_NULLABLE =
  "SELECT column_name, is_nullable FROM information_schema.columns WHERE table_name = 'Mixed Table' ORDER BY ordinal_position";

sequenceParity(
  "quoted table and column identifiers are honored case-sensitively",
  ['CREATE TABLE "Mixed Table" ("Body Col" text, body text, "select" text)'],
  [
    { sql: 'ALTER TABLE "Mixed Table" ALTER COLUMN "Body Col" SET NOT NULL' },
    { sql: 'ALTER TABLE public."Mixed Table" ALTER COLUMN "select" SET NOT NULL' },
    { sql: QUOTED_NULLABLE, query: true },
    { sql: `INSERT INTO "Mixed Table" VALUES (NULL, 'x', 's')` },
    { sql: `INSERT INTO "Mixed Table" VALUES ('x', NULL, 's')` },
    { sql: 'ALTER TABLE "Mixed Table" ALTER COLUMN "body col" SET NOT NULL' },
    { sql: 'ALTER TABLE "mixed table" ALTER COLUMN body SET NOT NULL' },
    { sql: 'ALTER TABLE "Mixed Table" ALTER COLUMN BODY SET NOT NULL' },
    { sql: 'ALTER TABLE "Mixed Table" ALTER COLUMN "Body Col" DROP NOT NULL' },
    { sql: QUOTED_NULLABLE, query: true },
    { sql: `INSERT INTO "Mixed Table" VALUES (NULL, NULL, 's')` },
  ],
  { compareFinalState: true },
);

sequenceParity(
  "SET NOT NULL applies to a schema-qualified table and to a temporary table",
  [
    "CREATE SCHEMA app",
    "CREATE TABLE app.example (id int, body text)",
    "CREATE TEMP TABLE tmp_snn_scratch (body text)",
  ],
  [
    { sql: "ALTER TABLE app.example ALTER COLUMN body SET NOT NULL" },
    { sql: "ALTER TABLE tmp_snn_scratch ALTER COLUMN body SET NOT NULL" },
    {
      sql: "SELECT table_schema, column_name, is_nullable FROM information_schema.columns WHERE table_name = 'example' ORDER BY ordinal_position",
      query: true,
    },
    { sql: "INSERT INTO app.example VALUES (1, NULL)" },
    { sql: "INSERT INTO tmp_snn_scratch VALUES (NULL)" },
    // the oracle session is shared and keeps pg_temp across tests
    { sql: "DROP TABLE tmp_snn_scratch" },
  ],
);
