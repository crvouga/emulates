import { expect, test } from "bun:test";
import { Database, PostgresError, Snapshot } from "../../../src/index.ts";
import { errorParity, parity, parityTyped, queryErrorParity, sequenceParity } from "../helpers.ts";

// Stable index oids and pg_get_indexdef / pg_indexes.indexdef (#330).
// Oracle: PGlite (PostgreSQL 18.3), https://www.postgresql.org/docs/18/functions-info.html

const A = { messageTier: "A" } as const;
const USER = "n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'";

/** Every user index with its table, definition and flags, through the pg_index joins. */
const indexes = `SELECT n.nspname, t.relname AS tablename, i.relname AS indexname, pg_get_indexdef(i.oid) AS indexdef,
    ix.indisunique, ix.indisprimary, ix.indnatts, ix.indnkeyatts
  FROM pg_index ix JOIN pg_class i ON i.oid = ix.indexrelid JOIN pg_class t ON t.oid = ix.indrelid
  JOIN pg_namespace n ON n.oid = i.relnamespace WHERE ${USER} ORDER BY 1, 2, 3`;
const pgIndexes = `SELECT schemaname, tablename, indexname, tablespace, indexdef FROM pg_indexes
  WHERE schemaname !~ '^pg_' AND schemaname <> 'information_schema' ORDER BY 1, 2, 3`;
/** oid of the index named `name`, for the functions that take one. */
const oidOf = (name: string): string => `(SELECT c.oid FROM pg_class c WHERE c.relname = '${name}')`;
const basic = [
  "CREATE TABLE t (id integer, value text)",
  "CREATE INDEX t_id_idx ON t (id)",
  "CREATE UNIQUE INDEX t_value_idx ON t (value)",
];
const keyed = [
  "CREATE TABLE parent (id integer PRIMARY KEY, code text UNIQUE, a integer, b integer, CONSTRAINT parent_ab UNIQUE NULLS NOT DISTINCT (a, b))",
  "CREATE TABLE child (id bigint, parent_id integer REFERENCES parent (id), label text, CONSTRAINT child_pk PRIMARY KEY (id, parent_id))",
  "CREATE INDEX child_label_idx ON child (label)",
];

// --- 1. each index has its own oid, and the joins pair it with exactly its table ---

parity(
  "the reported query: index, table and definition",
  basic,
  `SELECT i.relname, t.relname AS tablename, pg_get_indexdef(i.oid) AS indexdef
  FROM pg_index ix JOIN pg_class i ON i.oid = ix.indexrelid JOIN pg_class t ON t.oid = ix.indrelid
  JOIN pg_namespace n ON n.oid = t.relnamespace WHERE ${USER} ORDER BY 1`,
);

parity(
  "index oids are distinct from each other and from every table",
  keyed,
  `SELECT count(*) AS indexes, count(DISTINCT ix.indexrelid) AS distinct_oids,
          count(*) FILTER (WHERE ix.indexrelid = ix.indrelid) AS same_as_table,
          count(*) FILTER (WHERE ix.indexrelid IN (SELECT c.oid FROM pg_class c WHERE c.relkind <> 'i')) AS same_as_other_relation,
          count(DISTINCT ix.indrelid) AS tables
   FROM pg_index ix JOIN pg_class i ON i.oid = ix.indexrelid JOIN pg_namespace n ON n.oid = i.relnamespace WHERE ${USER}`,
);

parity(
  "joining through the oids yields each index once, with its own table",
  keyed,
  `SELECT t.relname AS tablename, i.relname AS indexname, i.relkind, t.relkind AS table_kind
   FROM pg_index ix JOIN pg_class i ON i.oid = ix.indexrelid JOIN pg_class t ON t.oid = ix.indrelid
   JOIN pg_namespace n ON n.oid = i.relnamespace WHERE ${USER} ORDER BY 1, 2`,
);

parity(
  "two schemas may hold an index of the same name; each has its own oid and table",
  [
    "CREATE SCHEMA app",
    "CREATE TABLE t (id integer)",
    "CREATE TABLE app.t (id integer)",
    "CREATE INDEX same_idx ON t (id)",
    "CREATE INDEX same_idx ON app.t (id)",
  ],
  `SELECT n.nspname, pg_get_indexdef(i.oid) AS indexdef, count(*) OVER () AS rows, count(*) OVER (PARTITION BY i.oid) AS per_oid
   FROM pg_class i JOIN pg_index ix ON ix.indexrelid = i.oid JOIN pg_namespace n ON n.oid = i.relnamespace
   WHERE i.relname = 'same_idx' ORDER BY 1`,
);

// --- 2. definitions: uniqueness, method, ordering, NULLS, quoting, expressions, predicates ---

parity("pg_indexes.indexdef for ordinary and unique indexes", basic, pgIndexes);

parity(
  "ordering and NULLS placement print only where they differ from the default",
  [
    "CREATE TABLE t (a integer, b integer, c text)",
    "CREATE INDEX o1 ON t (a ASC, b DESC)",
    "CREATE INDEX o2 ON t (a NULLS FIRST, b NULLS LAST)",
    "CREATE INDEX o3 ON t (a DESC NULLS FIRST, b DESC NULLS LAST)",
    "CREATE INDEX o4 ON t (a ASC NULLS LAST, b ASC NULLS FIRST, c DESC)",
    "CREATE UNIQUE INDEX o5 ON t (a, b) NULLS NOT DISTINCT",
    "CREATE UNIQUE INDEX o6 ON t (a DESC, b) NULLS DISTINCT",
  ],
  pgIndexes,
);

parity(
  "access methods: btree by default, hash and gin as written, and pg_am names them",
  [
    "CREATE TABLE t (a integer, tags text[], doc jsonb, c text)",
    "CREATE INDEX m_default ON t (a)",
    "CREATE INDEX m_btree ON t USING btree (a)",
    "CREATE INDEX m_hash ON t USING hash (c)",
    "CREATE INDEX m_gin ON t USING gin (tags)",
    "CREATE INDEX m_gin_doc ON t USING gin (doc)",
    "CREATE INDEX m_gin_path ON t USING gin (doc jsonb_path_ops)",
  ],
  `SELECT i.relname, am.amname, i.relam, pg_get_indexdef(i.oid) AS indexdef
   FROM pg_class i JOIN pg_am am ON am.oid = i.relam JOIN pg_index ix ON ix.indexrelid = i.oid
   WHERE i.relname LIKE 'm\\_%' ORDER BY 1`,
);

