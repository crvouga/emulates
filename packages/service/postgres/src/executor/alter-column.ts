import type { AlterTableAction, AlterTableStmt, Expr } from "../ast/nodes.ts";
import { pgError, unsupported } from "../errors/error.ts";
import { isAggregateName } from "../functions/aggregates.ts";
import { hasScalarFunction } from "../functions/scalar.ts";
import {
  assertSequenceNotTemporary,
  ownedSequences,
  prepareLoggedChange,
  relPersistence,
} from "../schema/persistence.ts";
import { resolveStorage } from "../schema/storage.ts";
import { defaultExprType, isNullDefault } from "../sql/deparse-default.ts";
import type { ColumnMeta, DatabaseState, SequenceData, TableData } from "../storage/database-state.ts";
import { canAssignCast, castTo } from "../types/cast.ts";
import { type TypeId, tv, typeDisplayName, UNKNOWN } from "../types/value.ts";
import type { ExecEnv } from "./relation.ts";

/**
 * `ALTER TABLE` forms that change column and relation metadata rather than
 * rows: SET / DROP DEFAULT, DROP NOT NULL, SET STORAGE and SET LOGGED /
 * UNLOGGED. Each reports PostgreSQL's error for a target it does not accept.
 */

const SYSTEM_COLUMNS: ReadonlySet<string> = new Set(["tableoid", "cmax", "xmax", "cmin", "xmin", "ctid"]);

/** The named user column, or PostgreSQL's error for a system or missing one. */
export function alterableColumn(table: TableData, name: string): ColumnMeta {
  const column = table.columns[table.columnIndex(name)];
  if (column) return column;
  if (SYSTEM_COLUMNS.has(name)) {
    throw pgError("feature_not_supported", `cannot alter system column "${name}"`, "0A000");
  }
  throw pgError("undefined_column", `column "${name}" of relation "${table.name}" does not exist`, "42703");
}

// --- relations that are not tables ----------------------------------------------

function actionLabel(action: AlterTableAction): string | null {
  switch (action.kind) {
    case "set_not_null":
      return "ALTER COLUMN ... SET NOT NULL";
    case "drop_not_null":
      return "ALTER COLUMN ... DROP NOT NULL";
    case "set_storage":
      return "ALTER COLUMN ... SET STORAGE";
    case "set_logged":
      return action.logged ? "SET LOGGED" : "SET UNLOGGED";
    default:
      return null;
  }
}

/** `ALTER SEQUENCE ... SET LOGGED | UNLOGGED`, also reachable as `ALTER TABLE <sequence> SET ...`. */
export function setSequenceLogged(state: DatabaseState, seq: SequenceData, logged: boolean): void {
  assertSequenceNotTemporary(seq);
  const isLogged = seq.unlogged !== true;
  if (isLogged === logged) return;
  const writable = state.ensureWritableSequence(seq);
  if (logged) delete writable.unlogged;
  else writable.unlogged = true;
}

/**
 * `ALTER TABLE` named something that is not a table. Returns true when the
 * statement was carried out against a sequence; throws PostgreSQL's
 * wrong-object-type error for the actions views do not accept; otherwise
 * returns false and the caller reports the relation as it always has.
 */
export function alterNonTableRelation(state: DatabaseState, stmt: AlterTableStmt): boolean {
  const seq = state.findSequence(stmt.table);
  if (seq && stmt.actions.every((action) => action.kind === "set_logged")) {
    let changed = false;
    for (const action of stmt.actions) {
      if (action.kind !== "set_logged") continue;
      if (changed) throw pgError("feature_not_supported", "cannot change persistence setting twice", "0A000");
      assertSequenceNotTemporary(seq);
      const current = state.findSequence(stmt.table) ?? seq;
      changed = (current.unlogged !== true) !== action.logged;
      if (changed) setSequenceLogged(state, current, action.logged);
    }
    return true;
  }
  const view = state.findView(stmt.table);
  if (!view) return false;
  for (const action of stmt.actions) {
    const label = actionLabel(action);
    if (label === null) return false;
    // PostgreSQL stores a storage mode for materialized-view columns; the engine keeps none.
    if (action.kind === "set_storage" && view.materialized) {
      throw unsupported("ALTER COLUMN ... SET STORAGE on a materialized view");
    }
    throw pgError("wrong_object_type", `ALTER action ${label} cannot be performed on relation "${view.name}"`, "42809");
  }
  return false;
}

// --- SET LOGGED / UNLOGGED ------------------------------------------------------

/**
 * Validate every SET LOGGED / SET UNLOGGED action of one statement against
 * the table as it stands, the way PostgreSQL's preparation phase does: once
 * an action really changes the persistence, a second one is an error.
 * Returns the persistence to apply, or null when nothing changes.
 */
export function planLoggedChange(
  state: DatabaseState,
  table: TableData,
  actions: readonly AlterTableAction[],
): boolean | null {
  let target: boolean | null = null;
  for (const action of actions) {
    if (action.kind !== "set_logged") continue;
    if (target !== null) {
      throw pgError("feature_not_supported", "cannot change persistence setting twice", "0A000");
    }
    if (prepareLoggedChange(state, table, action.logged)) target = action.logged;
  }
  return target;
}

