import { expect, test } from "bun:test";
import { Database, Snapshot } from "../../../src/index.ts";
import { errorParity, parity, parityTyped, queryErrorParity, sequenceParity } from "../helpers.ts";

// regnamespace: input, output, casts and catalog comparisons (#329).
// Oracle: PGlite (PostgreSQL 18.3), https://www.postgresql.org/docs/18/datatype-oid.html

const A = { messageTier: "A" } as const;
const schemas = [
  "CREATE SCHEMA app",
  'CREATE SCHEMA "Mixed Case"',
  "CREATE TABLE kv (id integer)",
  "CREATE TABLE app.kv (id integer)",
];

// --- 1. a name resolves to its oid and compares with pg_class.relnamespace ---

parity(
  "the reported predicate: relnamespace = current_schema()::regnamespace",
  schemas,
  "SELECT relpersistence FROM pg_class WHERE relname = 'kv' AND relnamespace = current_schema()::regnamespace",
);

parity(
  "a regnamespace literal picks the schema's relations out of pg_class",
  schemas,
  `SELECT n.nspname, c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE c.relname = 'kv' AND c.relnamespace = 'app'::regnamespace`,
);

parity(
  "text and name values cast to regnamespace",
  schemas,
  `SELECT (SELECT count(*) FROM pg_class WHERE relname = 'kv' AND relnamespace = 'app'::text::regnamespace) AS from_text,
          (SELECT count(*) FROM pg_class WHERE relname = 'kv' AND relnamespace = 'app'::name::regnamespace) AS from_name,
          (SELECT count(*) FROM pg_class WHERE relname = 'kv' AND relnamespace = 'app'::regnamespace::oid) AS as_oid`,
);

parity(
  "regnamespace compares with oid and with itself, in either order",
  schemas,
  `SELECT 'app'::regnamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'app') AS reg_eq_oid,
          (SELECT oid FROM pg_namespace WHERE nspname = 'app') = 'app'::regnamespace AS oid_eq_reg,
          'app'::regnamespace <> 'public'::regnamespace AS differs,
          'app'::regnamespace = 'app'::regnamespace AS same,
          'app'::regnamespace IN (SELECT oid FROM pg_namespace) AS listed`,
);

parity(
  "an oid column casts to regnamespace and prints the schema name",
  schemas,
  `SELECT relnamespace::regnamespace AS ns, count(*) AS relations FROM pg_class WHERE relname = 'kv'
   GROUP BY 1 ORDER BY relnamespace::regnamespace::text`,
);

parity(
  "every pg_namespace name round-trips through regnamespace",
  schemas,
  `SELECT quote_ident(nspname)::regnamespace AS reg, quote_ident(nspname)::regnamespace::oid = oid AS same
   FROM pg_namespace WHERE nspname IN ('app', 'Mixed Case', 'public', 'pg_catalog') ORDER BY nspname`,
);

parityTyped(
  "regnamespace is its own type and casts to oid and the integer types",
  schemas,
  `SELECT 'app'::regnamespace AS reg, 'app'::regnamespace::oid > 0 AS as_oid,
          'app'::regnamespace::int4 > 0 AS as_int4, 'app'::regnamespace::int8 > 0 AS as_int8`,
);

parity(
  "integer and text round trips keep the same schema",
  schemas,
  `SELECT 'app'::regnamespace::int4::regnamespace AS via_int4, 'app'::regnamespace::int8::regnamespace AS via_int8,
          'app'::regnamespace::oid::regnamespace AS via_oid, 'app'::regnamespace::text::regnamespace AS via_text`,
);

queryErrorParity(
  "regnamespace does not cast to regclass",
  schemas,
  "SELECT 'app'::regnamespace::regclass",
  undefined,
  A,
);

// --- 2. quoted mixed-case names keep their case and their quotes ---

parity(
  "input folds unquoted names and keeps quoted ones; output quotes what needs it",
  [...schemas, 'CREATE SCHEMA "has""quote"', 'CREATE SCHEMA "select"', 'CREATE SCHEMA "123abc"', 'CREATE SCHEMA "a$b"'],
  `SELECT 'app'::regnamespace AS plain, 'APP'::regnamespace AS folded, ' app '::regnamespace AS padded,
          '"Mixed Case"'::regnamespace AS mixed, '"has""quote"'::regnamespace AS embedded_quote,
          '"select"'::regnamespace AS keyword, 'select'::regnamespace AS bare_keyword,
          '"123abc"'::regnamespace AS digit_first, '"a$b"'::regnamespace AS dollar`,
);

