import type { AnalyzeStmt, ReindexStmt, Statement } from "../ast/nodes.ts";
import { uniqueKeyOf, uniqueSpecOfIndex } from "../constraints/enforce.ts";
import { PostgresError, pgError } from "../errors/error.ts";
import { databaseCatalogContext } from "../runtime/database-context.ts";
import { constraintOfIndex, findIndex, otherRelationKind } from "../schema/index-catalog.ts";
import type { DatabaseState, IndexMeta, SchemaData, TableData } from "../storage/database-state.ts";
import { commandResult, type ExecEnv, type ExecResult } from "./relation.ts";

// ---------------------------------------------------------------------------
// index builds
// ---------------------------------------------------------------------------

/**
 * Commands PostgreSQL refuses inside a transaction block, named as its 25001 message
 * names them. The sync API and the wire server both check this before running a statement,
 * because each tracks the transaction block in its own way.
 */
export function refusedInTransactionBlock(stmt: Statement): string | null {
  if (stmt.type === "create_index" && stmt.concurrently) return "CREATE INDEX CONCURRENTLY";
  if (stmt.type === "drop" && stmt.kind === "index" && stmt.concurrently) return "DROP INDEX CONCURRENTLY";
  if (stmt.type === "reindex") {
    if (stmt.concurrently) return "REINDEX CONCURRENTLY";
    if (stmt.kind !== "index" && stmt.kind !== "table") return `REINDEX ${stmt.kind.toUpperCase()}`;
  }
  return null;
}

/** A statement whose failure must keep what it wrote: the invalid index a concurrent build leaves behind. */
export function leavesInvalidIndexOnFailure(stmt: Statement): boolean {
  return (stmt.type === "create_index" || stmt.type === "reindex") && stmt.concurrently;
}

const FAULT_MESSAGES: Record<string, string> = {
  "57014": "canceling statement due to user request",
  "40P01": "deadlock detected",
};

/**
 * Take the armed `concurrentIndexBuild` fault, if any: the error an interrupted concurrent
 * build ends with. PostgreSQL leaves the index it was building in the catalog, invalid.
 */
export function takeConcurrentBuildFault(state: DatabaseState): PostgresError | null {
  const code = state.faults.concurrentIndexBuild;
  if (code === undefined) return null;
  state.faults.concurrentIndexBuild = undefined;
  return new PostgresError("internal", FAULT_MESSAGES[code] ?? "concurrent index build interrupted", code);
}

/** Raise 23505 when the rows of `table` cannot satisfy unique index `index`, as an index build does. */
export function assertUniqueIndexBuildable(env: ExecEnv, table: TableData, index: IndexMeta, name = index.name): void {
  if (!index.unique) return;
  const spec = uniqueSpecOfIndex(table, index);
  const seen = new Set<string>();
  for (let i = 0; i < table.rowCount(); i++) {
    const key = uniqueKeyOf(env, table, spec, table.rowAt(i));
    if (key === null) continue;
    if (seen.has(key)) throw pgError("constraint_unique", `could not create unique index "${name}"`, "23505");
    seen.add(key);
  }
}

function relationMissing(state: DatabaseState, parts: readonly string[]): never {
  if (parts.length >= 2) state.getSchema(parts[parts.length - 2]!);
  throw pgError("undefined_table", `relation "${parts.join(".")}" does not exist`, "42P01");
}

/** `name_ccnew`, the transient index REINDEX CONCURRENTLY builds and leaves behind when it fails. */
function transientName(schema: SchemaData, name: string): string {
  const base = `${name}_ccnew`;
  if (!schema.hasRelation(base)) return base;
  for (let i = 1; ; i++) {
    if (!schema.hasRelation(`${base}${i}`)) return `${base}${i}`;
  }
}

function tableOfIndex(schema: SchemaData, index: IndexMeta): TableData {
  const table = schema.tables.get(index.table);
  if (!table) throw pgError("internal", `index "${index.name}" has no table`);
  return table;
}

function rebuildConcurrently(env: ExecEnv, schema: SchemaData, index: IndexMeta): void {
  const state = env.ctx.state;
  const table = tableOfIndex(schema, index);
  let failure = takeConcurrentBuildFault(state);
  const transient = transientName(schema, index.name);
  if (!failure) {
    try {
      assertUniqueIndexBuildable(env, table, index, transient);
    } catch (error) {
      failure = error as PostgresError;
    }
  }
  if (failure) {
    const { comment: _comment, scans: _scans, lastScan: _lastScan, ...definition } = index;
    schema.indexes.set(transient, {
      ...definition,
      oid: state.nextOid(),
      name: transient,
      isConstraint: false,
      valid: false,
    });
    throw failure;
  }
  // The rebuilt index is a new relation that takes over the name, comment and constraint.
  const oid = state.nextOid();
  const owner = constraintOfIndex(state, index);
  if (owner) {
    const writable = state.ensureWritableTable(owner.table);
    for (const constraint of writable.constraints) {
      if ((constraint.kind === "primary_key" || constraint.kind === "unique") && constraint.indexOid === index.oid) {
        constraint.indexOid = oid;
      }
    }
  }
  schema.indexes.set(index.name, { ...index, oid, valid: true });
  table.indexStores = null;
}

