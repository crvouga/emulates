import type { CatalogCase } from "./run.ts";

/**
 * Extension catalogs (#334). Listed in the CAT section of the scenario
 * catalog; the behavior-by-behavior proof is in
 * tests/contract/extensions/catalogs.test.ts.
 */
export const EXTENSION_CASES: CatalogCase[] = [
  {
    id: "CAT-ext-01",
    kind: "parity",
    sql: "SELECT name, default_version, installed_version, comment FROM pg_available_extensions ORDER BY name",
  },
  {
    id: "CAT-ext-02",
    kind: "parity",
    setup: ["CREATE TABLE kv (id integer, value text)"],
    sql: "SELECT default_version FROM pg_available_extensions WHERE name = 'hypopg'",
  },
  {
    id: "CAT-ext-03",
    kind: "sequence",
    steps: [
      { sql: "CREATE EXTENSION pgcrypto" },
      {
        sql: "SELECT e.extname, e.extversion, n.nspname FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace ORDER BY 1",
        query: true,
      },
      { sql: "DROP EXTENSION pgcrypto" },
      { sql: "SELECT extname, extversion FROM pg_extension ORDER BY 1", query: true },
      { sql: "SELECT installed_version FROM pg_available_extensions WHERE name = 'pgcrypto'", query: true },
    ],
  },
  {
    id: "CAT-ext-04",
    kind: "error",
    sql: "CREATE EXTENSION hypopg",
    messageTier: "A",
  },
];
