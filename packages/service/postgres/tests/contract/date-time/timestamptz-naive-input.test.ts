import { parity, sequenceParity } from "../helpers.ts";

// A timestamptz literal without a zone takes the session TimeZone. Found while deparsing
// partial-index predicates (#330): this input path raised a TypeError instead of parsing.

parity(
  "a zone-less literal casts to timestamptz in the session zone",
  [],
  "SELECT '2020-01-01'::timestamptz AS day, '2020-06-15 12:30:00'::timestamptz AS moment, timestamptz '2020-01-01 00:00' AS typed",
);

parity(
  "a zone-less literal compares against a timestamptz value",
  [],
  "SELECT '2020-01-01 00:00:00+00'::timestamptz > '2019-12-31' AS later, '2020-01-01 00:00:00+00'::timestamptz = '2020-01-01' AS same",
);

sequenceParity(
  "a zone-less literal is stored in a timestamptz column and read back per session zone",
  ["CREATE TABLE events (id integer, at timestamptz)"],
  [
    { sql: "INSERT INTO events VALUES (1, '2020-01-01'), (2, '2020-07-01 12:00:00')" },
    { sql: "SELECT id, at FROM events WHERE at > '2020-03-01' ORDER BY id", query: true },
    { sql: "SET TIME ZONE 'America/New_York'" },
    { sql: "INSERT INTO events VALUES (3, '2020-01-01'), (4, '2020-07-01 12:00:00')" },
    { sql: "SELECT id, at FROM events ORDER BY id", query: true },
    { sql: "SET TIME ZONE 'UTC'" },
    { sql: "SELECT id, at FROM events ORDER BY id", query: true },
  ],
);

sequenceParity(
  "a partial index may state its predicate with a zone-less timestamptz literal",
  [
    "CREATE TABLE events (id integer, at timestamptz)",
    "INSERT INTO events VALUES (1, '2020-01-01'), (1, '2019-01-01')",
  ],
  [
    { sql: "CREATE UNIQUE INDEX recent_events ON events (id) WHERE at >= '2020-01-01'" },
    { sql: "SELECT indexdef FROM pg_indexes WHERE indexname = 'recent_events'", query: true },
    { sql: "INSERT INTO events VALUES (1, '2021-01-01')" },
    { sql: "INSERT INTO events VALUES (1, '2018-01-01')" },
  ],
);