function rebuild(schema: SchemaData, index: IndexMeta): void {
  if (index.valid === false) schema.indexes.set(index.name, { ...index, valid: true });
  tableOfIndex(schema, index).indexStores = null;
}

/** Rebuild a set of indexes as one command: nothing changes unless every one can be built. */
function rebuildAll(
  env: ExecEnv,
  targets: Array<{ schema: SchemaData; index: IndexMeta }>,
  concurrently: boolean,
): void {
  if (concurrently) {
    // REINDEX CONCURRENTLY of more than one index skips the invalid ones (with a WARNING)
    for (const { schema, index } of targets) {
      if (index.valid !== false) rebuildConcurrently(env, schema, index);
    }
    return;
  }
  for (const { schema, index } of targets) assertUniqueIndexBuildable(env, tableOfIndex(schema, index), index);
  for (const { schema, index } of targets) rebuild(schema, index);
}

export function executeReindex(env: ExecEnv, stmt: ReindexStmt): ExecResult {
  const state = env.ctx.state;
  const refused = state.inTransaction ? refusedInTransactionBlock(stmt) : null;
  if (refused) throw pgError("misuse", `${refused} cannot run inside a transaction block`, "25001");
  const done = commandResult("REINDEX", 0);
  switch (stmt.kind) {
    case "index": {
      const found = findIndex(state, stmt.name!);
      if (!found) {
        if (otherRelationKind(state, stmt.name!)) {
          throw pgError("wrong_object_type", `"${stmt.name!.at(-1)}" is not an index`, "42809");
        }
        relationMissing(state, stmt.name!);
      }
      if (stmt.concurrently) rebuildConcurrently(env, found.schema, found.index);
      else rebuildAll(env, [found], false);
      return done;
    }
    case "table": {
      const table = state.findTable(stmt.name!);
      if (!table) {
        const view = state.findView(stmt.name!);
        if (view?.materialized) return done;
        if (view || findIndex(state, stmt.name!) || otherRelationKind(state, stmt.name!)) {
          throw pgError("wrong_object_type", `"${stmt.name!.at(-1)}" is not a table or materialized view`, "42809");
        }
        relationMissing(state, stmt.name!);
      }
      const schema = state.getSchema(table.schema);
      const targets = [...schema.indexes.values()]
        .filter((index) => index.table === table.name)
        .map((index) => ({ schema, index }));
      rebuildAll(env, targets, stmt.concurrently);
      return done;
    }
    case "schema": {
      const schema = state.getSchema(stmt.name!.at(-1)!);
      rebuildAll(
        env,
        [...schema.indexes.values()].map((index) => ({ schema, index })),
        stmt.concurrently,
      );
      return done;
    }
    case "database":
    case "system": {
      if (stmt.name && stmt.name.at(-1) !== databaseCatalogContext(state).name) {
        throw pgError("feature_not_supported", "can only reindex the currently open database", "0A000");
      }
      // SYSTEM covers only the system catalogs, which have no rebuildable indexes here
      if (stmt.kind === "system") return done;
      const targets = [...state.schemas.values()].flatMap((schema) =>
        [...schema.indexes.values()].map((index) => ({ schema, index })),
      );
      rebuildAll(env, targets, stmt.concurrently);
      return done;
    }
  }
}

// ---------------------------------------------------------------------------
// ANALYZE
// ---------------------------------------------------------------------------

function markAnalyzed(state: DatabaseState, oid: number): void {
  const previous = state.tableStats.get(oid);
  state.tableStats.set(oid, {
    analyzeCount: (previous?.analyzeCount ?? 0) + 1,
    lastAnalyze: state.clock().getTime(),
  });
}

/**
 * ANALYZE. The planner statistics it gathers have no counterpart here; what it leaves
 * is the per-table bookkeeping pg_stat_user_tables reports (analyze_count, last_analyze).
 */
export function executeAnalyze(env: ExecEnv, stmt: AnalyzeStmt): ExecResult {
  const state = env.ctx.state;
  const done = commandResult("ANALYZE", 0);
  if (stmt.targets.length === 0) {
    for (const schema of state.schemas.values()) {
      for (const table of schema.tables.values()) markAnalyzed(state, table.oid);
      for (const view of schema.views.values()) if (view.materialized) markAnalyzed(state, view.oid);
    }
    return done;
  }
  // every target is checked before any is analyzed
  const oids: number[] = [];
  for (const target of stmt.targets) {
    const table = state.findTable(target.table);
    if (!table) {
      const view = state.findView(target.table);
      if (view?.materialized) oids.push(view.oid);
      // PostgreSQL skips views, indexes and sequences with a WARNING
      else if (!view && !findIndex(state, target.table) && !otherRelationKind(state, target.table)) {
        relationMissing(state, target.table);
      }
      continue;
    }
    const seen = new Set<string>();
    for (const column of target.columns ?? []) {
      if (table.columnIndex(column) === -1) {
        throw pgError("undefined_column", `column "${column}" of relation "${table.name}" does not exist`, "42703");
      }
      if (seen.has(column)) {
        throw pgError(
          "duplicate_column",
          `column "${column}" of relation "${table.name}" appears more than once`,
          "42701",
        );
      }
      seen.add(column);
    }
    oids.push(table.oid);
  }
  for (const oid of oids) markAnalyzed(state, oid);
  return done;
}
