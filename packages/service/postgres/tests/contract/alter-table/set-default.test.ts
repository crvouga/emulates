import { expect, test } from "bun:test";
import { Database } from "../../../src/index.ts";
import { expectParity } from "../../harness/assert.ts";
import { matrixBoth } from "../../harness/matrix.ts";
import { errorParity, parity, sequenceParity, setupBoth } from "../helpers.ts";

// ALTER TABLE ... ALTER COLUMN ... SET / DROP DEFAULT (issue #319).

const DEFAULTS =
  "SELECT column_name, column_default FROM information_schema.columns WHERE table_name = 'example' ORDER BY ordinal_position";
const HASDEF =
  "SELECT a.attname, a.atthasdef FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid " +
  "WHERE c.relname = 'example' AND a.attnum > 0 ORDER BY a.attnum";

// Behavior 1: a constant or expression default is stored, and column_default shows it the way PostgreSQL renders it.
sequenceParity(
  "SET DEFAULT with constants of each common type is reflected in column_default",
  [
    "CREATE TYPE mood AS ENUM ('sad', 'ok')",
    "CREATE DOMAIN label AS text",
    `CREATE TABLE example (
       id int, n int, big bigint, small smallint, num numeric, money_like numeric(10,2), ratio float8,
       flag boolean, body text, code varchar(10), fixed char(3), day date, at timestamp, seen timestamptz,
       dur interval, token uuid, doc jsonb, raw json, bin bytea, ints int[], tags text[], feeling mood, tag label
     )`,
  ],
  [
    { sql: "ALTER TABLE example ALTER COLUMN n SET DEFAULT 7" },
    { sql: "ALTER TABLE example ALTER COLUMN big SET DEFAULT -5" },
    { sql: "ALTER TABLE example ALTER COLUMN small SET DEFAULT '5'" },
    { sql: "ALTER TABLE example ALTER COLUMN num SET DEFAULT 1.50" },
    { sql: "ALTER TABLE example ALTER COLUMN money_like SET DEFAULT '1.5'" },
    { sql: "ALTER TABLE example ALTER COLUMN ratio SET DEFAULT '1.5'" },
    { sql: "ALTER TABLE example ALTER COLUMN flag SET DEFAULT 'yes'" },
    { sql: "ALTER TABLE example ALTER COLUMN body SET DEFAULT 'it''s'" },
    { sql: "ALTER TABLE example ALTER COLUMN code SET DEFAULT 'abc'" },
    { sql: "ALTER TABLE example ALTER COLUMN fixed SET DEFAULT 'a'" },
    { sql: "ALTER TABLE example ALTER COLUMN day SET DEFAULT '2024-01-01'" },
    { sql: "ALTER TABLE example ALTER COLUMN at SET DEFAULT '2024-01-01'" },
    { sql: "ALTER TABLE example ALTER COLUMN seen SET DEFAULT '2024-01-01 00:00:00+00'" },
    { sql: "ALTER TABLE example ALTER COLUMN dur SET DEFAULT '1 hour'" },
    { sql: "ALTER TABLE example ALTER COLUMN token SET DEFAULT '00000000-0000-0000-0000-000000000000'" },
    { sql: `ALTER TABLE example ALTER COLUMN doc SET DEFAULT '{"a":1}'` },
    { sql: `ALTER TABLE example ALTER COLUMN raw SET DEFAULT '{"a":1}'` },
    { sql: "ALTER TABLE example ALTER COLUMN bin SET DEFAULT 'abc'" },
    { sql: "ALTER TABLE example ALTER COLUMN ints SET DEFAULT '{1,2}'" },
    { sql: "ALTER TABLE example ALTER COLUMN tags SET DEFAULT ARRAY['a', 'b']" },
    { sql: "ALTER TABLE example ALTER COLUMN feeling SET DEFAULT 'ok'" },
    { sql: "ALTER TABLE example ALTER COLUMN tag SET DEFAULT 'x'" },
    { sql: DEFAULTS, query: true },
    { sql: HASDEF, query: true },
    { sql: "INSERT INTO example (id) VALUES (1)" },
    { sql: "SELECT * FROM example", query: true },
  ],
  { compareFinalState: true },
);