parity(
  "pg_am lists the index access methods with their oids",
  [],
  "SELECT oid, amname, amtype FROM pg_am WHERE amtype = 'i' ORDER BY amname",
);

errorParity(
  "a unique index needs an access method that supports one",
  ["CREATE TABLE t (a integer)"],
  "CREATE UNIQUE INDEX u ON t USING hash (a)",
  undefined,
  A,
);
errorParity(
  "an unknown access method is 42704",
  ["CREATE TABLE t (a integer)"],
  "CREATE INDEX u ON t USING nosuch (a)",
  "undefined_object",
  A,
);

parity(
  "identifiers are quoted when they need it: mixed case, spaces, keywords, digits, embedded quotes",
  [
    'CREATE SCHEMA "My Schema"',
    'CREATE TABLE "Order" ("user" integer, "select" text, "Mixed Col" text, plain text, "1st" integer, "a""b" integer, "a$b" integer)',
    'CREATE INDEX "order" ON "Order" ("user", "select")',
    'CREATE INDEX "Mixed Idx" ON "Order" ("Mixed Col", plain)',
    'CREATE INDEX odd_names ON "Order" ("1st", "a""b", "a$b")',
    'CREATE INDEX "left" ON "Order" (lower("Mixed Col"), ("user" + 1)) WHERE "select" IS NOT NULL',
    'CREATE TABLE "My Schema"."My Table" (x integer)',
    'CREATE INDEX "My Index" ON "My Schema"."My Table" (x)',
    'CREATE TABLE "My Schema".plain ("Value" integer)',
    'CREATE INDEX plain_value_idx ON "My Schema".plain ("Value")',
  ],
  pgIndexes,
);

parity(
  "INCLUDE columns, operator classes, collations and storage parameters",
  [
    "CREATE TABLE t (id integer, a integer, t text, v varchar(20), tags text[])",
    "CREATE INDEX x_incl ON t (id) INCLUDE (a, t)",
    "CREATE UNIQUE INDEX x_incl_u ON t (id) INCLUDE (a) WHERE a > 0",
    // a default operator class is not printed; a non-default one is
    "CREATE INDEX x_ops_default ON t (t text_ops, a int4_ops, v text_ops)",
    "CREATE INDEX x_ops ON t (t text_pattern_ops, v varchar_pattern_ops, v varchar_ops)",
    `CREATE INDEX x_coll ON t (t COLLATE "C" DESC, v COLLATE "POSIX")`,
    `CREATE INDEX x_coll_expr ON t (lower(t) COLLATE "C")`,
    "CREATE INDEX x_with ON t (id) WITH (fillfactor = 80, deduplicate_items = off)",
    "CREATE INDEX x_with_gin ON t USING gin (tags) WITH (fastupdate = on)",
    "CREATE INDEX x_all ON t (a DESC NULLS LAST) INCLUDE (t) WITH (fillfactor = 90) WHERE a IS NOT NULL",
  ],
  indexes,
);

