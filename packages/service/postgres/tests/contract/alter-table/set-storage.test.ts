import { expect, test } from "bun:test";
import { Database } from "../../../src/index.ts";
import { expectParity } from "../../harness/assert.ts";
import { matrixBoth } from "../../harness/matrix.ts";
import { errorParity, parity, sequenceParity, setupBoth } from "../helpers.ts";
import { sqlstateParity } from "../parity-extras.ts";

// ALTER TABLE ... ALTER COLUMN ... SET STORAGE and pg_attribute.attstorage (issue #332).
// Only the SQL and catalog contract is modelled: values are never compressed or moved out of line.

const storageOf = (...tables: string[]): string =>
  "SELECT c.relname, a.attname, a.attstorage FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid " +
  `WHERE c.relname IN (${tables.map((t) => `'${t}'`).join(", ")}) AND a.attnum > 0 ORDER BY c.relname, a.attnum`;
const STORAGE = storageOf("kv");

// Behavior 1: the statement runs and the catalog reflects it.
parity(
  "attstorage defaults follow each column type's storage strategy",
  [
    "CREATE TYPE mood AS ENUM ('sad', 'ok')",
    "CREATE DOMAIN label AS text",
    "CREATE DOMAIN quantity AS int",
    `CREATE TABLE kv (
       c_int2 smallint, c_int4 integer, c_int8 bigint, c_serial serial, c_bool boolean, c_float4 real, c_float8 float8,
       c_numeric numeric, c_numeric_mod numeric(10,2), c_money money, c_text text, c_varchar varchar(10),
       c_bpchar char(3), c_name name, c_bytea bytea, c_date date, c_time time, c_timetz timetz, c_timestamp timestamp,
       c_timestamptz timestamptz, c_interval interval, c_uuid uuid, c_json json, c_jsonb jsonb, c_oid oid,
       c_tsvector tsvector, c_tsquery tsquery, c_bit bit(3), c_varbit varbit, c_int_array int[], c_text_array text[],
       c_enum mood, c_text_domain label, c_int_domain quantity
     )`,
  ],
  STORAGE,
);

sequenceParity(
  "SET STORAGE accepts PLAIN, EXTERNAL, EXTENDED, MAIN and DEFAULT, and attstorage reflects each",
  ["CREATE TABLE kv (id integer, value text, amount numeric, doc jsonb)", "INSERT INTO kv VALUES (1, 'v', 1.5, '{}')"],
  [
    { sql: STORAGE, query: true },
    { sql: "ALTER TABLE kv ALTER COLUMN value SET STORAGE MAIN" },
    { sql: STORAGE, query: true },
    { sql: "ALTER TABLE kv ALTER COLUMN value SET STORAGE PLAIN" },
    { sql: STORAGE, query: true },
    { sql: "ALTER TABLE kv ALTER COLUMN value SET STORAGE EXTERNAL" },
    { sql: STORAGE, query: true },
    { sql: "ALTER TABLE kv ALTER COLUMN value SET STORAGE EXTENDED" },
    { sql: STORAGE, query: true },
    { sql: "ALTER TABLE kv ALTER COLUMN amount SET STORAGE EXTERNAL" },
    { sql: "ALTER TABLE kv ALTER COLUMN doc SET STORAGE main" },
    { sql: STORAGE, query: true },
    { sql: "ALTER TABLE kv ALTER COLUMN amount SET STORAGE DEFAULT" },
    { sql: "ALTER TABLE kv ALTER COLUMN doc SET STORAGE DEFAULT" },
    { sql: "ALTER TABLE kv ALTER COLUMN id SET STORAGE PLAIN" },
    { sql: "ALTER TABLE kv ALTER COLUMN id SET STORAGE DEFAULT" },
    { sql: STORAGE, query: true },
    { sql: "INSERT INTO kv VALUES (2, 'w', 2.5, '[]')" },
    { sql: "SELECT id, value, amount, doc FROM kv ORDER BY id", query: true },
  ],
  { compareFinalState: true },
);