parity("regnamespace text output is the quoted name", schemas, `SELECT '"Mixed Case"'::regnamespace::text AS name`);

parity(
  "regnamespace values aggregate, concatenate and format as their names",
  schemas,
  `SELECT array_agg(ns ORDER BY ns::text) AS names, string_agg(ns::text || '!', ',' ORDER BY ns::text) AS joined,
          format('%s', '"Mixed Case"'::regnamespace) AS formatted
   FROM (VALUES ('app'::regnamespace), ('"Mixed Case"'::regnamespace), ('public'::regnamespace)) AS v (ns)`,
);

queryErrorParity(
  "a mixed-case name without quotes is two words, not a folded name",
  schemas,
  "SELECT 'Mixed Case'::regnamespace",
  undefined,
  A,
);

// --- 3. builtin namespaces and numeric oids ---

parity(
  "builtin schemas resolve to their catalog oids",
  [],
  `SELECT 'pg_catalog'::regnamespace::oid AS pg_catalog, 'pg_toast'::regnamespace::oid AS pg_toast,
          'information_schema'::regnamespace::oid = (SELECT oid FROM pg_namespace WHERE nspname = 'information_schema') AS info,
          'public'::regnamespace::oid = (SELECT oid FROM pg_namespace WHERE nspname = 'public') AS public`,
);

parity(
  "numeric oids print the schema they name, in a literal or a cast",
  [],
  "SELECT 11::regnamespace AS by_int, '11'::regnamespace AS by_text, 99::regnamespace AS toast, 11::oid::regnamespace AS by_oid",
);

parity(
  "an oid no schema has prints numerically",
  [],
  `SELECT 999::regnamespace::text AS small, 999999::oid::regnamespace AS by_oid, '999999'::regnamespace AS by_text,
          '4294967295'::regnamespace AS max_oid, 4294967295::regnamespace AS max_int8`,
);

parity(
  "zero and '-' are the invalid oid, printed as '-'",
  [],
  "SELECT 0::regnamespace AS zero, '0'::regnamespace AS zero_text, '-'::regnamespace AS dash, '-'::regnamespace::oid AS dash_oid",
);

parity(
  "a negative int4 reinterprets as an unsigned oid",
  [],
  "SELECT (-1)::regnamespace AS minus_one, (-1)::oid AS as_oid",
);

parity("NULL stays NULL", [], "SELECT NULL::regnamespace AS reg, NULL::text::regnamespace AS from_text");

parity(
  "the system catalogs' own namespace columns cast too",
  [],
  "SELECT typnamespace::regnamespace AS ns FROM pg_type WHERE typname = 'int4'",
);

// --- 4. a missing schema is 3F000; rename and drop keep identity ---

queryErrorParity("a missing schema is 3F000", [], "SELECT 'missing_schema'::regnamespace", undefined, A);
queryErrorParity(
  "a missing schema is 3F000 through a text cast",
  [],
  "SELECT 'missing_schema'::text::regnamespace",
  undefined,
  A,
);
queryErrorParity("a quoted name is looked up case-sensitively", schemas, `SELECT '"APP"'::regnamespace`, undefined, A);

sequenceParity(
  "a stored regnamespace follows ALTER SCHEMA RENAME and outlives DROP SCHEMA as a number",
  ["CREATE SCHEMA app", "CREATE TABLE app.kv (id integer)", "CREATE TABLE holds (ns regnamespace)"],
  [
    { sql: "INSERT INTO holds VALUES ('public'), ('app')" },
    { sql: "SELECT ns FROM holds ORDER BY ns::text", query: true },
    { sql: "ALTER SCHEMA app RENAME TO renamed" },
    { sql: "SELECT ns FROM holds ORDER BY ns::text", query: true },
    { sql: "SELECT relnamespace::regnamespace AS ns FROM pg_class WHERE relname = 'kv'", query: true },
    { sql: "SELECT 'renamed'::regnamespace = (SELECT ns FROM holds WHERE ns::text = 'renamed') AS same", query: true },
    { sql: "SELECT 'app'::regnamespace", query: true },
    { sql: "DROP SCHEMA renamed CASCADE" },
    { sql: "SELECT 'renamed'::regnamespace", query: true },
    { sql: "SELECT ns::text ~ '^[0-9]+$' AS numeric_now FROM holds ORDER BY ns::text", query: true },
    { sql: "CREATE SCHEMA renamed" },
    // a new schema of the same name is a new namespace: the stored oid does not adopt it
    { sql: "SELECT count(*) AS n FROM holds WHERE ns = 'renamed'::regnamespace", query: true },
  ],
);