const matrix = [
  "CREATE TYPE mood AS ENUM ('sad', 'ok', 'happy')",
  "CREATE TABLE d (id bigint, n numeric(10,2), f double precision, r real, s smallint, v varchar(20), ch char(3), nm name, b boolean, dt date, ts timestamp, tz timestamptz, j jsonb, js json, arr int[], tarr text[], m mood, u uuid, t text, i int, by bytea, iv interval)",
  "CREATE INDEX d01 ON d (id) WHERE id > 5",
  "CREATE INDEX d02 ON d (id) WHERE id > 5000000000",
  "CREATE INDEX d03 ON d (id) WHERE n > 0",
  "CREATE INDEX d04 ON d (id) WHERE n > 1.5",
  "CREATE INDEX d05 ON d (id) WHERE f > 1",
  "CREATE INDEX d06 ON d (id) WHERE f > 1.5",
  "CREATE INDEX d07 ON d (id) WHERE i > 1.5",
  "CREATE INDEX d08 ON d (id) WHERE v = 'x'",
  "CREATE INDEX d09 ON d (id) WHERE ch = 'x'",
  "CREATE INDEX d10 ON d (id) WHERE nm = 'x'",
  "CREATE INDEX d11 ON d (id) WHERE b",
  "CREATE INDEX d12 ON d (id) WHERE NOT b",
  "CREATE INDEX d13 ON d (id) WHERE b = true",
  "CREATE INDEX d14 ON d (id) WHERE b IS TRUE",
  "CREATE INDEX d15 ON d (id) WHERE b IS NOT FALSE",
  "CREATE INDEX d16 ON d (id) WHERE dt > '2020-01-01'",
  "CREATE INDEX d17 ON d (id) WHERE ts >= '2020-01-01'",
  "CREATE INDEX d18 ON d (id) WHERE tz < '2020-01-01 00:00:00+00'",
  "CREATE INDEX d19 ON d (id) WHERE m = 'happy'",
  "CREATE INDEX d20 ON d (id) WHERE m IN ('sad', 'ok')",
  "CREATE INDEX d21 ON d (id) WHERE v IN ('a', 'b')",
  "CREATE INDEX d22 ON d (id) WHERE t IN ('a', 'b')",
  "CREATE INDEX d23 ON d (id) WHERE i NOT IN (1, 2, 3)",
  "CREATE INDEX d24 ON d (id) WHERE id IN (1, 2)",
  "CREATE INDEX d25 ON d (id) WHERE i IN (1)",
  "CREATE INDEX d26 ON d (id) WHERE v LIKE 'a%'",
  "CREATE INDEX d27 ON d (id) WHERE t ILIKE '%a'",
  "CREATE INDEX d28 ON d (id) WHERE t NOT LIKE 'a%'",
  "CREATE INDEX d29 ON d (id) WHERE t ~ '^a'",
  "CREATE INDEX d30 ON d (id) WHERE i NOT BETWEEN 1 AND 5",
  "CREATE INDEX d31 ON d (id) WHERE i > 0 AND i < 10 AND t IS NOT NULL",
  "CREATE INDEX d32 ON d (id) WHERE i > 0 OR i < -10 OR t IS NULL",
  "CREATE INDEX d33 ON d (id) WHERE (i > 0 OR i < -10) AND t IS NULL",
  "CREATE INDEX d34 ON d (id) WHERE i > 0 AND (i < 10 AND t IS NULL)",
  "CREATE INDEX d35 ON d (id) WHERE i = -1",
  "CREATE INDEX d36 ON d (id) WHERE i <> 0 AND s = 1",
  "CREATE INDEX d37 ON d (id) WHERE t IS DISTINCT FROM 'x'",
  "CREATE INDEX d38 ON d (id) WHERE t IS NOT DISTINCT FROM 'x'",
  "CREATE INDEX d39 ON d (id) WHERE u = '00000000-0000-0000-0000-000000000001'",
  "CREATE INDEX d40 ON d (id) WHERE j ->> 'k' = 'v'",
  "CREATE INDEX d41 ON d ((j ->> 'k'))",
  "CREATE INDEX d42 ON d ((j -> 'a' ->> 'b'))",
  "CREATE INDEX d43 ON d ((j #>> '{a,b}'))",
  "CREATE INDEX d44 ON d (id) WHERE j @> '{\"a\": 1}'",
  "CREATE INDEX d45 ON d (id) WHERE j ? 'k'",
  "CREATE INDEX d46 ON d (lower(v))",
  "CREATE INDEX d47 ON d (upper(t), lower(ch))",
  "CREATE INDEX d48 ON d (length(t))",
  "CREATE INDEX d49 ON d (abs(i))",
  "CREATE INDEX d50 ON d (COALESCE(t, ''))",
  "CREATE INDEX d51 ON d (COALESCE(i, 0))",
  "CREATE INDEX d52 ON d (COALESCE(v, 'none'))",
  "CREATE INDEX d53 ON d (NULLIF(t, ''))",
  "CREATE INDEX d54 ON d (GREATEST(i, 0), LEAST(i, 100))",
  "CREATE INDEX d55 ON d ((i::text))",
  "CREATE INDEX d56 ON d ((i::bigint))",
  "CREATE INDEX d57 ON d ((t::varchar(10)))",
  "CREATE INDEX d58 ON d ((n::numeric(5,1)))",
  "CREATE INDEX d59 ON d (CAST(i AS numeric))",
  "CREATE INDEX d60 ON d ((i + 1))",
  "CREATE INDEX d61 ON d ((i - 1 - 2))",
  "CREATE INDEX d62 ON d ((i - (1 - 2)))",
  "CREATE INDEX d63 ON d ((i * 2 + s / 3))",
  "CREATE INDEX d64 ON d ((i * (2 + s)))",
  "CREATE INDEX d65 ON d ((-i))",
  "CREATE INDEX d66 ON d ((t || v))",
  "CREATE INDEX d67 ON d ((t || '-' || i))",
  "CREATE INDEX d68 ON d ((i % 10))",
  "CREATE INDEX d69 ON d (date_trunc('day', ts))",
  "CREATE INDEX d70 ON d (EXTRACT(year FROM dt))",
  "CREATE INDEX d71 ON d (substring(t from 1 for 2))",
  "CREATE INDEX d72 ON d (substring(t, 1, 2))",
  "CREATE INDEX d73 ON d (substr(t, 1, 2))",
  'CREATE INDEX d74 ON d ("left"(t, 2))',
  "CREATE INDEX d75 ON d (trim(t))",
  "CREATE INDEX d76 ON d (btrim(t))",
  "CREATE INDEX d77 ON d (md5(t))",
  "CREATE INDEX d78 ON d ((CASE WHEN i > 0 THEN 'pos' WHEN i < 0 THEN 'neg' END))",
  "CREATE INDEX d79 ON d ((CASE i WHEN 1 THEN 'one' ELSE 'other' END))",
  "CREATE INDEX d80 ON d ((CASE WHEN b THEN i ELSE 0 END))",
  "CREATE INDEX d81 ON d ((arr[1]))",
  "CREATE INDEX d82 ON d (id) WHERE 1 = ANY (arr)",
  "CREATE INDEX d83 ON d (id) WHERE arr @> ARRAY[1, 2]",
  "CREATE INDEX d84 ON d (id) WHERE tarr && ARRAY['a', 'b']",
  "CREATE INDEX d85 ON d ((ts AT TIME ZONE 'UTC'))",
  "CREATE INDEX d86 ON d (id) WHERE t = 'it''s'",
  "CREATE INDEX d87 ON d (id) WHERE i > 0 AND NOT (t = 'a' OR t = 'b')",
  "CREATE INDEX d88 ON d (id) WHERE (i + 1) * 2 > 10",
  "CREATE INDEX d89 ON d (id) WHERE length(t) > 3 AND lower(t) = 'abc'",
  "CREATE INDEX d90 ON d (id) WHERE t <> ''",
  "CREATE INDEX d91 ON d (id) WHERE id = 1 AND s > 2 AND f < 3 AND r >= 4",
  "CREATE INDEX d92 ON d (id) WHERE n = 5 AND n <> 2.50",
  "CREATE INDEX d93 ON d (id DESC, t ASC NULLS FIRST) WHERE b",
  "CREATE UNIQUE INDEX d94 ON d (lower(t)) WHERE t IS NOT NULL",
  "CREATE INDEX d95 ON d USING gin (arr)",
  "CREATE INDEX d96 ON d USING gin (j)",
  "CREATE INDEX d97 ON d USING gin (j jsonb_path_ops)",
  "CREATE INDEX d98 ON d USING hash (t)",
  "CREATE INDEX d99 ON d (t text_ops, v varchar_ops, i int4_ops)",
  "CREATE INDEX d100 ON d (t varchar_pattern_ops, v text_pattern_ops)",
  'CREATE INDEX d101 ON d (t COLLATE "C" DESC, v COLLATE "POSIX")',
  'CREATE INDEX d102 ON d (lower(t) COLLATE "C")',
  "CREATE INDEX d103 ON d (id) INCLUDE (t, v) WHERE i > 0",
  "CREATE INDEX d104 ON d (id) WITH (fillfactor = 80, deduplicate_items = off)",
  "CREATE INDEX d105 ON d USING gin (arr) WITH (fastupdate = on)",
  "CREATE INDEX d106 ON d (id) WHERE iv > '1 day'",
  "CREATE INDEX d107 ON d (id) WHERE i > 0::int AND t = 'a'::text AND dt = '2020-01-01'::date",
  "CREATE INDEX d108 ON d (id) WHERE r > 1.5 AND s < 5",
  "CREATE INDEX d109 ON d (upper(v))",
  "CREATE INDEX d110 ON d (id) WHERE v <> '' AND v IS NOT NULL",
  "CREATE INDEX d111 ON d (id) WHERE ch <> 'abc'",
  "CREATE INDEX d112 ON d (id) WHERE t = v",
  "CREATE INDEX d113 ON d (id) WHERE i = s AND i = id AND n = i AND f = i AND f = r",
  "CREATE INDEX d114 ON d (id) WHERE by IS NOT NULL",
  "CREATE INDEX d115 ON d (id) WHERE t LIKE 'a!%%' ESCAPE '!'",
  "CREATE INDEX d116 ON d (position('x' in t))",
  "CREATE INDEX d117 ON d (to_tsvector('english', t))",
  "CREATE INDEX d118 ON d (id) WHERE dt BETWEEN '2020-01-01' AND '2020-12-31'",
  "CREATE INDEX d119 ON d (id) WHERE tz > '2020-01-01'",
  "CREATE INDEX d120 ON d ((i IS NULL), (t IS NOT NULL))",
  "CREATE INDEX d121 ON d ((i > 0))",
  "CREATE INDEX d122 ON d ((NOT b))",
  "CREATE INDEX d123 ON d (id) WHERE (j ->> 'n')::int > 5",
  "CREATE INDEX d124 ON d (((j ->> 'n')::int))",
  "CREATE INDEX d125 ON d (id) WHERE t IN ('a', v)",
  "CREATE INDEX d126 ON d (id) WHERE s IN (1, 2)",
  "CREATE INDEX d127 ON d (id) WHERE n IN (1, 2.5)",
];
const matrixDefs =
  "SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'd' ORDER BY length(indexname), indexname";