sequenceParity(
  "the storage keyword is an identifier: any case, quoted or not",
  ['CREATE TABLE kv (id integer, value text, "Quoted Col" jsonb)'],
  [
    { sql: 'ALTER TABLE kv ALTER COLUMN "Quoted Col" SET STORAGE External' },
    { sql: 'ALTER TABLE kv ALTER value SET STORAGE "MAIN"' },
    { sql: STORAGE, query: true },
    { sql: 'ALTER TABLE kv ALTER "Quoted Col" SET STORAGE "plain"' },
    { sql: STORAGE, query: true },
  ],
);

sqlstateParity(
  "a string literal is not a storage keyword",
  ["CREATE TABLE kv (id integer, value text)"],
  "ALTER TABLE kv ALTER COLUMN value SET STORAGE 'main'",
  "42601",
);

sqlstateParity(
  "SET STORAGE without a keyword is a syntax error",
  ["CREATE TABLE kv (id integer, value text)"],
  "ALTER TABLE kv ALTER COLUMN value SET STORAGE",
  "42601",
);

sequenceParity(
  "several SET STORAGE actions in one ALTER TABLE apply together, with other actions",
  ["CREATE TABLE kv (id integer, value text, amount numeric)"],
  [
    {
      sql: "ALTER TABLE kv ALTER COLUMN value SET STORAGE MAIN, ALTER COLUMN amount SET STORAGE PLAIN, ALTER COLUMN id SET NOT NULL",
    },
    { sql: STORAGE, query: true },
    { sql: "ALTER TABLE kv ALTER COLUMN value SET STORAGE MAIN" },
    { sql: STORAGE, query: true },
  ],
);

sequenceParity(
  "a STORAGE clause in CREATE TABLE and ADD COLUMN sets attstorage",
  [
    "CREATE TABLE kv (id integer, value text STORAGE EXTERNAL, amount numeric STORAGE PLAIN, note text STORAGE DEFAULT)",
  ],
  [
    { sql: STORAGE, query: true },
    { sql: "ALTER TABLE kv ADD COLUMN extra text STORAGE MAIN" },
    { sql: "ALTER TABLE kv ADD COLUMN doc jsonb" },
    { sql: STORAGE, query: true },
    { sql: "CREATE TABLE bad_fixed (id integer STORAGE MAIN)" },
    { sql: "CREATE TABLE bad_mode (value text STORAGE bogus)" },
    { sql: "ALTER TABLE kv ADD COLUMN n integer STORAGE EXTERNAL" },
    { sql: "SELECT count(*) AS n FROM pg_class WHERE relname IN ('bad_fixed', 'bad_mode')", query: true },
    { sql: STORAGE, query: true },
  ],
);

sequenceParity(
  "changing a column's type resets its storage to the new type's default; a rename keeps it",
  ["CREATE TABLE kv (id integer, value text STORAGE EXTERNAL, amount numeric STORAGE PLAIN, note text STORAGE MAIN)"],
  [
    { sql: "ALTER TABLE kv ALTER COLUMN value TYPE varchar(20)" },
    { sql: "ALTER TABLE kv ALTER COLUMN amount TYPE text" },
    { sql: "ALTER TABLE kv ALTER COLUMN id TYPE text" },
    { sql: "ALTER TABLE kv RENAME COLUMN note TO remark" },
    { sql: STORAGE, query: true },
    { sql: "ALTER TABLE kv ALTER COLUMN amount TYPE integer USING 1" },
    { sql: STORAGE, query: true },
  ],
);

sequenceParity(
  "LIKE copies storage only with INCLUDING STORAGE or INCLUDING ALL; CREATE TABLE AS starts from type defaults",
  ["CREATE TABLE kv (id integer, value text STORAGE MAIN, amount numeric STORAGE EXTERNAL)"],
  [
    { sql: "CREATE TABLE plain_copy (LIKE kv)" },
    { sql: "CREATE TABLE storage_copy (LIKE kv INCLUDING STORAGE)" },
    { sql: "CREATE TABLE full_copy (LIKE kv INCLUDING ALL)" },
    { sql: "CREATE TABLE selected AS SELECT * FROM kv" },
    { sql: storageOf("plain_copy", "storage_copy", "full_copy", "selected"), query: true },
  ],
);

