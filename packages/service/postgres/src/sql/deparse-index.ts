import type { IndexMeta } from "../storage/database-state.ts";
import { deparseExpr, quoteIdent } from "./deparse.ts";

export function deparseIndexColumn(column: IndexMeta["columns"][number]): string {
  let result = column.column === null ? deparseExpr(column.expr!) : quoteIdent(column.column);
  if (column.dir === "desc") result += " DESC";
  const defaultNulls = column.dir === "desc" ? "first" : "last";
  if (column.nulls !== defaultNulls) result += ` NULLS ${column.nulls.toUpperCase()}`;
  return result;
}

export function deparseIndex(index: IndexMeta): string {
  const columns = index.columns.map(deparseIndexColumn).join(", ");
  const unique = index.unique ? "UNIQUE " : "";
  const nulls = index.nullsNotDistinct ? " NULLS NOT DISTINCT" : "";
  const predicate = index.where ? ` WHERE ${deparseExpr(index.where)}` : "";
  return `CREATE ${unique}INDEX ${quoteIdent(index.name)} ON ${quoteIdent(index.schema)}.${quoteIdent(index.table)} USING btree (${columns})${nulls}${predicate}`;
}