/** [column type, default expression]: column_default must match PostgreSQL's rendering character for character. */
const RENDERINGS: ReadonlyArray<readonly [string, string]> = [
  ["int", "1 + 2"],
  ["int", "2 * (3 + 4)"],
  ["int", "-(1 + 2)"],
  ["int", "'-12'"],
  ["int", "5::int"],
  ["int", "length('abc')"],
  ["int", "3000000000 % 7"],
  ["int", "1 - -1"],
  ["int", "coalesce(NULL, 1)"],
  ["int", "greatest(1, 2)"],
  ["int", "nullif(1, 2)"],
  ["int", "abs(-5)"],
  ["int", "mod(5, 2)"],
  ["int", "extract(year from now())"],
  ["int", "position('b' in 'abc')"],
  ["bigint", "3000000000"],
  ["bigint", "-3000000000"],
  ["bigint", "5::bigint"],
  ["bigint", "1 + 3000000000"],
  ["bigint", "nextval('counter')"],
  ["bigint", "nextval('counter'::regclass)"],
  ["bigint", `nextval('app."Mixed Seq"')`],
  ["numeric", "1e3"],
  ["numeric", "-1.5"],
  ["numeric", "10 / 4.0"],
  ["numeric", "round(1.555, 2)"],
  ["numeric(10,2)", "1.5::numeric(10,2)"],
  ["float8", "1.5::float8"],
  ["float8", "random()"],
  ["float8", "power(2, 3)"],
  ["float8", "date_part('year', now())"],
  ["boolean", "NOT true"],
  ["boolean", "1 = 1"],
  ["boolean", "1 < 2 AND true"],
  ["boolean", "'a' = 'a'"],
  ["boolean", "1 IS NOT NULL"],
  ["boolean", "'a' LIKE 'a%'"],
  ["boolean", "1 IN (1, 2)"],
  ["boolean", "1 BETWEEN 0 AND 2"],
  ["text", "'x' || 'y'"],
  ["text", "'a' || 1"],
  ["text", "upper('abc')"],
  ["text", "lower('A') || 'b'"],
  ["text", "'abc'::varchar"],
  ["text", "5::text"],
  ["text", "now()::text"],
  ["text", "concat('a', 'b')"],
  ["text", "concat_ws('-', 'a', 'b')"],
  ["text", "format('%s', 'a')"],
  ["text", "coalesce('a', 'b')"],
  ["text", "CURRENT_USER"],
  ["text", "md5('a')"],
  ["text", "to_char(now(), 'YYYY')"],
  ["text", "repeat('ab', 3)"],
  ["text", "replace('abc', 'b', 'x')"],
  ["text", "left('abc', 1)"],
  ["text", "lpad('a', 3, 'x')"],
  ["text", "split_part('a,b', ',', 1)"],
  ["text", "array_to_string(ARRAY['a','b'], ',')"],
  ["text", "encode('abc'::bytea, 'hex')"],
  ["text", "current_setting('timezone')"],
  ["text", "pg_catalog.upper('a')"],
  ["text", "version()"],
  ["text", "substring('abc' from 2)"],
  ["text", "trim('  a ')"],
  ["text", "'a' COLLATE \"C\""],
  ["text", "CASE WHEN true THEN 'a' ELSE 'b' END"],
  ["text", `'{"a":1}'::jsonb ->> 'a'`],
  ["varchar(10)", "'abc'::varchar(10)"],
  ["varchar(10)", "'abc'::text"],
  ["varchar(10)", "upper('abc')"],
  ["date", "CURRENT_DATE"],
  ["date", "now()"],
  ["date", "now()::date"],
  ["date", "CURRENT_DATE + 7"],
  ["date", "'2024-01-01'::date + 1"],
  ["timestamp", "CURRENT_TIMESTAMP"],
  ["timestamp", "LOCALTIMESTAMP"],
  ["timestamp", "'2024-01-01 10:00'::timestamp"],
  ["timestamp", "now() AT TIME ZONE 'utc'"],
  ["timestamp", "timezone('utc', now())"],
  ["timestamptz", "now()"],
  ["timestamptz", "now() + interval '1 day'"],
  ["timestamptz", "now() + '1 day'"],
  ["timestamptz", "now() - interval '1 hour'"],
  ["timestamptz", "clock_timestamp()"],
  ["timestamptz", "date_trunc('day', now())"],
  ["timestamptz", "to_timestamp(0)"],
  ["timestamptz", "to_timestamp('2024', 'YYYY')"],
  ["timestamptz", "'epoch'"],
  ["timestamptz", "'infinity'"],
  ["time", "CURRENT_TIME"],
  ["time", "LOCALTIME"],
  ["time", "'10:00'"],
  ["interval", "now() - now()"],
  ["interval", "interval '1 day'"],
  ["uuid", "gen_random_uuid()"],
  ["jsonb", "'[]'::jsonb"],
  ["jsonb", "jsonb_build_object('a', 1)"],
  ["jsonb", "jsonb_build_array(1, 'a')"],
  ["jsonb", "to_jsonb(1)"],
  ["int[]", "ARRAY[1,2]"],
  ["int[]", "ARRAY[]::int[]"],
  ["int[]", "'{}'::int[]"],
  ["text[]", "'{}'"],
  ["text[]", "ARRAY[]::text[]"],
];