// One index per construct: typed constants (bigint, numeric, float, varchar, char, name, date,
// timestamp, timestamptz, enum, uuid, interval), implicit casts, boolean tests, IN lists, LIKE,
// BETWEEN, AND / OR nesting, IS DISTINCT, jsonb operators, functions, COALESCE / NULLIF /
// GREATEST, casts, arithmetic precedence, CASE, subscripts, ANY, arrays, AT TIME ZONE.
parity("expression and predicate deparsing matches PostgreSQL across the construct matrix", matrix, matrixDefs);

parity(
  "pg_get_expr on indpred and indexprs returns the predicate and the expression list",
  matrix,
  `SELECT c.relname, pg_get_expr(i.indpred, i.indrelid) AS predicate, pg_get_expr(i.indexprs, i.indrelid) AS expressions,
          i.indpred IS NOT NULL AS partial, i.indexprs IS NOT NULL AS expressional
   FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid WHERE c.relname ~ '^d[0-9]+$' ORDER BY length(c.relname), c.relname`,
);

parity(
  "an index built without a name takes PostgreSQL's generated name",
  [
    "CREATE TABLE t (a integer, b integer, c text)",
    "CREATE INDEX ON t (a)",
    "CREATE INDEX ON t (a, b)",
    "CREATE INDEX ON t (a)",
    "CREATE INDEX ON t (lower(c))",
    "CREATE INDEX ON t ((a + b))",
    "CREATE INDEX ON t ((c::varchar))",
    "CREATE INDEX ON t (a, lower(c), (a * 2))",
    "CREATE UNIQUE INDEX ON t (b) WHERE b > 0",
  ],
  pgIndexes,
);

// --- 3. the column-position and pretty-print overloads ---

const overloads = [
  "CREATE TABLE t (a integer, b integer, c text, d text)",
  "CREATE INDEX plain_idx ON t (a DESC NULLS LAST, b DESC, c text_pattern_ops)",
  "CREATE INDEX expr_idx ON t (lower(c), (a + b), (a * 2 + b))",
  "CREATE INDEX partial_idx ON t (a) WHERE b > 0 AND c IS NOT NULL",
  "CREATE INDEX incl_idx ON t (a, (b + 1)) INCLUDE (c, d)",
  "CREATE SCHEMA other",
  "CREATE TABLE other.hidden (a integer, b integer)",
  "CREATE INDEX hidden_idx ON other.hidden ((a + b)) WHERE a > 0 OR b > 0",
];

parity(
  "position 0 is the whole definition; pretty-printing drops the schema and the redundant parentheses",
  overloads,
  `SELECT i.relname, pg_get_indexdef(i.oid) AS one_arg, pg_get_indexdef(i.oid, 0, false) AS plain, pg_get_indexdef(i.oid, 0, true) AS pretty
   FROM pg_class i JOIN pg_index ix ON ix.indexrelid = i.oid JOIN pg_namespace n ON n.oid = i.relnamespace WHERE ${USER} ORDER BY 1`,
);

parity(
  "position n is the n-th column alone: no ordering or opclass, expressions parenthesized",
  overloads,
  `SELECT i.relname, p AS position, pg_get_indexdef(i.oid, p, false) AS plain, pg_get_indexdef(i.oid, p, true) AS pretty
   FROM pg_class i JOIN pg_index ix ON ix.indexrelid = i.oid JOIN pg_namespace n ON n.oid = i.relnamespace
   CROSS JOIN generate_series(1, 5) AS p WHERE ${USER} ORDER BY 1, 2`,
);