/** Flip the table and the sequences its columns own; indexes report their table's persistence. */
export function applyLoggedChange(state: DatabaseState, table: TableData, logged: boolean): void {
  if (relPersistence(table) === (logged ? "p" : "u")) return;
  table.unlogged = !logged;
  for (const seq of ownedSequences(state, table)) {
    if (!seq.temp) setSequenceLogged(state, seq, logged);
  }
}

// --- SET STORAGE ------------------------------------------------------------------

export function setColumnStorage(table: TableData, columnName: string, mode: string): void {
  const column = alterableColumn(table, columnName);
  const storage = resolveStorage(column.type.id, mode);
  if (storage === undefined) delete column.storage;
  else column.storage = storage;
}

// --- DROP NOT NULL ----------------------------------------------------------------

export function dropColumnNotNull(table: TableData, columnName: string): void {
  const column = alterableColumn(table, columnName);
  if (!column.notNull) return;
  if (column.identity) {
    throw pgError("syntax", `column "${columnName}" of relation "${table.name}" is an identity column`, "42601");
  }
  if (table.constraints.some((c) => c.kind === "primary_key" && c.columns.includes(columnName))) {
    throw pgError("invalid_table_definition", `column "${columnName}" is in a primary key`, "42P16");
  }
  column.notNull = false;
}

// --- SET / DROP DEFAULT -------------------------------------------------------------

function assertPlainColumn(table: TableData, column: ColumnMeta): void {
  if (column.identity) {
    throw pgError("syntax", `column "${column.name}" of relation "${table.name}" is an identity column`, "42601");
  }
  if (column.generated) {
    throw pgError("syntax", `column "${column.name}" of relation "${table.name}" is a generated column`, "42601");
  }
}

/** A default may not read the row, run a query, or aggregate. */
function assertDefaultShape(table: TableData, node: unknown): void {
  if (Array.isArray(node)) {
    for (const item of node) assertDefaultShape(table, item);
    return;
  }
  if (node === null || typeof node !== "object") return;
  const expr = node as { type?: unknown; parts?: string[]; name?: string[]; over?: unknown; query?: unknown };
  if (expr.type === "colref") {
    const name = expr.parts?.[expr.parts.length - 1] ?? "";
    if (expr.parts?.length === 1 && table.columnIndex(name) === -1) {
      throw pgError("undefined_column", `column "${name}" does not exist`, "42703");
    }
    throw pgError("feature_not_supported", "cannot use column reference in DEFAULT expression", "0A000");
  }
  if (expr.type === "subquery_expr" || expr.type === "array_query" || (expr.type === "in_expr" && expr.query)) {
    throw pgError("feature_not_supported", "cannot use subquery in DEFAULT expression", "0A000");
  }
  if (expr.type === "func") {
    if (expr.over) {
      throw pgError("windowing_error", "window functions are not allowed in DEFAULT expressions", "42P20");
    }
    const name = expr.name?.length === 1 ? expr.name[0]! : null;
    if (name !== null && isAggregateName(name) && !hasScalarFunction(name)) {
      throw pgError("grouping_error", "aggregate functions are not allowed in DEFAULT expressions", "42803");
    }
  }
  for (const value of Object.values(node)) assertDefaultShape(table, value);
}

/** Scalar types whose assignment casts the engine's cast table lists completely. */
const TYPE_CHECKED: ReadonlySet<TypeId> = new Set([
  "bool",
  "int2",
  "int4",
  "int8",
  "numeric",
  "float4",
  "float8",
  "date",
  "time",
  "timetz",
  "timestamp",
  "timestamptz",
  "interval",
  "uuid",
]);

const STRING_TYPES: ReadonlySet<TypeId> = new Set(["text", "varchar", "bpchar", "name"]);

/**
 * The checks PostgreSQL makes when it stores a default: an untyped literal
 * must be valid input for the column type (it becomes a constant of that
 * type right away), and a typed expression must be assignable to it. Length
 * and range limits are not checked here; like PostgreSQL, the default then
 * fails when a row uses it.
 */
function assertDefaultType(env: ExecEnv, column: ColumnMeta, expr: Expr): void {
  const target = column.type.id;
  if (expr.type === "string_lit") {
    if (target !== "regclass") castTo(env.ctx, tv(UNKNOWN, expr.value), target, {});
    return;
  }
  const source = defaultExprType(env.ctx, expr);
  if (source === null || source === UNKNOWN || source === target) return;
  if (STRING_TYPES.has(target) || !TYPE_CHECKED.has(target)) return;
  if (!TYPE_CHECKED.has(source) && !STRING_TYPES.has(source)) return;
  if (canAssignCast(source, target)) return;
  throw pgError(
    "datatype_mismatch",
    `column "${column.name}" is of type ${typeDisplayName(target)} but default expression is of type ${typeDisplayName(source)}`,
    "42804",
  );
}

export function setColumnDefault(env: ExecEnv, table: TableData, columnName: string, expr: Expr): void {
  const column = alterableColumn(table, columnName);
  assertPlainColumn(table, column);
  assertDefaultShape(table, expr);
  assertDefaultType(env, column, expr);
  // DEFAULT NULL is how PostgreSQL spells "no default": nothing is stored.
  column.defaultExpr = isNullDefault(env.ctx, expr) ? null : expr;
}

export function dropColumnDefault(table: TableData, columnName: string): void {
  const column = alterableColumn(table, columnName);
  assertPlainColumn(table, column);
  column.defaultExpr = null;
}