matrixBoth("column_default renders stored expressions the way PostgreSQL does", async (memory, postgres) => {
  const columns = RENDERINGS.map(([type], i) => `c${i} ${type}`).join(", ");
  await setupBoth(memory, postgres, [
    "CREATE SCHEMA app",
    "CREATE SEQUENCE counter",
    'CREATE SEQUENCE app."Mixed Seq"',
    `CREATE TABLE example (${columns})`,
  ]);
  for (const [i, [, expr]] of RENDERINGS.entries()) {
    const alter = `ALTER TABLE example ALTER COLUMN c${i} SET DEFAULT ${expr}`;
    const a = await memory.exec(alter);
    const b = await postgres.exec(alter);
    expect(a.ok, `memory: ${alter}: ${a.error?.message}`).toBe(true);
    expect(b.ok, `postgres: ${alter}: ${b.error?.message}`).toBe(true);
    const probe = `SELECT column_default FROM information_schema.columns WHERE table_name = 'example' AND column_name = 'c${i}'`;
    const rendered = await memory.query(probe);
    const expected = await postgres.query(probe);
    expect(rendered.values[0]?.[0], `rendering of ${expr}`).toBe(expected.values[0]?.[0] as string);
  }
});

sequenceParity(
  "column_default of a serial column and of a default set in CREATE TABLE use the same rendering",
  [
    "CREATE TABLE example (id serial, big bigserial, n int DEFAULT 1 + 2, body text DEFAULT 'x', at timestamptz DEFAULT now())",
  ],
  [{ sql: DEFAULTS, query: true }],
);

sequenceParity(
  "SET DEFAULT replaces an existing default, including one from CREATE TABLE",
  ["CREATE TABLE example (id int, v int DEFAULT 5)"],
  [
    { sql: "ALTER TABLE example ALTER COLUMN v SET DEFAULT 6" },
    { sql: "ALTER TABLE example ALTER v SET DEFAULT 7, ALTER COLUMN id SET DEFAULT 1" },
    { sql: DEFAULTS, query: true },
    { sql: "INSERT INTO example DEFAULT VALUES" },
    { sql: "SELECT id, v FROM example", query: true },
  ],
  { compareFinalState: true },
);

