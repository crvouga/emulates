import { errorParity, parity, queryErrorParity, sequenceParity } from "../helpers.ts";

// encode, decode, get_byte, set_byte, substring, and convert_to are already
// differential-tested in tests/contract/bytea and tests/contract/strings.
// The composed query below only checks they accept digest() output.

sequenceParity(
  "CREATE EXTENSION pgcrypto installs digest and IF NOT EXISTS is a no-op",
  [],
  [
    { sql: "CREATE EXTENSION IF NOT EXISTS pgcrypto" },
    { sql: "SELECT public.digest('abc'::bytea, 'sha1') AS v", query: true },
    { sql: "SELECT encode(public.digest('abc'::bytea, 'sha1'), 'hex') AS v", query: true },
    { sql: "CREATE EXTENSION IF NOT EXISTS pgcrypto" },
    { sql: "SELECT encode(digest('abc'::bytea, 'SHA-1'), 'hex') AS v", query: true },
  ],
);

queryErrorParity(
  "digest without pgcrypto is undefined_function",
  [],
  "SELECT public.digest('abc'::bytea, 'sha1')",
  "undefined_function",
);

parity(
  "digest sha1 composes with bytea helpers",
  ["CREATE EXTENSION pgcrypto"],
  `SELECT
     encode(set_byte(substring(digest('abc'::bytea, 'sha1') FROM 1 FOR 16), 0, get_byte(digest('abc'::bytea, 'sha1'), 0)), 'hex') AS edited,
     encode(decode(encode(digest('abc'::bytea, 'sha1'), 'hex'), 'hex'), 'hex') AS roundtrip,
     encode(digest(convert_to('héllo', 'UTF8'), 'sha1'), 'hex') AS conv`,
);

parity(
  "digest text and bytea overloads and standard algorithms",
  ["CREATE EXTENSION pgcrypto"],
  `SELECT
     encode(digest('abc', 'sha1'), 'hex') AS text_sha1,
     encode(digest('héllo', 'sha1'), 'hex') AS text_utf8,
     encode(digest(''::bytea, 'sha1'), 'hex') AS empty_sha1,
     encode(digest('\\x000102ff'::bytea, 'md5'), 'hex') AS md5,
     encode(digest('abc'::bytea, 'sha224'), 'hex') AS sha224,
     encode(digest('abc'::bytea, 'sha256'), 'hex') AS sha256,
     encode(digest('abc'::bytea, 'sha384'), 'hex') AS sha384,
     encode(digest('abc'::bytea, 'sha512'), 'hex') AS sha512,
     encode(digest(repeat('x', 200)::bytea, 'sha1'), 'hex') AS long_sha1`,
);

parity(
  "digest is strict",
  ["CREATE EXTENSION pgcrypto"],
  "SELECT digest(NULL::bytea, 'sha1') IS NULL AS a, digest('abc'::bytea, NULL::text) IS NULL AS b",
);

queryErrorParity(
  "digest rejects an unknown algorithm",
  ["CREATE EXTENSION pgcrypto"],
  "SELECT digest('abc'::bytea, 'nope')",
  "invalid_parameter",
);

errorParity(
  "CREATE EXTENSION pgcrypto errors when already installed",
  ["CREATE EXTENSION pgcrypto"],
  "CREATE EXTENSION pgcrypto",
  "duplicate_object",
);

errorParity("unknown extensions are not available", [], "CREATE EXTENSION nosuch", "unsupported");

errorParity(
  "CREATE EXTENSION pgcrypto requires the schema to exist",
  [],
  "CREATE EXTENSION pgcrypto SCHEMA nosuch",
  "undefined_object",
);

sequenceParity(
  "pgcrypto installs into the schema clause and search_path",
  [],
  [
    { sql: "CREATE SCHEMA app" },
    { sql: "CREATE EXTENSION pgcrypto SCHEMA app" },
    { sql: "SELECT encode(app.digest('abc'::bytea, 'sha1'), 'hex') AS v", query: true },
    { sql: "DROP EXTENSION pgcrypto" },
    { sql: "SET search_path TO app, public" },
    { sql: "CREATE EXTENSION pgcrypto" },
    { sql: "SELECT encode(digest('abc'::bytea, 'sha1'), 'hex') AS v", query: true },
  ],
);

sequenceParity(
  "DROP EXTENSION pgcrypto removes digest",
  ["CREATE EXTENSION pgcrypto"],
  [
    { sql: "DROP EXTENSION pgcrypto" },
    { sql: "SELECT public.digest('abc'::bytea, 'sha1')" },
    { sql: "DROP EXTENSION IF EXISTS pgcrypto" },
  ],
);

errorParity("DROP EXTENSION of a missing extension errors", [], "DROP EXTENSION pgcrypto", "undefined_object");

sequenceParity(
  "CREATE EXTENSION pgcrypto rolls back with the transaction",
  [],
  [
    { sql: "BEGIN" },
    { sql: "CREATE EXTENSION pgcrypto" },
    { sql: "SELECT encode(digest('abc'::bytea, 'sha1'), 'hex') AS v", query: true },
    { sql: "ROLLBACK" },
    { sql: "SELECT public.digest('abc'::bytea, 'sha1')" },
  ],
);