parity(
  "INCLUDE columns follow the key columns; a position past the last column is an empty string",
  overloads,
  `SELECT pg_get_indexdef(${oidOf("incl_idx")}, 1, true) AS key_1, pg_get_indexdef(${oidOf("incl_idx")}, 2, true) AS key_2,
          pg_get_indexdef(${oidOf("incl_idx")}, 3, true) AS include_1, pg_get_indexdef(${oidOf("incl_idx")}, 4, true) AS include_2,
          pg_get_indexdef(${oidOf("incl_idx")}, 5, true) AS past_end, pg_get_indexdef(${oidOf("incl_idx")}, 5, true) IS NULL AS past_end_is_null,
          pg_get_indexdef(${oidOf("incl_idx")}, 100, false) AS far_past_end`,
);

parity(
  "a negative position is an empty string too",
  overloads,
  `SELECT pg_get_indexdef(${oidOf("plain_idx")}, -1, true) AS minus_one, pg_get_indexdef(${oidOf("plain_idx")}, -1, false) AS minus_one_plain,
          pg_get_indexdef(${oidOf("plain_idx")}, -2147483648, true) AS int_min`,
);

parity(
  "an oid that is not an index is NULL in every overload: missing, zero, a table, a schema",
  overloads,
  `SELECT pg_get_indexdef(999999) AS missing, pg_get_indexdef(0) AS zero, pg_get_indexdef(${oidOf("t")}) AS a_table,
          pg_get_indexdef((SELECT oid FROM pg_namespace WHERE nspname = 'other')) AS a_schema,
          pg_get_indexdef(999999, 0, true) AS missing_pretty, pg_get_indexdef(999999, 1, false) AS missing_column,
          pg_get_indexdef(${oidOf("t")}, 1, true) AS table_column`,
);

parity(
  "a NULL argument is NULL",
  overloads,
  `SELECT pg_get_indexdef(NULL) AS oid_null, pg_get_indexdef(NULL, 0, true) AS oid_null_3,
          pg_get_indexdef(${oidOf("plain_idx")}, NULL, true) AS position_null, pg_get_indexdef(${oidOf("plain_idx")}, 1, NULL) AS pretty_null`,
);

parityTyped(
  "both overloads return text",
  overloads,
  `SELECT pg_get_indexdef(${oidOf("plain_idx")}) AS whole, pg_get_indexdef(${oidOf("plain_idx")}, 1, true) AS col, pg_get_indexdef(999999) AS missing`,
);

queryErrorParity(
  "there is no two-argument pg_get_indexdef",
  overloads,
  `SELECT pg_get_indexdef(${oidOf("plain_idx")}, 1)`,
  "undefined_function",
  A,
);
queryErrorParity(
  "nor a four-argument one",
  overloads,
  `SELECT pg_get_indexdef(${oidOf("plain_idx")}, 1, true, true)`,
  "undefined_function",
);

sequenceParity("pretty-printing qualifies the table only when the search path does not reach it", overloads, [
  {
    sql: `SELECT pg_get_indexdef(${oidOf("hidden_idx")}, 0, true) AS pretty, pg_get_indexdef(${oidOf("plain_idx")}, 0, true) AS visible`,
    query: true,
  },
  { sql: "SET search_path = other" },
  {
    sql: `SELECT pg_get_indexdef(${oidOf("hidden_idx")}, 0, true) AS pretty, pg_get_indexdef(${oidOf("plain_idx")}, 0, true) AS hidden_now`,
    query: true,
  },
  { sql: `SELECT pg_get_indexdef(${oidOf("hidden_idx")}) AS plain`, query: true },
]);

// --- 4. identity through rename, drop and recreate ---

/** Remember an index's oid so a later step can compare against it. */
const save = (name: string, as: string) => ({
  sql: `INSERT INTO saved SELECT '${as}', c.oid::bigint FROM pg_class c WHERE c.relname = '${name}'`,
});
const sameAs = (name: string, as: string): string =>
  `(SELECT c.oid FROM pg_class c WHERE c.relname = '${name}') = (SELECT oid FROM saved WHERE label = '${as}')`;
const identity = [
  "CREATE TABLE saved (label text, oid bigint)",
  "CREATE TABLE t (id integer PRIMARY KEY, v integer)",
  "CREATE INDEX t_v_idx ON t (v)",
];

sequenceParity(
  "renaming an index, its table, a column or the schema keeps the oid and updates the definition",
  identity,
  [
    save("t_v_idx", "index"),
    save("t_pkey", "pkey"),
    { sql: "ALTER INDEX t_v_idx RENAME TO t_value_idx" },
    {
      sql: `SELECT ${sameAs("t_value_idx", "index")} AS same, (SELECT count(*) FROM pg_class WHERE relname = 't_v_idx') AS old_name`,
      query: true,
    },
    { sql: "ALTER TABLE t RENAME TO renamed" },
    { sql: "ALTER TABLE renamed RENAME COLUMN v TO value" },
    { sql: `SELECT ${sameAs("t_value_idx", "index")} AS same, ${sameAs("t_pkey", "pkey")} AS pkey_same`, query: true },
    { sql: pgIndexes, query: true },
    { sql: "CREATE SCHEMA app" },
    { sql: "ALTER TABLE renamed SET SCHEMA app" },
    { sql: pgIndexes, query: true },
    { sql: "ALTER SCHEMA app RENAME TO app2" },
    { sql: `SELECT ${sameAs("t_value_idx", "index")} AS same, ${sameAs("t_pkey", "pkey")} AS pkey_same`, query: true },
    { sql: indexes, query: true },
    { sql: "ALTER INDEX app2.t_value_idx RENAME TO t_final_idx" },
    { sql: pgIndexes, query: true },
  ],
);

sequenceParity("ALTER INDEX RENAME errors, and IF EXISTS", identity, [
  { sql: "ALTER INDEX missing_idx RENAME TO x" },
  { sql: "ALTER INDEX IF EXISTS missing_idx RENAME TO x" },
  { sql: "ALTER INDEX t_v_idx RENAME TO t_pkey" },
  { sql: "ALTER INDEX t_v_idx RENAME TO t" },
  { sql: pgIndexes, query: true },
]);