// Behavior 2: existing rows stay unchanged; an omitted column takes the default, an explicit NULL stays NULL.
sequenceParity(
  "existing rows are unchanged, omitted columns take the default, explicit NULL stays NULL",
  ["CREATE TABLE example (id int, v int, w text)", "INSERT INTO example (id) VALUES (1)"],
  [
    { sql: "ALTER TABLE example ALTER COLUMN v SET DEFAULT 7" },
    { sql: "ALTER TABLE example ALTER COLUMN w SET DEFAULT 'x' || 'y'" },
    { sql: "SELECT id, v, w FROM example ORDER BY id", query: true },
    { sql: "INSERT INTO example (id) VALUES (2)" },
    { sql: "INSERT INTO example (id, v, w) VALUES (3, NULL, NULL)" },
    { sql: "INSERT INTO example (id, v, w) VALUES (4, DEFAULT, DEFAULT)" },
    { sql: "INSERT INTO example (id, v) VALUES (5, 50)" },
    { sql: "UPDATE example SET v = DEFAULT WHERE id = 1" },
    { sql: "UPDATE example SET w = NULL WHERE id = 2" },
    { sql: "ALTER TABLE example ALTER COLUMN v SET DEFAULT 8" },
    { sql: "INSERT INTO example (id) VALUES (6)" },
    { sql: "SELECT id, v, w FROM example ORDER BY id", query: true },
  ],
  { compareFinalState: true },
);

sequenceParity(
  "an explicit NULL into a NOT NULL column is rejected even though the column has a default",
  ["CREATE TABLE example (id int, v int NOT NULL)"],
  [
    { sql: "ALTER TABLE example ALTER COLUMN v SET DEFAULT 7" },
    { sql: "INSERT INTO example (id, v) VALUES (1, NULL)" },
    { sql: "INSERT INTO example (id) VALUES (2)" },
    { sql: "SELECT id, v FROM example ORDER BY id", query: true },
  ],
  { compareFinalState: true },
);

sequenceParity(
  "SET DEFAULT NULL stores no default",
  ["CREATE TABLE example (id int, v int DEFAULT 5, w text DEFAULT 'w')"],
  [
    { sql: "ALTER TABLE example ALTER COLUMN v SET DEFAULT NULL" },
    { sql: "ALTER TABLE example ALTER COLUMN w SET DEFAULT NULL::text" },
    { sql: DEFAULTS, query: true },
    { sql: HASDEF, query: true },
    { sql: "INSERT INTO example (id) VALUES (1)" },
    { sql: "SELECT id, v, w FROM example", query: true },
  ],
  { compareFinalState: true },
);

// Behavior 3: DROP DEFAULT removes the expression; rollback and savepoints restore the prior default.
sequenceParity(
  "DROP DEFAULT removes the expression and is repeatable",
  ["CREATE TABLE example (id int, v int DEFAULT 5, s serial)"],
  [
    { sql: "ALTER TABLE example ALTER COLUMN v DROP DEFAULT" },
    { sql: "ALTER TABLE example ALTER COLUMN v DROP DEFAULT" },
    { sql: "ALTER TABLE example ALTER COLUMN id DROP DEFAULT" },
    { sql: DEFAULTS, query: true },
    { sql: HASDEF, query: true },
    { sql: "INSERT INTO example (id) VALUES (1)" },
    { sql: "SELECT id, v, s FROM example", query: true },
    { sql: "ALTER TABLE example ALTER COLUMN s DROP DEFAULT" },
    { sql: "INSERT INTO example (id) VALUES (2)" },
    { sql: DEFAULTS, query: true },
  ],
);

sequenceParity(
  "ROLLBACK restores the prior default",
  ["CREATE TABLE example (id int, v int DEFAULT 5)"],
  [
    { sql: "BEGIN" },
    { sql: "ALTER TABLE example ALTER COLUMN v SET DEFAULT 9" },
    { sql: "INSERT INTO example (id) VALUES (1)" },
    { sql: DEFAULTS, query: true },
    { sql: "SELECT id, v FROM example ORDER BY id", query: true },
    { sql: "ROLLBACK" },
    { sql: DEFAULTS, query: true },
    { sql: "INSERT INTO example (id) VALUES (2)" },
    { sql: "BEGIN" },
    { sql: "ALTER TABLE example ALTER COLUMN v DROP DEFAULT" },
    { sql: "INSERT INTO example (id) VALUES (3)" },
    { sql: "ROLLBACK" },
    { sql: DEFAULTS, query: true },
    { sql: "INSERT INTO example (id) VALUES (4)" },
    { sql: "SELECT id, v FROM example ORDER BY id", query: true },
  ],
  { compareFinalState: true },
);