sequenceParity(
  "SET STORAGE applies to temporary and schema-qualified tables",
  [
    "CREATE SCHEMA app",
    "CREATE TABLE app.kv (id integer, value text)",
    "CREATE TEMP TABLE tmp_sst_scratch (value text)",
  ],
  [
    { sql: "ALTER TABLE app.kv ALTER COLUMN value SET STORAGE EXTERNAL" },
    { sql: "ALTER TABLE tmp_sst_scratch ALTER COLUMN value SET STORAGE MAIN" },
    { sql: storageOf("kv", "tmp_sst_scratch"), query: true },
    // the oracle session is shared and keeps pg_temp across tests
    { sql: "DROP TABLE tmp_sst_scratch" },
  ],
);

// Behavior 2: invalid targets and modes get PostgreSQL's error.
const REJECTED: ReadonlyArray<readonly [name: string, sql: string]> = [
  ["MAIN on a fixed-length integer column", "ALTER TABLE kv ALTER COLUMN id SET STORAGE MAIN"],
  ["EXTERNAL on a fixed-length integer column", "ALTER TABLE kv ALTER COLUMN id SET STORAGE EXTERNAL"],
  ["EXTENDED on a fixed-length integer column", "ALTER TABLE kv ALTER COLUMN id SET STORAGE EXTENDED"],
  ["EXTENDED on a boolean column", "ALTER TABLE kv ALTER COLUMN flag SET STORAGE EXTENDED"],
  ["MAIN on a timestamp column", "ALTER TABLE kv ALTER COLUMN seen SET STORAGE MAIN"],
  ["MAIN on a uuid column", "ALTER TABLE kv ALTER COLUMN token SET STORAGE MAIN"],
  ["MAIN on an enum column", "ALTER TABLE kv ALTER COLUMN feeling SET STORAGE MAIN"],
  ["MAIN on a tsquery column", "ALTER TABLE kv ALTER COLUMN query SET STORAGE MAIN"],
  ["an unknown storage mode", "ALTER TABLE kv ALTER COLUMN value SET STORAGE bogus"],
  ["an unknown quoted storage mode", 'ALTER TABLE kv ALTER COLUMN value SET STORAGE "Bogus Mode"'],
  ["a missing column", "ALTER TABLE kv ALTER COLUMN missing SET STORAGE MAIN"],
  ["a missing column before an unknown mode", "ALTER TABLE kv ALTER COLUMN missing SET STORAGE bogus"],
  ["a system column", "ALTER TABLE kv ALTER COLUMN ctid SET STORAGE MAIN"],
  ["a missing table", "ALTER TABLE missing ALTER COLUMN value SET STORAGE MAIN"],
  ["a view", "ALTER TABLE kv_view ALTER COLUMN value SET STORAGE MAIN"],
];

for (const [name, sql] of REJECTED) {
  errorParity(
    `SET STORAGE rejects ${name}`,
    [
      "CREATE TYPE mood AS ENUM ('sad', 'ok')",
      "CREATE TABLE kv (id integer, value text, flag boolean, seen timestamptz, token uuid, feeling mood, query tsquery)",
      "CREATE VIEW kv_view AS SELECT id, value FROM kv",
    ],
    sql,
    undefined,
    { messageTier: "A" },
  );
}

sequenceParity(
  "a rejected SET STORAGE changes nothing, even when an earlier action of the statement was valid",
  ["CREATE TABLE kv (id integer, value text, amount numeric)"],
  [
    { sql: "ALTER TABLE kv ALTER COLUMN value SET STORAGE MAIN, ALTER COLUMN id SET STORAGE MAIN" },
    { sql: "ALTER TABLE kv ALTER COLUMN amount SET STORAGE EXTERNAL, ALTER COLUMN value SET STORAGE bogus" },
    { sql: "ALTER TABLE kv ALTER COLUMN value SET STORAGE MAIN, ALTER COLUMN missing SET STORAGE MAIN" },
    { sql: STORAGE, query: true },
    { sql: "ALTER TABLE IF EXISTS missing ALTER COLUMN value SET STORAGE MAIN" },
  ],
);

// Behavior 3: repeated reconciliation, rollback and snapshot reload keep the metadata.
sequenceParity(
  "repeating the same SET STORAGE is a no-op success",
  ["CREATE TABLE kv (id integer, value text)"],
  [
    { sql: "ALTER TABLE kv ALTER COLUMN value SET STORAGE MAIN" },
    { sql: "ALTER TABLE kv ALTER COLUMN value SET STORAGE MAIN" },
    { sql: "ALTER TABLE kv ALTER COLUMN value SET STORAGE MAIN" },
    { sql: STORAGE, query: true },
    { sql: "ALTER TABLE kv ALTER COLUMN value SET STORAGE EXTENDED" },
    { sql: "ALTER TABLE kv ALTER COLUMN value SET STORAGE EXTENDED" },
    { sql: STORAGE, query: true },
  ],
);

