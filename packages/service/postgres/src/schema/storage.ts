import { pgError } from "../errors/error.ts";
import type { ColumnMeta } from "../storage/database-state.ts";
import { enumTypeName, isArrayType, isEnumType, type TypeId, typeDisplayName } from "../types/value.ts";

/**
 * Column storage strategy as `pg_attribute.attstorage` reports it:
 * `p` PLAIN, `e` EXTERNAL, `x` EXTENDED, `m` MAIN.
 *
 * Only the SQL and catalog contract is modelled. Values are never compressed
 * or moved out of line, so the mode has no effect on how rows are held.
 */
export type StorageMode = "p" | "e" | "x" | "m";

/** Types whose `pg_type.typstorage` is `p`: fixed-length types, plus the non-toastable `tsquery`. */
const PLAIN_TYPES: ReadonlySet<TypeId> = new Set([
  "bool",
  "int2",
  "int4",
  "int8",
  "float4",
  "float8",
  "money",
  "name",
  "oid",
  "regproc",
  "regclass",
  "regtype",
  "regnamespace",
  "date",
  "time",
  "timetz",
  "timestamp",
  "timestamptz",
  "interval",
  "uuid",
  "tsquery",
  "void",
  "unknown",
]);

const MODE_BY_NAME: Readonly<Record<string, StorageMode>> = {
  plain: "p",
  external: "e",
  extended: "x",
  main: "m",
};

/** `pg_type.typstorage`: the strategy a column of this type gets unless `STORAGE` says otherwise. */
export function defaultStorage(type: TypeId): StorageMode {
  if (isArrayType(type)) return "x";
  if (isEnumType(type) || PLAIN_TYPES.has(type)) return "p";
  return type === "numeric" ? "m" : "x";
}

/** `pg_attribute.attstorage` for a column: the stored override, else the type default. */
export function columnStorage(column: ColumnMeta): StorageMode {
  return column.storage ?? defaultStorage(column.type.id);
}

/**
 * Resolve a `STORAGE` keyword for a column of `type`, with PostgreSQL's
 * errors: an unknown keyword is 22023, and a type that is not toastable
 * accepts only PLAIN (0A000). Returns `undefined` when the result is the
 * type default, so `SET STORAGE DEFAULT` and an explicit default leave no
 * override behind.
 */
export function resolveStorage(type: TypeId, mode: string): StorageMode | undefined {
  const fallback = defaultStorage(type);
  const keyword = mode.toLowerCase();
  if (keyword === "default") return undefined;
  const resolved = MODE_BY_NAME[keyword];
  if (resolved === undefined) {
    throw pgError("invalid_parameter_value", `invalid storage type "${mode}"`, "22023");
  }
  if (resolved !== "p" && fallback === "p") {
    throw pgError(
      "feature_not_supported",
      `column data type ${isEnumType(type) ? enumTypeName(type).split(".").pop() : typeDisplayName(type)} can only have storage PLAIN`,
      "0A000",
    );
  }
  return resolved === fallback ? undefined : resolved;
}