sequenceParity(
  "ROLLBACK TO SAVEPOINT restores the default at the savepoint, RELEASE keeps the new one",
  ["CREATE TABLE example (id int, v int DEFAULT 5)"],
  [
    { sql: "BEGIN" },
    { sql: "ALTER TABLE example ALTER COLUMN v DROP DEFAULT" },
    { sql: "SAVEPOINT without_default" },
    { sql: "ALTER TABLE example ALTER COLUMN v SET DEFAULT 11" },
    { sql: "INSERT INTO example (id) VALUES (1)" },
    { sql: "ROLLBACK TO SAVEPOINT without_default" },
    { sql: DEFAULTS, query: true },
    { sql: "INSERT INTO example (id) VALUES (2)" },
    { sql: "SAVEPOINT kept" },
    { sql: "ALTER TABLE example ALTER COLUMN v SET DEFAULT 12" },
    { sql: "RELEASE SAVEPOINT kept" },
    { sql: "COMMIT" },
    { sql: DEFAULTS, query: true },
    { sql: "INSERT INTO example (id) VALUES (3)" },
    { sql: "SELECT id, v FROM example ORDER BY id", query: true },
  ],
  { compareFinalState: true },
);

// Behavior 4: now() defaults read the same clock as every other timestamp default.
sequenceParity(
  "a now() default set by ALTER agrees with one declared in CREATE TABLE",
  ["CREATE TABLE example (id int, declared timestamptz DEFAULT now(), altered timestamptz, day date)"],
  [
    { sql: "ALTER TABLE example ALTER COLUMN altered SET DEFAULT now()" },
    { sql: "ALTER TABLE example ALTER COLUMN day SET DEFAULT CURRENT_DATE" },
    { sql: DEFAULTS, query: true },
    { sql: "BEGIN" },
    { sql: "INSERT INTO example (id) VALUES (1)" },
    { sql: "INSERT INTO example (id) VALUES (2)" },
    {
      sql: "SELECT id, altered = declared AS same, altered = now() AS at_now, day = CURRENT_DATE AS today FROM example ORDER BY id",
      query: true,
    },
    { sql: "COMMIT" },
  ],
);

test("a now() default set by ALTER uses the injected clock", () => {
  const db = new Database({ now: new Date("2012-06-15T12:34:56.000Z") });
  try {
    db.exec("CREATE TABLE example (id int, declared timestamptz DEFAULT now(), altered timestamptz, day date)");
    db.exec("ALTER TABLE example ALTER COLUMN altered SET DEFAULT now()");
    db.exec("ALTER TABLE example ALTER COLUMN day SET DEFAULT CURRENT_DATE");
    db.exec("INSERT INTO example (id) VALUES (1)");
    expect(
      db.query("SELECT altered::text AS altered, declared::text AS declared, day::text AS day FROM example"),
    ).toEqual([{ altered: "2012-06-15 12:34:56+00", declared: "2012-06-15 12:34:56+00", day: "2012-06-15" }]);
  } finally {
    db.close();
  }
});

test("a now() default follows a clock function, and existing rows keep their values", () => {
  let current = new Date("2020-01-01T00:00:00.000Z");
  const db = new Database({ now: () => current });
  try {
    db.exec("CREATE TABLE example (id int, altered timestamptz)");
    db.exec("INSERT INTO example (id) VALUES (1)");
    db.exec("ALTER TABLE example ALTER COLUMN altered SET DEFAULT now()");
    db.exec("INSERT INTO example (id) VALUES (2)");
    current = new Date("2020-01-02T03:04:05.000Z");
    db.exec("INSERT INTO example (id) VALUES (3)");
    expect(db.query("SELECT id, altered::text AS altered FROM example ORDER BY id")).toEqual([
      { id: 1, altered: null },
      { id: 2, altered: "2020-01-01 00:00:00+00" },
      { id: 3, altered: "2020-01-02 03:04:05+00" },
    ]);
  } finally {
    db.close();
  }
});

