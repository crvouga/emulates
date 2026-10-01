import { queryErrorParity, sequenceParity } from "../helpers.ts";

sequenceParity(
  "PostgreSQL dump and migration GUC preambles do not abort schema imports",
  [],
  [
    { sql: "SET lock_timeout = 0" },
    { sql: "SET idle_in_transaction_session_timeout = 0" },
    { sql: "SET transaction_timeout = 0" },
    { sql: "SET statement_timeout = 0" },
    { sql: "SET client_encoding = 'UTF8'" },
    { sql: "SET standard_conforming_strings = on" },
    { sql: "SET check_function_bodies = false" },
    { sql: "SET xmloption = content" },
    { sql: "SET client_min_messages = warning" },
    { sql: "SET row_security = off" },
    { sql: "CREATE TABLE guc_preamble_probe (id int)" },
    { sql: "INSERT INTO guc_preamble_probe VALUES (1)" },
    { sql: "SELECT count(*)::int AS n FROM guc_preamble_probe", query: true },
  ],
);

sequenceParity(
  "SHOW, current_setting, and set_config agree for tooling GUCs",
  [],
  [
    { sql: "SET lock_timeout = '250ms'" },
    { sql: "SHOW lock_timeout", query: true },
    { sql: "SELECT current_setting('lock_timeout') AS v", query: true },
    { sql: "SELECT set_config('lock_timeout', '0', false) AS v", query: true },
    { sql: "SHOW lock_timeout", query: true },
  ],
);

sequenceParity(
  "SET LOCAL tooling GUCs restore the session value after COMMIT",
  [],
  [
    { sql: "SET lock_timeout = '1s'" },
    { sql: "BEGIN" },
    { sql: "SET LOCAL lock_timeout = '2s'" },
    { sql: "SHOW lock_timeout", query: true },
    { sql: "COMMIT" },
    { sql: "SHOW lock_timeout", query: true },
  ],
);

queryErrorParity(
  "unknown unqualified GUCs remain rejected",
  [],
  "SHOW definitely_not_a_postgres_guc",
  "undefined_object",
);