sequenceParity("dropping an index and creating one of the same name makes a different index", identity, [
  save("t_v_idx", "first"),
  { sql: "DROP INDEX t_v_idx" },
  { sql: `SELECT count(*) AS n FROM pg_class c JOIN saved s ON s.oid = c.oid`, query: true },
  { sql: `SELECT pg_get_indexdef((SELECT oid FROM saved WHERE label = 'first')) AS gone`, query: true },
  { sql: "CREATE INDEX t_v_idx ON t (v DESC)" },
  { sql: `SELECT ${sameAs("t_v_idx", "first")} AS same`, query: true },
  { sql: pgIndexes, query: true },
]);

sequenceParity("REINDEX keeps the oid; REINDEX CONCURRENTLY replaces the index and its oid", identity, [
  save("t_v_idx", "index"),
  save("t_pkey", "pkey"),
  { sql: "REINDEX INDEX t_v_idx" },
  { sql: "REINDEX TABLE t" },
  { sql: `SELECT ${sameAs("t_v_idx", "index")} AS same, ${sameAs("t_pkey", "pkey")} AS pkey_same`, query: true },
  { sql: "REINDEX INDEX CONCURRENTLY t_v_idx" },
  { sql: "REINDEX INDEX CONCURRENTLY t_pkey" },
  { sql: `SELECT ${sameAs("t_v_idx", "index")} AS same, ${sameAs("t_pkey", "pkey")} AS pkey_same`, query: true },
  { sql: indexes, query: true },
  {
    sql: `SELECT co.conname, ci.relname AS index_name FROM pg_constraint co JOIN pg_class ci ON ci.oid = co.conindid
          WHERE co.conrelid = (SELECT oid FROM pg_class WHERE relname = 't')`,
    query: true,
  },
]);

sequenceParity(
  "dropping a column, a table or a schema removes the indexes that depend on it",
  [
    "CREATE SCHEMA app",
    "CREATE TABLE app.t (id integer PRIMARY KEY, a integer, b integer)",
    "CREATE TABLE t (a integer, b integer, c integer)",
  ],
  [
    { sql: "CREATE INDEX t_a_idx ON t (a)" },
    { sql: "CREATE INDEX t_ab_idx ON t (a, b)" },
    { sql: "CREATE INDEX t_c_idx ON t (c) INCLUDE (a)" },
    { sql: "CREATE INDEX app_a_idx ON app.t (a)" },
    { sql: "ALTER TABLE t DROP COLUMN a" },
    { sql: pgIndexes, query: true },
    { sql: "DROP TABLE t" },
    { sql: pgIndexes, query: true },
    { sql: "DROP SCHEMA app CASCADE" },
    { sql: pgIndexes, query: true },
    {
      sql: `SELECT count(*) AS n FROM pg_index ix JOIN pg_class i ON i.oid = ix.indexrelid JOIN pg_namespace n ON n.oid = i.relnamespace WHERE ${USER}`,
      query: true,
    },
  ],
);

sequenceParity("index DDL in a rolled-back transaction leaves the catalog as it was", identity, [
  save("t_v_idx", "index"),
  { sql: "BEGIN" },
  { sql: "ALTER INDEX t_v_idx RENAME TO renamed_idx" },
  { sql: "CREATE INDEX extra_idx ON t (v, id)" },
  { sql: "ALTER TABLE t RENAME TO moved" },
  { sql: "ALTER TABLE moved ADD CONSTRAINT moved_v_key UNIQUE (v)" },
  { sql: pgIndexes, query: true },
  { sql: "ROLLBACK" },
  { sql: pgIndexes, query: true },
  { sql: `SELECT ${sameAs("t_v_idx", "index")} AS same`, query: true },
  // the rolled-back names are free again, and the table still enforces what it did before
  { sql: "CREATE INDEX extra_idx ON t (v)" },
  { sql: "INSERT INTO t VALUES (1, 1), (2, 1)" },
  { sql: "INSERT INTO t VALUES (1, 3)" },
]);

// --- 5. constraint-backed indexes are indexes in every catalog ---

parity("PRIMARY KEY and UNIQUE constraints have indexes in pg_class and pg_index", keyed, indexes);

parity("pg_indexes lists them with their definitions", keyed, pgIndexes);

parity(
  "pg_constraint.conindid points at the index, and only key constraints have one",
  keyed,
  `SELECT t.relname AS tablename, co.conname, co.contype, ci.relname AS index_name, ci.relkind,
          ix.indisprimary, ix.indisunique, co.conindid = 0 AS no_index
   FROM pg_constraint co JOIN pg_class t ON t.oid = co.conrelid JOIN pg_namespace n ON n.oid = t.relnamespace
   LEFT JOIN pg_class ci ON ci.oid = co.conindid AND co.contype IN ('p', 'u')
   LEFT JOIN pg_index ix ON ix.indexrelid = ci.oid
   WHERE ${USER} AND co.contype IN ('p', 'u', 'c') ORDER BY 1, 2`,
);

parity(
  "the same index shows in pg_stat_user_indexes and in the relhasindex / hasindexes flags",
  keyed,
  `SELECT s.relname, s.indexrelname, i.relname = s.indexrelname AS same_index, i.relkind, t.relhasindex, pt.hasindexes
   FROM pg_stat_user_indexes s JOIN pg_class i ON i.oid = s.indexrelid JOIN pg_class t ON t.oid = s.relid
   JOIN pg_tables pt ON pt.tablename = s.relname AND pt.schemaname = s.schemaname
   WHERE s.schemaname = 'public' ORDER BY 1, 2`,
);

parity(
  "all the catalogs agree on the set of indexes",
  keyed,
  `SELECT (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relkind = 'i' AND ${USER}) AS in_pg_class,
          (SELECT count(*) FROM pg_index ix JOIN pg_class c ON c.oid = ix.indexrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE ${USER}) AS in_pg_index,
          (SELECT count(*) FROM pg_indexes WHERE schemaname = 'public') AS in_pg_indexes,
          (SELECT count(*) FROM pg_stat_user_indexes WHERE schemaname = 'public') AS in_pg_stat_user_indexes`,
);