sequenceParity(
  "ROLLBACK and ROLLBACK TO SAVEPOINT restore the storage mode",
  ["CREATE TABLE kv (id integer, value text, amount numeric)"],
  [
    { sql: "BEGIN" },
    { sql: "ALTER TABLE kv ALTER COLUMN value SET STORAGE MAIN" },
    { sql: STORAGE, query: true },
    { sql: "ROLLBACK" },
    { sql: STORAGE, query: true },
    { sql: "BEGIN" },
    { sql: "ALTER TABLE kv ALTER COLUMN value SET STORAGE EXTERNAL" },
    { sql: "SAVEPOINT external" },
    { sql: "ALTER TABLE kv ALTER COLUMN value SET STORAGE PLAIN" },
    { sql: "ALTER TABLE kv ALTER COLUMN amount SET STORAGE PLAIN" },
    { sql: STORAGE, query: true },
    { sql: "ROLLBACK TO SAVEPOINT external" },
    { sql: STORAGE, query: true },
    { sql: "SAVEPOINT kept" },
    { sql: "ALTER TABLE kv ALTER COLUMN amount SET STORAGE EXTERNAL" },
    { sql: "RELEASE SAVEPOINT kept" },
    { sql: "COMMIT" },
    { sql: STORAGE, query: true },
  ],
);

matrixBoth("storage modes survive a snapshot reload", async (memory, postgres) => {
  await setupBoth(memory, postgres, [
    "CREATE TABLE kv (id integer, value text, amount numeric STORAGE EXTERNAL, doc jsonb, note text)",
    "INSERT INTO kv VALUES (1, 'v', 1.5, '{}', 'n')",
    "ALTER TABLE kv ALTER COLUMN value SET STORAGE MAIN",
    "ALTER TABLE kv ALTER COLUMN doc SET STORAGE PLAIN",
    "ALTER TABLE kv ALTER COLUMN note SET STORAGE MAIN",
    "ALTER TABLE kv ALTER COLUMN note SET STORAGE DEFAULT",
  ]);
  memory.restore(memory.snapshot());
  expectParity(await memory.query(STORAGE), await postgres.query(STORAGE));
  const alter = "ALTER TABLE kv ALTER COLUMN value SET STORAGE EXTERNAL";
  expectParity(await memory.exec(alter), await postgres.exec(alter), { ignoreWriteCounters: true });
  memory.restore(memory.snapshot());
  expectParity(await memory.query(STORAGE), await postgres.query(STORAGE));
  const rows = "SELECT id, value, amount, doc, note FROM kv";
  expectParity(await memory.query(rows), await postgres.query(rows));
});

test("a snapshot of tables with default storage carries no storage metadata", () => {
  const db = new Database();
  try {
    db.exec("CREATE TABLE kv (id integer, value text)");
    db.exec("ALTER TABLE kv ALTER COLUMN value SET STORAGE MAIN");
    db.exec("ALTER TABLE kv ALTER COLUMN value SET STORAGE DEFAULT");
    const plain = new Database();
    plain.exec("CREATE TABLE kv (id integer, value text)");
    // Returning to the type default leaves the same bytes as never having set a mode,
    // which is also what a snapshot written before storage modes existed looks like.
    expect(db.snapshot().encode()).toEqual(plain.snapshot().encode());
    plain.close();
  } finally {
    db.close();
  }
});

test("SET STORAGE on a materialized view fails loudly instead of being ignored", () => {
  const db = new Database();
  try {
    db.exec("CREATE TABLE kv (id integer, value text)");
    db.exec("CREATE MATERIALIZED VIEW kv_mat AS SELECT id, value FROM kv");
    // PostgreSQL accepts this; the engine keeps no per-column metadata for materialized views.
    expect(() => db.exec("ALTER TABLE kv_mat ALTER COLUMN value SET STORAGE MAIN")).toThrow(
      expect.objectContaining({ sqlState: "0A000" }),
    );
  } finally {
    db.close();
  }
});
