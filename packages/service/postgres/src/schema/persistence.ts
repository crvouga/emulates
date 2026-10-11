import { pgError } from "../errors/error.ts";
import type { ConstraintMeta, DatabaseState, SequenceData, TableData } from "../storage/database-state.ts";

/**
 * `pg_class.relpersistence`: `p` permanent (logged), `u` unlogged, `t` temporary.
 *
 * The engine has no write-ahead log, so the three modes store rows the same
 * way. What is modelled is the SQL contract: the catalog value, the
 * transitions `ALTER TABLE ... SET LOGGED | UNLOGGED` allows, and the
 * foreign-key combinations PostgreSQL rejects.
 */
export type Persistence = "p" | "u" | "t";

export function relPersistence(rel: { temp: boolean; unlogged?: boolean }): Persistence {
  if (rel.temp) return "t";
  return rel.unlogged ? "u" : "p";
}

type ForeignKey = Extract<ConstraintMeta, { kind: "foreign_key" }>;

function isForeignKey(con: ConstraintMeta): con is ForeignKey {
  return con.kind === "foreign_key";
}

function referencedTable(state: DatabaseState, fk: ForeignKey): TableData | null {
  return state.schemas.get(fk.refSchema)?.tables.get(fk.refTable) ?? null;
}

/**
 * A foreign key may not point at a table that is less durable than the one
 * holding it: permanent tables reference permanent tables, unlogged tables
 * reference permanent or unlogged ones, temporary tables reference temporary
 * ones. `self` is the referencing table when it already exists, so a
 * self-reference is judged against the persistence being created.
 */
export function checkForeignKeyPersistence(
  state: DatabaseState,
  persistence: Persistence,
  constraints: readonly ConstraintMeta[],
  self: TableData | null = null,
): void {
  for (const fk of constraints.filter(isForeignKey)) {
    const target = referencedTable(state, fk);
    if (!target || target === self) continue;
    const referenced = relPersistence(target);
    if (persistence === "p" && referenced !== "p") {
      throw pgError(
        "invalid_table_definition",
        "constraints on permanent tables may reference only permanent tables",
        "42P16",
      );
    }
    if (persistence === "u" && referenced === "t") {
      throw pgError(
        "invalid_table_definition",
        "constraints on unlogged tables may reference only permanent or unlogged tables",
        "42P16",
      );
    }
    if (persistence === "t" && referenced !== "t") {
      throw pgError(
        "invalid_table_definition",
        "constraints on temporary tables may reference only temporary tables",
        "42P16",
      );
    }
  }
}

/**
 * Validate `ALTER TABLE ... SET LOGGED | UNLOGGED` against the table as it is
 * before the statement runs. Returns false when the table already has the
 * requested persistence (PostgreSQL accepts that as a no-op).
 */
export function prepareLoggedChange(state: DatabaseState, table: TableData, logged: boolean): boolean {
  if (table.temp) {
    throw pgError(
      "invalid_table_definition",
      `cannot change logged status of table "${table.name}" because it is temporary`,
      "42P16",
    );
  }
  if (table.unlogged === !logged) return false;
  if (logged) {
    // A logged table may not reference an unlogged one.
    for (const fk of table.constraints.filter(isForeignKey)) {
      const target = referencedTable(state, fk);
      if (target && target !== table && relPersistence(target) !== "p") {
        throw pgError(
          "invalid_table_definition",
          `could not change table "${table.name}" to logged because it references unlogged table "${target.name}"`,
          "42P16",
        );
      }
    }
    return true;
  }
  // An unlogged table may not be referenced by a logged one.
  for (const schema of state.schemas.values()) {
    for (const other of schema.tables.values()) {
      if (other === table || relPersistence(other) !== "p") continue;
      const references = other.constraints
        .filter(isForeignKey)
        .some((fk) => fk.refSchema === table.schema && fk.refTable === table.name);
      if (references) {
        throw pgError(
          "invalid_table_definition",
          `could not change table "${table.name}" to unlogged because it references logged table "${other.name}"`,
          "42P16",
        );
      }
    }
  }
  return true;
}

/** Sequences owned by the table's columns (serial and identity); they follow its persistence. */
export function ownedSequences(state: DatabaseState, table: TableData): SequenceData[] {
  const owned = new Set<SequenceData>();
  for (const seq of state.schemas.get(table.schema)?.sequences.values() ?? []) {
    if (seq.ownedBy?.table === table.name) owned.add(seq);
  }
  for (const column of table.columns) {
    if (!column.identity) continue;
    const seq = state.findSequence(column.identity.sequence.split("."));
    if (seq) owned.add(seq);
  }
  return [...owned];
}

/** `ALTER SEQUENCE ... SET LOGGED | UNLOGGED` on a temporary sequence is rejected like a temporary table. */
export function assertSequenceNotTemporary(seq: SequenceData): void {
  if (!seq.temp) return;
  throw pgError(
    "invalid_table_definition",
    `cannot change logged status of table "${seq.name}" because it is temporary`,
    "42P16",
  );
}
