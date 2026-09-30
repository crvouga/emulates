import { errorParity, queryErrorParity, sequenceParity } from "../helpers.ts";

const populatedProbe = (name: string): string =>
  "SELECT c.relkind = 'm' AS is_m, c.relispopulated " +
  "FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace " +
  `WHERE n.nspname = 'public' AND c.relname = '${name}'`;

sequenceParity(
  "materialized view snapshots data",
  ["CREATE TABLE t (id int)", "INSERT INTO t VALUES (1), (2)"],
  [
    { sql: "CREATE MATERIALIZED VIEW mv AS SELECT id FROM t" },
    { sql: "INSERT INTO t VALUES (3)" },
    { sql: "SELECT id FROM mv ORDER BY id", query: true },
    { sql: "SELECT id FROM t ORDER BY id", query: true },
  ],
);

sequenceParity(
  "REFRESH MATERIALIZED VIEW picks up changes",
  ["CREATE TABLE t (id int)", "INSERT INTO t VALUES (1)"],
  [
    { sql: "CREATE MATERIALIZED VIEW mv AS SELECT id FROM t" },
    { sql: "INSERT INTO t VALUES (2)" },
    { sql: "SELECT id FROM mv ORDER BY id", query: true },
    { sql: "REFRESH MATERIALIZED VIEW mv" },
    { sql: "SELECT id FROM mv ORDER BY id", query: true },
  ],
);

queryErrorParity(
  "matview WITH NO DATA is unscannable",
  ["CREATE TABLE t (id int)", "CREATE MATERIALIZED VIEW mv AS SELECT id FROM t WITH NO DATA"],
  "SELECT * FROM mv",
);

sequenceParity(
  "REFRESH populates WITH NO DATA matview",
  ["CREATE TABLE t (id int)", "INSERT INTO t VALUES (5)"],
  [
    { sql: "CREATE MATERIALIZED VIEW mv AS SELECT id FROM t WITH NO DATA" },
    { sql: "REFRESH MATERIALIZED VIEW mv" },
    { sql: "SELECT id FROM mv ORDER BY id", query: true },
  ],
);

sequenceParity(
  "matview with aggregate",
  ["CREATE TABLE t (grp text, n int)", "INSERT INTO t VALUES ('a', 1), ('a', 2), ('b', 3)"],
  [
    { sql: "CREATE MATERIALIZED VIEW mv AS SELECT grp, sum(n) AS total FROM t GROUP BY grp" },
    { sql: "SELECT grp, total FROM mv ORDER BY grp", query: true },
  ],
);

sequenceParity(
  "DROP MATERIALIZED VIEW",
  ["CREATE TABLE t (id int)", "CREATE MATERIALIZED VIEW mv AS SELECT id FROM t"],
  [{ sql: "DROP MATERIALIZED VIEW mv" }, { sql: "SELECT count(*) FROM t", query: true }],
  { compareFinalState: true },
);

sequenceParity(
  "WITH NO DATA is relkind m until refresh populates it",
  [],
  [
    { sql: "CREATE MATERIALIZED VIEW public.example AS SELECT 1 AS n WITH NO DATA" },
    { sql: populatedProbe("example"), query: true },
    { sql: "REFRESH MATERIALIZED VIEW public.example" },
    { sql: populatedProbe("example"), query: true },
    { sql: "SELECT n FROM public.example", query: true },
  ],
);

sequenceParity(
  "WITH DATA reports relispopulated and keeps the snapshot",
  ["CREATE TABLE t (id int)", "INSERT INTO t VALUES (1)"],
  [
    { sql: "CREATE MATERIALIZED VIEW public.example AS SELECT id FROM t WITH DATA" },
    { sql: populatedProbe("example"), query: true },
    { sql: "INSERT INTO t VALUES (2)" },
    { sql: "SELECT id FROM public.example ORDER BY id", query: true },
  ],
);

sequenceParity(
  "later matviews can read earlier unpopulated matviews",
  ["CREATE TABLE t (id int)", "INSERT INTO t VALUES (1), (2)"],
  [
    { sql: "CREATE MATERIALIZED VIEW a AS SELECT id FROM t WITH NO DATA" },
    { sql: "CREATE MATERIALIZED VIEW b AS SELECT id, id + 1 AS n FROM a WITH NO DATA" },
    { sql: "CREATE MATERIALIZED VIEW c AS SELECT n FROM b WITH NO DATA" },
    { sql: populatedProbe("a"), query: true },
    { sql: populatedProbe("c"), query: true },
    { sql: "REFRESH MATERIALIZED VIEW a" },
    { sql: "REFRESH MATERIALIZED VIEW b" },
    { sql: "REFRESH MATERIALIZED VIEW c" },
    { sql: "SELECT n FROM c ORDER BY n", query: true },
  ],
);

sequenceParity(
  "unpopulated matview is visible through a subquery, CTE, and view",
  ["CREATE TABLE t (id int)", "INSERT INTO t VALUES (7)"],
  [
    { sql: "CREATE MATERIALIZED VIEW src AS SELECT id FROM t WITH NO DATA" },
    { sql: "CREATE VIEW mid AS SELECT id FROM src" },
    { sql: "CREATE MATERIALIZED VIEW via_view AS SELECT id FROM mid WITH NO DATA" },
    { sql: "CREATE MATERIALIZED VIEW via_sub AS SELECT id FROM (SELECT id FROM src) s WITH NO DATA" },
    { sql: "CREATE MATERIALIZED VIEW via_cte AS WITH s AS (SELECT id FROM src) SELECT id FROM s WITH NO DATA" },
    { sql: "REFRESH MATERIALIZED VIEW src" },
    { sql: "REFRESH MATERIALIZED VIEW via_view" },
    { sql: "REFRESH MATERIALIZED VIEW via_sub" },
    { sql: "REFRESH MATERIALIZED VIEW via_cte" },
    { sql: "SELECT id FROM via_view", query: true },
    { sql: "SELECT id FROM via_sub", query: true },
    { sql: "SELECT id FROM via_cte", query: true },
  ],
);

errorParity(
  "refresh of a dependent matview fails while its source is unpopulated",
  [
    "CREATE TABLE t (id int)",
    "INSERT INTO t VALUES (1)",
    "CREATE MATERIALIZED VIEW src AS SELECT id FROM t WITH NO DATA",
    "CREATE MATERIALIZED VIEW dep AS SELECT id FROM src WITH NO DATA",
  ],
  "REFRESH MATERIALIZED VIEW dep",
);

errorParity(
  "WITH DATA cannot read an unpopulated matview",
  ["CREATE TABLE t (id int)", "CREATE MATERIALIZED VIEW src AS SELECT id FROM t WITH NO DATA"],
  "CREATE MATERIALIZED VIEW dep AS SELECT id FROM src",
);

sequenceParity(
  "COMMENT ON MATERIALIZED VIEW does not abort",
  [],
  [
    { sql: "CREATE MATERIALIZED VIEW public.example AS SELECT 1 AS n WITH NO DATA" },
    { sql: "COMMENT ON MATERIALIZED VIEW public.example IS 'fixture'" },
    { sql: "COMMENT ON MATERIALIZED VIEW public.example IS NULL" },
    { sql: populatedProbe("example"), query: true },
  ],
);