parity(
  "position overloads work on a constraint-backed index",
  keyed,
  `SELECT pg_get_indexdef(${oidOf("child_pk")}) AS whole, pg_get_indexdef(${oidOf("child_pk")}, 1, true) AS first,
          pg_get_indexdef(${oidOf("child_pk")}, 2, true) AS second, pg_get_indexdef(${oidOf("child_pk")}, 3, true) AS third,
          pg_get_indexdef(${oidOf("parent_ab")}, 0, true) AS pretty`,
);

sequenceParity(
  "ADD, RENAME and DROP CONSTRAINT create, rename and remove the index",
  ["CREATE TABLE saved (label text, oid bigint)", "CREATE TABLE t (id integer, a integer, b integer)"],
  [
    { sql: pgIndexes, query: true },
    { sql: "ALTER TABLE t ADD PRIMARY KEY (id)" },
    { sql: "ALTER TABLE t ADD CONSTRAINT t_ab_key UNIQUE (a, b)" },
    { sql: "ALTER TABLE t ADD UNIQUE NULLS NOT DISTINCT (b)" },
    { sql: indexes, query: true },
    save("t_ab_key", "unique"),
    { sql: "ALTER TABLE t RENAME CONSTRAINT t_ab_key TO t_ab_unique" },
    {
      sql: `SELECT ${sameAs("t_ab_unique", "unique")} AS same, (SELECT count(*) FROM pg_class WHERE relname = 't_ab_key') AS old_name`,
      query: true,
    },
    // renaming the index renames the constraint with it
    { sql: "ALTER INDEX t_pkey RENAME TO t_primary" },
    {
      sql: `SELECT conname, contype FROM pg_constraint WHERE conrelid = ${oidOf("t")} AND contype IN ('p', 'u') ORDER BY 1`,
      query: true,
    },
    { sql: pgIndexes, query: true },
    { sql: "ALTER TABLE t DROP CONSTRAINT t_ab_unique" },
    { sql: "ALTER TABLE t DROP CONSTRAINT t_primary" },
    { sql: pgIndexes, query: true },
    { sql: "ALTER TABLE t ADD CONSTRAINT t_primary PRIMARY KEY (id)" },
    { sql: `SELECT ${sameAs("t_primary", "unique")} AS reused_oid`, query: true },
    { sql: pgIndexes, query: true },
  ],
);

sequenceParity("the index of a constraint cannot be dropped on its own, and its name is taken", keyed, [
  { sql: "DROP INDEX parent_pkey" },
  { sql: "DROP INDEX parent_code_key" },
  { sql: "DROP INDEX IF EXISTS parent_ab" },
  { sql: "CREATE INDEX parent_pkey ON parent (a)" },
  { sql: "CREATE TABLE parent_code_key (x integer)" },
  { sql: pgIndexes, query: true },
]);

sequenceParity(
  "a constraint's index needs a free relation name: a written name is refused, a generated one moves on",
  [
    "CREATE TABLE t (id integer PRIMARY KEY, v integer)",
    "CREATE TABLE taken (id integer)",
    "CREATE TABLE other (id integer)",
  ],
  [
    { sql: "ALTER TABLE other ADD CONSTRAINT taken UNIQUE (id)" },
    { sql: "ALTER TABLE other ADD CONSTRAINT t_pkey PRIMARY KEY (id)" },
    { sql: "ALTER TABLE other ADD CONSTRAINT other_key UNIQUE (id)" },
    { sql: "ALTER TABLE other RENAME CONSTRAINT other_key TO taken" },
    { sql: "ALTER TABLE other RENAME CONSTRAINT other_key TO t_pkey" },
    { sql: "CREATE TABLE third (id integer, CONSTRAINT taken UNIQUE (id))" },
    { sql: "CREATE TABLE third (id integer, CONSTRAINT other_key UNIQUE (id))" },
    { sql: "CREATE TABLE third (id integer, CONSTRAINT third UNIQUE (id))" },
    // generated names step past a relation that is in the way
    { sql: "CREATE TABLE fifth_pkey (id integer)" },
    { sql: "CREATE TABLE fifth_v_key (id integer)" },
    { sql: "CREATE TABLE fifth (id integer PRIMARY KEY, v integer UNIQUE)" },
    { sql: "CREATE TABLE sixth_id_key (id integer)" },
    { sql: "CREATE TABLE sixth (id integer)" },
    { sql: "ALTER TABLE sixth ADD UNIQUE (id)" },
    // a CHECK constraint has no index, so its name only has to be unique on its table
    { sql: "ALTER TABLE other ADD CONSTRAINT taken CHECK (id > 0)" },
    { sql: pgIndexes, query: true },
    {
      sql: `SELECT t.relname, co.conname, co.contype FROM pg_constraint co JOIN pg_class t ON t.oid = co.conrelid
            JOIN pg_namespace n ON n.oid = t.relnamespace WHERE ${USER} AND co.contype IN ('p', 'u', 'c') ORDER BY 1, 2`,
      query: true,
    },
  ],
);

sequenceParity(
  "SET SCHEMA is refused when one of the table's indexes would collide in the target schema",
  ["CREATE SCHEMA app", "CREATE TABLE t (id integer PRIMARY KEY, v integer)", "CREATE INDEX t_v_idx ON t (v)"],
  [
    { sql: "CREATE TABLE app.t_v_idx (x integer)" },
    { sql: "ALTER TABLE t SET SCHEMA app" },
    { sql: pgIndexes, query: true },
    { sql: "DROP TABLE app.t_v_idx" },
    { sql: "CREATE SEQUENCE app.t_pkey" },
    { sql: "ALTER TABLE t SET SCHEMA app" },
    { sql: "DROP SEQUENCE app.t_pkey" },
    { sql: "ALTER TABLE t SET SCHEMA app" },
    { sql: pgIndexes, query: true },
  ],
);