test("regnamespace values and schema oids survive a snapshot round trip", () => {
  const db = new Database();
  let restored: Database | undefined;
  try {
    db.exec('CREATE SCHEMA app; CREATE SCHEMA "Mixed Case"; CREATE TABLE app.kv (id integer)');
    db.exec(
      `CREATE TABLE holds (ns regnamespace); INSERT INTO holds VALUES ('app'), ('"Mixed Case"'), ('pg_catalog'), (424242)`,
    );
    const stored = "SELECT ns::text AS ns, ns::oid AS oid FROM holds ORDER BY ns::text";
    const joined = `SELECT c.relname FROM pg_class c WHERE c.relname = 'kv' AND c.relnamespace = 'app'::regnamespace`;
    const before = { stored: db.query(stored), joined: db.query(joined) };
    restored = Snapshot.decode(db.snapshot().encode()).open();
    expect({ stored: restored.query(stored), joined: restored.query(joined) }).toEqual(before);
    expect(before.stored.map((row) => (row as { ns: string }).ns)).toEqual([
      '"Mixed Case"',
      "424242",
      "app",
      "pg_catalog",
    ]);
    expect(before.joined).toEqual([{ relname: "kv" }]);
  } finally {
    restored?.close();
    db.close();
  }
});

// --- 5. oid overflow and malformed identifiers are errors, never another namespace ---

queryErrorParity(
  "an all-digit string beyond 2^32-1 is out of range for oid",
  [],
  "SELECT '4294967296'::regnamespace",
  undefined,
  A,
);
queryErrorParity(
  "a huge digit string is out of range for oid",
  [],
  "SELECT '99999999999999999999'::regnamespace",
  undefined,
  A,
);
queryErrorParity("a bigint beyond 2^32-1 is out of range", [], "SELECT 4294967296::regnamespace", undefined, A);
queryErrorParity("a negative bigint is out of range", [], "SELECT (-1)::bigint::regnamespace", undefined, A);
queryErrorParity("numeric does not cast to regnamespace", [], "SELECT 1.5::regnamespace", undefined, A);
// a sign makes it a name, not a number
queryErrorParity("a signed digit string is looked up as a name", [], "SELECT '-1'::regnamespace", undefined, A);
queryErrorParity("a plus-signed digit string is looked up as a name", [], "SELECT '+5'::regnamespace", undefined, A);
// only an exact all-digit string is an oid: padded digits are the name "11"
queryErrorParity("padded digits are a name, not oid 11", [], "SELECT ' 11 '::regnamespace", undefined, A);
queryErrorParity("digits followed by letters are a name", [], "SELECT '12abc'::regnamespace", undefined, A);

for (const [title, input] of [
  ["an empty string", ""],
  ["a qualified name", "a.b"],
  ["a trailing separator", "app."],
  ["a leading separator", ".app"],
  ["an unterminated quote", '"unterminated'],
  ["two words", "app extra"],
  ["text after a closing quote", '"app"x'],
] as const) {
  queryErrorParity(
    `${title} is invalid name syntax`,
    ["CREATE SCHEMA app"],
    `SELECT '${input}'::regnamespace`,
    undefined,
    A,
  );
}

queryErrorParity("an empty quoted name is a schema that does not exist", [], `SELECT '""'::regnamespace`, undefined, A);
queryErrorParity(
  "a quote inside an unquoted name is part of the name",
  ["CREATE SCHEMA app"],
  `SELECT 'app"x"'::regnamespace`,
  undefined,
  A,
);

parity(
  "to_regnamespace is the same lookup with NULL in place of an error",
  schemas,
  `SELECT to_regnamespace('app') AS found, to_regnamespace('"Mixed Case"') AS quoted, to_regnamespace('missing_schema') AS missing,
          to_regnamespace('a.b') AS malformed, to_regnamespace('11') AS numeric, to_regnamespace(NULL) AS null_in,
          pg_typeof(to_regnamespace('app'))::text AS type`,
);

errorParity(
  "a regnamespace column rejects a missing schema on insert",
  ["CREATE TABLE holds (ns regnamespace)"],
  "INSERT INTO holds VALUES ('missing_schema')",
  undefined,
  A,
);