// Targets and expressions PostgreSQL rejects.
errorParity(
  "SET DEFAULT on a missing column",
  ["CREATE TABLE example (id int)"],
  "ALTER TABLE example ALTER COLUMN ghost SET DEFAULT 1",
  "undefined_column",
  { messageTier: "A" },
);

errorParity(
  "DROP DEFAULT on a missing column",
  ["CREATE TABLE example (id int)"],
  "ALTER TABLE example ALTER COLUMN ghost DROP DEFAULT",
  "undefined_column",
  { messageTier: "A" },
);

errorParity("SET DEFAULT on a missing table", [], "ALTER TABLE ghost ALTER COLUMN v SET DEFAULT 1", "undefined_table", {
  messageTier: "A",
});

const REJECTED: ReadonlyArray<readonly [name: string, setup: string, sql: string]> = [
  [
    "a column reference",
    "CREATE TABLE example (id int, body text)",
    "ALTER TABLE example ALTER COLUMN body SET DEFAULT lower(body)",
  ],
  ["a subquery", "CREATE TABLE example (id int)", "ALTER TABLE example ALTER COLUMN id SET DEFAULT (SELECT 1)"],
  ["an aggregate", "CREATE TABLE example (id int)", "ALTER TABLE example ALTER COLUMN id SET DEFAULT max(1)"],
  [
    "a literal that is not valid input for the column type",
    "CREATE TABLE example (id int)",
    "ALTER TABLE example ALTER COLUMN id SET DEFAULT 'abc'",
  ],
  [
    "an expression of an unassignable type",
    "CREATE TABLE example (id int)",
    "ALTER TABLE example ALTER COLUMN id SET DEFAULT true",
  ],
  [
    "a timestamp expression for an integer column",
    "CREATE TABLE example (id int)",
    "ALTER TABLE example ALTER COLUMN id SET DEFAULT now()",
  ],
  [
    "an identity column",
    "CREATE TABLE example (id int GENERATED ALWAYS AS IDENTITY)",
    "ALTER TABLE example ALTER COLUMN id SET DEFAULT 5",
  ],
  [
    "a generated column",
    "CREATE TABLE example (a int, g int GENERATED ALWAYS AS (a * 2) STORED)",
    "ALTER TABLE example ALTER COLUMN g SET DEFAULT 5",
  ],
];

for (const [name, setup, sql] of REJECTED) {
  errorParity(`SET DEFAULT rejects ${name}`, [setup], sql, undefined, { messageTier: "A" });
}

// Same SQLSTATE as PostgreSQL. The message is the enum input error every statement shares, which
// names the type schema-qualified here, so it is not compared.
matrixBoth("SET DEFAULT rejects an invalid enum label", async (memory, postgres) => {
  await setupBoth(memory, postgres, ["CREATE TYPE mood AS ENUM ('sad', 'ok')", "CREATE TABLE example (feeling mood)"]);
  const sql = "ALTER TABLE example ALTER COLUMN feeling SET DEFAULT 'angry'";
  const a = await memory.exec(sql);
  const b = await postgres.exec(sql);
  expect(a.ok).toBe(false);
  expect(b.ok).toBe(false);
  expect(a.error?.sqlstate).toBe(b.error?.sqlstate as string);
  expectParity(await memory.query(DEFAULTS), await postgres.query(DEFAULTS));
});

errorParity(
  "DROP DEFAULT rejects an identity column",
  ["CREATE TABLE example (id int GENERATED ALWAYS AS IDENTITY)"],
  "ALTER TABLE example ALTER COLUMN id DROP DEFAULT",
  undefined,
  { messageTier: "A" },
);

errorParity(
  "DROP DEFAULT rejects a generated column",
  ["CREATE TABLE example (a int, g int GENERATED ALWAYS AS (a * 2) STORED)"],
  "ALTER TABLE example ALTER COLUMN g DROP DEFAULT",
  undefined,
  { messageTier: "A" },
);

