import type { DatabaseState } from "../storage/database-state.ts";

export type DatabaseCatalogContext = {
  name: string;
  names: () => readonly string[];
};

const contexts = new WeakMap<DatabaseState, DatabaseCatalogContext>();
const fallback: DatabaseCatalogContext = { name: "postgres", names: () => ["postgres"] };

/** @internal Wire-cluster catalog metadata used by SQL functions and catalog views. */
export function databaseCatalogContext(state: DatabaseState): DatabaseCatalogContext {
  return contexts.get(state) ?? fallback;
}

/** @internal Attach an engine to its owning wire cluster. */
export function setDatabaseCatalogContext(state: DatabaseState, context: DatabaseCatalogContext): void {
  contexts.set(state, context);
}
