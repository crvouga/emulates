import { pgError } from "../errors/error.ts";
import type { DatabaseState } from "../storage/database-state.ts";
import type { CastEnv } from "../types/cast.ts";
import type { CompareCtx } from "../types/compare.ts";
import { UNIX_EPOCH_MICROS_FROM_PG } from "../types/datetime.ts";
import { zoneOffsetAtUtc, zoneOffsetForNaive } from "../types/timezone.ts";
import { isEnumType, type TypeId } from "../types/value.ts";

/**
 * Engine-wide evaluation context: database state plus per-statement clock
 * captures. One instance is created per top-level statement execution.
 */
export class EngineCtx implements CastEnv, CompareCtx {
  readonly state: DatabaseState;
  /** transaction timestamp (now(), current_timestamp) — UTC micros since PG epoch */
  readonly txNow: bigint;
  /** statement timestamp */
  readonly stmtNow: bigint;

  constructor(state: DatabaseState, txNow?: bigint) {
    this.state = state;
    const nowMs = state.clock().getTime();
    const nowMicros = BigInt(Math.round(nowMs)) * 1000n + UNIX_EPOCH_MICROS_FROM_PG;
    this.txNow = txNow ?? nowMicros;
    this.stmtNow = nowMicros;
  }

  timezone(): string {
    return this.state.getSetting("timezone") ?? "UTC";
  }

  namespaceOid(input: string): number {
    const trimmed = input.trim();
    const name =
      trimmed.startsWith('"') && trimmed.endsWith('"')
        ? trimmed.slice(1, -1).replaceAll('""', '"')
        : trimmed.toLowerCase();
    if (name === "pg_catalog") return 11;
    if (name === "information_schema") return 13212;
    const schema = this.state.schemas.get(name);
    if (!schema) throw pgError("undefined_object", `schema "${name}" does not exist`, "3F000");
    return schema.oid;
  }

  namespaceName(oid: number): string | null {
    if (oid === 11) return "pg_catalog";
    if (oid === 13212) return "information_schema";
    for (const schema of this.state.schemas.values()) {
      if (schema.oid === oid) {
        return /^[a-z_][a-z0-9_$]*$/.test(schema.name) ? schema.name : `"${schema.name.replaceAll('"', '""')}"`;
      }
    }
    return null;
  }

  zoneOffsetAt(utcMicros: bigint): number {
    return zoneOffsetAtUtc(this.timezone(), utcMicros);
  }

  zoneOffsetForNaive(naiveMicros: bigint): number {
    return zoneOffsetForNaive(this.timezone(), naiveMicros);
  }

  enumLabels(enumType: TypeId): string[] | null {
    if (!isEnumType(enumType)) return null;
    const e = this.state.findEnumByKey(enumType.slice(5));
    return e?.labels ?? null;
  }

  enumHasLabel(enumType: TypeId, label: string): boolean {
    const labels = this.enumLabels(enumType);
    return labels === null ? true : labels.includes(label);
  }

  enumOrder(enumType: TypeId, label: string): number {
    const labels = this.enumLabels(enumType);
    if (!labels) return 0;
    const idx = labels.indexOf(label);
    return idx === -1 ? labels.length : idx;
  }

  requireEnum(enumType: TypeId): string[] {
    const labels = this.enumLabels(enumType);
    if (!labels) throw pgError("undefined_object", `type "${enumType.slice(5)}" does not exist`);
    return labels;
  }
}
