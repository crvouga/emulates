import type { CommentStmt } from "../ast/nodes.ts";
import { pgError } from "../errors/error.ts";
import { commandResult, type ExecEnv, type ExecResult } from "./relation.ts";

export function executeComment(env: ExecEnv, stmt: CommentStmt): ExecResult {
  if (stmt.objectKind !== "index") return commandResult("COMMENT", 0);
  const name = stmt.objectName.at(-1)!;
  const schemas = stmt.objectName.length > 1 ? [stmt.objectName.at(-2)!] : env.ctx.state.effectiveSearchPath();
  for (const schemaName of schemas) {
    const schema = env.ctx.state.schemas.get(schemaName);
    const index = schema?.indexes.get(name);
    if (!schema || !index) continue;
    schema.indexes.set(name, { ...index, comment: stmt.comment });
    return commandResult("COMMENT", 0);
  }
  throw pgError("undefined_table", `relation "${stmt.objectName.join(".")}" does not exist`, "42P01");
}
