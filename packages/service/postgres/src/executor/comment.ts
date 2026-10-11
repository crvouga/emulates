import type { CommentStmt } from "../ast/nodes.ts";
import { pgError } from "../errors/error.ts";
import { findIndex, otherRelationKind } from "../schema/index-catalog.ts";
import { commandResult, type ExecEnv, type ExecResult } from "./relation.ts";

/**
 * COMMENT ON. Only index comments are stored (they surface in pg_description);
 * comments on every other kind of object are accepted and dropped.
 */
export function executeComment(env: ExecEnv, stmt: CommentStmt): ExecResult {
  if (stmt.objectKind !== "index") return commandResult("COMMENT", 0);
  const state = env.ctx.state;
  const found = findIndex(state, stmt.objectName);
  if (!found) {
    if (stmt.objectName.length >= 2) state.getSchema(stmt.objectName.at(-2)!);
    if (otherRelationKind(state, stmt.objectName)) {
      throw pgError("wrong_object_type", `"${stmt.objectName.at(-1)}" is not an index`, "42809");
    }
    throw pgError("undefined_table", `relation "${stmt.objectName.join(".")}" does not exist`, "42P01");
  }
  // index objects are shared with transaction snapshots: replace, never mutate
  const { comment: _previous, ...index } = found.index;
  // an empty string removes the comment, exactly as NULL does
  found.schema.indexes.set(index.name, stmt.comment ? { ...index, comment: stmt.comment } : index);
  return commandResult("COMMENT", 0);
}