sequenceParity(
  "a rejected SET DEFAULT leaves the previous default in place",
  ["CREATE TABLE example (id int DEFAULT 5, body text)"],
  [
    { sql: "ALTER TABLE example ALTER COLUMN id SET DEFAULT 'abc'" },
    { sql: "ALTER TABLE example ALTER COLUMN body SET DEFAULT 'ok', ALTER COLUMN id SET DEFAULT (SELECT 1)" },
    { sql: DEFAULTS, query: true },
    { sql: "INSERT INTO example DEFAULT VALUES" },
    { sql: "SELECT id, body FROM example", query: true },
  ],
  { compareFinalState: true },
);

sequenceParity(
  "defaults whose length or range only fails at insert time are accepted by SET DEFAULT",
  ["CREATE TABLE example (id int, code varchar(3), small smallint)"],
  [
    { sql: "ALTER TABLE example ALTER COLUMN code SET DEFAULT 'too long'" },
    { sql: "ALTER TABLE example ALTER COLUMN small SET DEFAULT 99999" },
    { sql: DEFAULTS, query: true },
    { sql: "INSERT INTO example (id, small) VALUES (1, 1)" },
    { sql: "INSERT INTO example (id, code) VALUES (2, 'ok')" },
    { sql: "INSERT INTO example (id, code, small) VALUES (3, 'ok', 1)" },
    { sql: "SELECT id, code, small FROM example", query: true },
  ],
);

sequenceParity(
  "quoted identifiers are honored by SET / DROP DEFAULT",
  ['CREATE TABLE "Mixed Table" ("Body Col" text, body text)'],
  [
    { sql: `ALTER TABLE "Mixed Table" ALTER COLUMN "Body Col" SET DEFAULT 'quoted'` },
    { sql: `ALTER TABLE "Mixed Table" ALTER COLUMN "body col" SET DEFAULT 'nope'` },
    { sql: `ALTER TABLE "Mixed Table" ALTER COLUMN BODY SET DEFAULT 'plain'` },
    {
      sql: "SELECT column_name, column_default FROM information_schema.columns WHERE table_name = 'Mixed Table' ORDER BY ordinal_position",
      query: true,
    },
    { sql: 'INSERT INTO "Mixed Table" DEFAULT VALUES' },
    { sql: 'ALTER TABLE "Mixed Table" ALTER COLUMN "Body Col" DROP DEFAULT' },
    { sql: 'INSERT INTO "Mixed Table" DEFAULT VALUES' },
    { sql: 'SELECT "Body Col", body FROM "Mixed Table" ORDER BY 1 NULLS LAST', query: true },
  ],
  { compareFinalState: true },
);

parity(
  "column_default qualifies a sequence that the search path does not reach",
  [
    "CREATE SCHEMA app",
    "CREATE TABLE app.example (id serial, n int)",
    "CREATE SEQUENCE app.counter",
    "ALTER TABLE app.example ALTER COLUMN n SET DEFAULT nextval('app.counter')",
  ],
  "SELECT column_name, column_default FROM information_schema.columns WHERE table_schema = 'app' ORDER BY ordinal_position",
);

matrixBoth("defaults set by ALTER survive a snapshot reload", async (memory, postgres) => {
  await setupBoth(memory, postgres, [
    "CREATE TABLE example (id int, v int DEFAULT 5, at timestamptz, body text, gone int DEFAULT 1)",
    "ALTER TABLE example ALTER COLUMN v SET DEFAULT 1 + 2",
    "ALTER TABLE example ALTER COLUMN at SET DEFAULT now()",
    "ALTER TABLE example ALTER COLUMN body SET DEFAULT 'x' || 'y'",
    "ALTER TABLE example ALTER COLUMN gone DROP DEFAULT",
  ]);
  memory.restore(memory.snapshot());
  expectParity(await memory.query(DEFAULTS), await postgres.query(DEFAULTS));
  const insert = "INSERT INTO example (id) VALUES (1)";
  expectParity(await memory.exec(insert), await postgres.exec(insert));
  const rows = "SELECT id, v, body, gone, at IS NOT NULL AS stamped FROM example";
  expectParity(await memory.query(rows), await postgres.query(rows));
});