sequenceParity("the constraint still enforces after the catalog work around it", keyed, [
  { sql: "INSERT INTO parent VALUES (1, 'a', 1, NULL)" },
  { sql: "INSERT INTO parent VALUES (1, 'b', 2, 2)" },
  { sql: "INSERT INTO parent VALUES (2, 'a', 2, 2)" },
  { sql: "INSERT INTO parent VALUES (3, 'c', 1, NULL)" },
  { sql: "ALTER INDEX parent_code_key RENAME TO parent_code_unique" },
  { sql: "INSERT INTO parent VALUES (4, 'a', 4, 4)" },
  { sql: "SELECT id, code FROM parent ORDER BY id", query: true },
]);

// --- snapshot reload (not differential: PGMM snapshots are this engine's own format) ---

const sqlStateOf = (run: () => unknown): string | undefined => {
  try {
    run();
  } catch (error) {
    return error instanceof PostgresError ? error.sqlState : String(error);
  }
  return undefined;
};

test("index oids, definitions and constraint links are identical after a snapshot round trip", () => {
  const db = new Database();
  let restored: Database | undefined;
  try {
    db.exec(keyed.join("; "));
    db.exec('CREATE SCHEMA "My Schema"; CREATE TABLE "My Schema".t (a integer, b text)');
    db.exec(
      `CREATE INDEX e_idx ON "My Schema".t USING hash (b); CREATE INDEX p_idx ON "My Schema".t (lower(b), (a + 1) DESC) INCLUDE (b) WITH (fillfactor = 70) WHERE a > 0`,
    );
    db.exec("ALTER INDEX child_label_idx RENAME TO child_label_renamed");
    const catalog = `SELECT n.nspname, i.relname, i.oid, ix.indrelid, pg_get_indexdef(i.oid) AS def, i.relam, co.conname
      FROM pg_index ix JOIN pg_class i ON i.oid = ix.indexrelid JOIN pg_namespace n ON n.oid = i.relnamespace
      LEFT JOIN pg_constraint co ON co.conindid = i.oid ORDER BY 1, 2`;
    const before = db.query<{ oid: number; indrelid: number; relname: string; conname: string | null }>(catalog);
    expect(before.map((row) => [row.relname, row.conname])).toEqual([
      ["e_idx", null],
      ["p_idx", null],
      ["child_label_renamed", null],
      ["child_pk", "child_pk"],
      ["parent_ab", "parent_ab"],
      ["parent_code_key", "parent_code_key"],
      ["parent_pkey", "parent_pkey"],
    ]);
    expect(new Set(before.map((row) => row.oid)).size).toBe(before.length);
    restored = Snapshot.decode(db.snapshot().encode()).open();
    expect(restored.query(catalog)).toEqual(before);
    // a second generation is the same again: nothing is re-derived differently on load
    const second = Snapshot.decode(restored.snapshot().encode()).open();
    try {
      expect(second.query(catalog)).toEqual(before);
    } finally {
      second.close();
    }
    // a new index on the restored database gets an oid no existing relation has
    restored.exec("CREATE INDEX after_restore_idx ON parent (a)");
    const fresh = restored.query<{ oid: number }>("SELECT oid FROM pg_class WHERE relname = 'after_restore_idx'")[0]!
      .oid;
    const taken = restored.query<{ oid: number }>("SELECT oid FROM pg_class WHERE relname <> 'after_restore_idx'");
    expect(taken.map((row) => row.oid)).not.toContain(fresh);
    // and the restored constraints still enforce through their indexes
    restored.exec("INSERT INTO parent VALUES (1, 'a', 1, 1)");
    expect(sqlStateOf(() => restored!.exec("INSERT INTO parent VALUES (1, 'b', 2, 2)"))).toBe("23505");
  } finally {
    restored?.close();
    db.close();
  }
});

test("a snapshot written before indexes had their own identity loads with distinct index oids", () => {
  const db = new Database();
  let restored: Database | undefined;
  try {
    db.exec("CREATE TABLE t (id integer PRIMARY KEY, v text UNIQUE, w integer); CREATE INDEX t_w_idx ON t (w)");
    db.exec("INSERT INTO t VALUES (1, 'a', 1)");
    // put the state back in the shape older snapshots have: no index oids, no table link, and no
    // catalog entry for the indexes behind constraints
    for (const schema of db.state.schemas.values()) {
      for (const [name, index] of [...schema.indexes]) {
        if (index.isConstraint) schema.indexes.delete(name);
        else {
          const { oid: _oid, tableOid: _tableOid, ...legacy } = index;
          schema.indexes.set(name, legacy);
        }
      }
      for (const table of schema.tables.values()) {
        for (const constraint of table.constraints) {
          if (constraint.kind === "primary_key" || constraint.kind === "unique") delete constraint.indexOid;
        }
      }
    }
    restored = Snapshot.decode(db.snapshot().encode()).open();
    const rows = restored.query<{ relname: string; oid: number; indrelid: number; def: string }>(
      `SELECT i.relname, i.oid, ix.indrelid, pg_get_indexdef(i.oid) AS def
       FROM pg_index ix JOIN pg_class i ON i.oid = ix.indexrelid ORDER BY 1`,
    );
    expect(rows.map((row) => row.def)).toEqual([
      "CREATE UNIQUE INDEX t_pkey ON public.t USING btree (id)",
      "CREATE UNIQUE INDEX t_v_key ON public.t USING btree (v)",
      "CREATE INDEX t_w_idx ON public.t USING btree (w)",
    ]);
    const table = restored.query<{ oid: number }>("SELECT oid FROM pg_class WHERE relname = 't'")[0]!.oid;
    expect(rows.every((row) => row.indrelid === table && row.oid !== table)).toBe(true);
    expect(new Set(rows.map((row) => row.oid)).size).toBe(3);
    expect(sqlStateOf(() => restored!.exec("INSERT INTO t VALUES (1, 'b', 2)"))).toBe("23505");
    expect(sqlStateOf(() => restored!.exec("INSERT INTO t VALUES (2, 'a', 2)"))).toBe("23505");
  } finally {
    restored?.close();
    db.close();
  }
});
