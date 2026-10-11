import type { Expr, FuncCall } from "../ast/nodes.ts";
import type { EngineCtx } from "../expressions/context.ts";
import { numberLitValue } from "../expressions/eval.ts";
import { castTo } from "../types/cast.ts";
import { resolveTypeName } from "../types/resolve.ts";
import {
  arrayElemType,
  arrayTypeOf,
  type ColumnType,
  type Datum,
  datumText,
  enumTypeName,
  isArrayType,
  isEnumType,
  type TypeId,
  type TypeMod,
  tv,
  typeDisplayName,
  UNKNOWN,
} from "../types/value.ts";
import { deparseExpr, quoteIdent } from "./deparse.ts";

/**
 * Render a column default the way PostgreSQL's `pg_get_expr(adbin, adrelid)`
 * does, which is what `information_schema.columns.column_default` shows.
 *
 * PostgreSQL prints the analyzed expression, not the text that was written:
 * untyped literals have already become constants of the type their context
 * demands (`'x' || 'y'` is `('x'::text || 'y'::text)`), operators are always
 * parenthesized, and the implicit coercion to the column type is hidden at
 * the top while nested ones show as `(arg)::type`. The engine keeps the
 * parsed expression, so the same analysis is redone here for the shapes
 * defaults use: constants, casts, SQL value functions, the built-in functions
 * listed in {@link SIGNATURES}, operators over those and ARRAY[...]. Anything
 * else falls back to the plain deparser and can differ textually.
 */

interface Node {
  sql: string;
  /** static result type; null when it cannot be inferred */
  type: TypeId | null;
  /** untyped string literal still waiting for a type from its context */
  unknown?: string;
  /** NULL constant (a default that is NULL is no default at all) */
  isNull?: boolean;
  /** constant text without its `::type` label, for `const::type(mod)` */
  bare?: string;
}

function quoteLiteral(text: string): string {
  return `'${text.replaceAll("'", "''")}'`;
}

/** `format_type(oid, typmod)`. */
function formatType(ctx: EngineCtx, id: TypeId, mod: TypeMod | null): string {
  if (isArrayType(id)) return `${formatType(ctx, arrayElemType(id), mod)}[]`;
  if (isEnumType(id)) {
    const [schema, ...rest] = enumTypeName(id).split(".");
    const name = quoteIdent(rest.join("."));
    return ctx.state.effectiveSearchPath().includes(schema ?? "") ? name : `${quoteIdent(schema ?? "")}.${name}`;
  }
  const a = mod?.a;
  switch (id) {
    case "bpchar":
      return a === undefined ? "bpchar" : `character(${a})`;
    case "varchar":
      return a === undefined ? "character varying" : `character varying(${a})`;
    case "numeric":
      return a === undefined ? "numeric" : `numeric(${a},${mod?.b ?? 0})`;
    case "timestamp":
      return a === undefined ? "timestamp without time zone" : `timestamp(${a}) without time zone`;
    case "timestamptz":
      return a === undefined ? "timestamp with time zone" : `timestamp(${a}) with time zone`;
    case "time":
      return a === undefined ? "time without time zone" : `time(${a}) without time zone`;
    case "timetz":
      return a === undefined ? "time with time zone" : `time(${a}) with time zone`;
    case "bit":
      return a === undefined ? '"bit"' : `bit(${a})`;
    case "varbit":
      return a === undefined ? "bit varying" : `bit varying(${a})`;
    default:
      return typeDisplayName(id);
  }
}

/** A constant of `type` as ruleutils prints it: bare where it re-parses as that type, else `'text'::type`. */
function typedConst(ctx: EngineCtx, type: TypeId, value: Datum): Node {
  if (value === null) return { sql: `NULL::${formatType(ctx, type, null)}`, type, isNull: true };
  const text = datumText(type, value, ctx);
  let bare = quoteLiteral(text);
  let label = true;
  if (type === "bool") {
    bare = text === "t" ? "true" : "false";
    label = false;
  } else if (type === "int4" && !text.startsWith("-")) {
    bare = text;
    label = false;
  } else if (type === "numeric" && /^\d/.test(text) && /[eE.]/.test(text)) {
    bare = text;
    label = false;
  }
  return { sql: label ? `${bare}::${formatType(ctx, type, null)}` : bare, type, bare };
}

/** `'name'::regclass` prints the relation name, schema-qualified only when the search path would not find it. */
function regclassConst(ctx: EngineCtx, raw: string): Node {
  const parts = raw.split(".").map((p) => (p.startsWith('"') && p.endsWith('"') ? p.slice(1, -1) : p.toLowerCase()));
  const name = parts[parts.length - 1] ?? raw;
  const schema = parts.length > 1 ? parts[parts.length - 2]! : null;
  const visible = ctx.state.resolveRelationSchema([name])?.schema;
  const shown = schema === null || visible === schema ? quoteIdent(name) : `${quoteIdent(schema)}.${quoteIdent(name)}`;
  return { sql: `${quoteLiteral(shown)}::regclass`, type: "regclass" };
}

/** Give an untyped literal (or NULL) the type its context demands. */
function resolveUnknown(ctx: EngineCtx, node: Node, type: TypeId): Node {
  if (node.isNull) return { sql: `NULL::${formatType(ctx, type, null)}`, type, isNull: true };
  if (node.unknown === undefined) return node;
  if (type === "regclass") return regclassConst(ctx, node.unknown);
  try {
    return typedConst(ctx, type, castTo(ctx, tv(UNKNOWN, node.unknown), type, {}).v);
  } catch {
    // Not a valid literal of that type: keep what was written rather than fail a catalog read.
    return { sql: `${quoteLiteral(node.unknown)}::${formatType(ctx, type, null)}`, type };
  }
}

/** Implicit coercion of `node` to `type`. Nested ones are printed; the top-level one is not. */
function coerce(ctx: EngineCtx, node: Node, type: TypeId, nested: boolean): Node {
  if (node.unknown !== undefined || node.isNull) return resolveUnknown(ctx, node, type);
  if (node.type === null || node.type === type || !nested) return node;
  return { sql: `(${node.sql})::${formatType(ctx, type, null)}`, type };
}

// --- functions -----------------------------------------------------------------

/**
 * Parameter and result types of built-in functions, per arity. A parameter
 * is a type, `any` (the argument is used as written), or `*any` for a
 * variadic tail. A result is a type, `=N` (the type of argument N) or `?`.
 */
const SIGNATURES: Readonly<Record<string, readonly string[]>> = {
  now: ["->timestamptz"],
  clock_timestamp: ["->timestamptz"],
  statement_timestamp: ["->timestamptz"],
  transaction_timestamp: ["->timestamptz"],
  gen_random_uuid: ["->uuid"],
  random: ["->float8"],
  version: ["->text"],
  current_database: ["->name"],
  current_schema: ["->name"],
  txid_current: ["->int8"],
  pg_backend_pid: ["->int4"],
  nextval: ["regclass->int8"],
  currval: ["regclass->int8"],
  current_setting: ["text->text"],
  upper: ["text->text"],
  lower: ["text->text"],
  initcap: ["text->text"],
  md5: ["text->text"],
  reverse: ["text->text"],
  btrim: ["text->text", "text,text->text"],
  ltrim: ["text->text", "text,text->text"],
  rtrim: ["text->text", "text,text->text"],
  length: ["text->int4"],
  char_length: ["text->int4"],
  character_length: ["text->int4"],
  repeat: ["text,int4->text"],
  replace: ["text,text,text->text"],
  left: ["text,int4->text"],
  right: ["text,int4->text"],
  lpad: ["text,int4->text", "text,int4,text->text"],
  rpad: ["text,int4->text", "text,int4,text->text"],
  split_part: ["text,text,int4->text"],
  concat: ["*any->text"],
  concat_ws: ["text,*any->text"],
  format: ["text,*any->text"],
  to_char: ["any,text->text"],
  to_timestamp: ["float8->timestamptz", "text,text->timestamptz"],
  to_date: ["text,text->date"],
  to_number: ["text,text->numeric"],
  date_trunc: ["text,any->=1"],
  date_part: ["text,any->float8"],
  timezone: ["text,any->?"],
  abs: ["any->=0"],
  floor: ["any->=0"],
  ceil: ["any->=0"],
  ceiling: ["any->=0"],
  round: ["any->=0", "numeric,int4->numeric"],
  trunc: ["any->=0", "numeric,int4->numeric"],
  mod: ["any,any->=0"],
  power: ["float8,float8->float8"],
  encode: ["bytea,text->text"],
  decode: ["text,text->bytea"],
  array_to_string: ["any,text->text"],
  string_to_array: ["text,text->text[]"],
  to_jsonb: ["any->jsonb"],
  to_json: ["any->json"],
  jsonb_build_object: ["*any->jsonb"],
  jsonb_build_array: ["*any->jsonb"],
  json_build_object: ["*any->json"],
  json_build_array: ["*any->json"],
};

/** SQL value functions: the parser tags them `pg_catalog.<name>`; PostgreSQL prints the keyword back. */
const SQL_VALUE_FUNCTIONS: Readonly<Record<string, TypeId>> = {
  current_date: "date",
  current_time: "timetz",
  current_timestamp: "timestamptz",
  localtime: "time",
  localtimestamp: "timestamp",
  current_user: "name",
  session_user: "name",
  current_role: "name",
  current_catalog: "name",
  current_schema: "name",
  user: "name",
};

/** Function names that are SQL keywords and so print quoted. */
const KEYWORD_FUNCTION_NAMES: ReadonlySet<string> = new Set(["left", "right", "current_schema"]);

const CONDITIONAL_FUNCTIONS: ReadonlySet<string> = new Set(["coalesce", "greatest", "least", "nullif"]);

function bareFunctionName(e: FuncCall): string | null {
  if (e.name.length === 1) return e.name[0]!;
  return e.name.length === 2 && e.name[0] === "pg_catalog" ? e.name[1]! : null;
}

function findSignature(name: string, argc: number): { params: string[]; result: string } | null {
  for (const spec of SIGNATURES[name] ?? []) {
    const [left, result] = spec.split("->") as [string, string];
    const params = left === "" ? [] : left.split(",");
    const variadic = params[params.length - 1] === "*any";
    if (variadic ? argc >= params.length - 1 : argc === params.length) return { params, result };
  }
  return null;
}

/** Arguments that must share one type (COALESCE, ARRAY[...]): untyped literals take the first known type, else text. */
function unify(ctx: EngineCtx, nodes: Node[]): { nodes: Node[]; type: TypeId } {
  const type = nodes.find((n) => n.type !== null && n.unknown === undefined)?.type ?? "text";
  return { nodes: nodes.map((n) => resolveUnknown(ctx, n, type)), type };
}

function analyzeFunc(ctx: EngineCtx, e: FuncCall): Node {
  const name = bareFunctionName(e);
  if (name === null || e.star || e.distinct || e.over || e.filter || (e.orderBy?.length ?? 0) > 0) {
    return { sql: deparseExpr(e), type: null };
  }
  const sqlValueType = e.name.length === 2 ? SQL_VALUE_FUNCTIONS[name] : undefined;
  if (sqlValueType !== undefined && e.args.every((a) => a.type === "number_lit")) {
    const precision = e.args.length > 0 ? `(${e.args.map(deparseExpr).join(", ")})` : "";
    return { sql: `${name.toUpperCase()}${precision}`, type: sqlValueType };
  }
  const args = e.args.map((a) => analyze(ctx, a));
  if (CONDITIONAL_FUNCTIONS.has(name)) {
    const unified = unify(ctx, args);
    return { sql: `${name.toUpperCase()}(${unified.nodes.map((n) => n.sql).join(", ")})`, type: unified.type };
  }
  const shown = KEYWORD_FUNCTION_NAMES.has(name) ? `"${name}"` : name;
  const signature = findSignature(name, args.length);
  if (!signature) {
    // No signature on record: an untyped literal is most often a text argument.
    const rendered = args.map((n) => resolveUnknown(ctx, n, "text").sql);
    return { sql: `${shown}(${rendered.join(", ")})`, type: null };
  }
  const coerced = args.map((n, i) => {
    const param = signature.params[Math.min(i, signature.params.length - 1)]!;
    return param === "any" || param === "*any" ? n : coerce(ctx, n, param, true);
  });
  let type: TypeId | null = signature.result;
  if (type === "?") type = null;
  else if (type.startsWith("=")) type = coerced[Number(type.slice(1))]?.type ?? null;
  if (name === "timezone") {
    const source = coerced[1]?.type;
    type = source === "timestamptz" ? "timestamp" : source === "timestamp" ? "timestamptz" : null;
  }
  return { sql: `${shown}(${coerced.map((n) => n.sql).join(", ")})`, type };
}

// --- operators -----------------------------------------------------------------

const INTEGER_RANK: Readonly<Record<string, number>> = { int2: 1, int4: 2, int8: 3 };
const ARITHMETIC = new Set(["+", "-", "*", "/", "%"]);
const COMPARISON = new Set(["=", "<>", "!=", "<", "<=", ">", ">="]);
const DATETIME = new Set(["timestamptz", "timestamp", "date", "time", "timetz"]);
const JSON_ACCESSORS = new Set(["->", "->>"]);

function isNumberType(t: TypeId | null): t is TypeId {
  return t !== null && (t in INTEGER_RANK || t === "numeric" || t === "float4" || t === "float8");
}

/**
 * Bring two numeric operands to the types PostgreSQL's operator resolution
 * picks. The integer types have cross-type operators (except `%`), so they
 * are left alone; anything else is cast to the wider type.
 */
function numericOperands(ctx: EngineCtx, op: string, l: Node, r: Node): { l: Node; r: Node; type: TypeId } {
  const lt = l.type as TypeId;
  const rt = r.type as TypeId;
  if (lt === rt) return { l, r, type: lt };
  const lRank = INTEGER_RANK[lt];
  const rRank = INTEGER_RANK[rt];
  if (lRank !== undefined && rRank !== undefined) {
    const wide = lRank > rRank ? lt : rt;
    if (op !== "%") return { l, r, type: wide };
    return { l: coerce(ctx, l, wide, true), r: coerce(ctx, r, wide, true), type: wide };
  }
  const wide =
    lt === "float8" || rt === "float8" ? "float8" : lt === "float4" || rt === "float4" ? "float4" : "numeric";
  if (wide === "float4") return { l, r, type: wide };
  return { l: coerce(ctx, l, wide, true), r: coerce(ctx, r, wide, true), type: wide };
}

function arithmeticType(op: string, lt: TypeId | null, rt: TypeId | null): TypeId | null {
  if (lt === null || rt === null) return null;
  if (lt === "interval" && rt === "interval") return op === "+" || op === "-" ? "interval" : null;
  if (rt === "interval" && (op === "+" || op === "-")) {
    if (lt === "timestamptz" || lt === "timestamp" || lt === "time" || lt === "timetz") return lt;
    if (lt === "date") return "timestamp";
  }
  if (lt === "interval" && op === "+") return rt === "date" ? "timestamp" : DATETIME.has(rt) ? rt : null;
  if (lt === "date" && rt in INTEGER_RANK && (op === "+" || op === "-")) return "date";
  if (lt === rt && op === "-") {
    if (lt === "timestamptz" || lt === "timestamp" || lt === "time") return "interval";
    if (lt === "date") return "int4";
  }
  return null;
}

function analyzeBinary(ctx: EngineCtx, op: string, left: Expr, right: Expr): Node {
  let l = analyze(ctx, left);
  let r = analyze(ctx, right);
  if (op === "and" || op === "or") {
    l = coerce(ctx, l, "bool", true);
    r = coerce(ctx, r, "bool", true);
    return { sql: `(${l.sql} ${op.toUpperCase()} ${r.sql})`, type: "bool" };
  }
  const untyped = (n: Node) => n.unknown !== undefined || n.isNull === true;
  if (op === "||") {
    const arrayType = [l.type, r.type].find((t) => t !== null && isArrayType(t)) ?? null;
    if (untyped(l)) l = resolveUnknown(ctx, l, arrayType ?? "text");
    if (untyped(r)) r = resolveUnknown(ctx, r, arrayType ?? "text");
    return { sql: `(${l.sql} || ${r.sql})`, type: arrayType ?? "text" };
  }
  // An untyped literal next to a typed operand takes that operand's type, except that
  // date/time arithmetic with a literal is interval arithmetic and a JSON accessor takes a text key.
  const partner = (other: Node): TypeId => {
    if (untyped(other) || other.type === null || JSON_ACCESSORS.has(op)) return "text";
    return ARITHMETIC.has(op) && DATETIME.has(other.type) ? "interval" : other.type;
  };
  if (untyped(l)) l = resolveUnknown(ctx, l, partner(r));
  if (untyped(r)) r = resolveUnknown(ctx, r, partner(l));
  const shown = op === "!=" ? "<>" : op;
  if (ARITHMETIC.has(op) || COMPARISON.has(op)) {
    let type: TypeId | null = arithmeticType(op, l.type, r.type);
    if (isNumberType(l.type) && isNumberType(r.type)) {
      const operands = numericOperands(ctx, op, l, r);
      l = operands.l;
      r = operands.r;
      type = operands.type;
    }
    return { sql: `(${l.sql} ${shown} ${r.sql})`, type: COMPARISON.has(op) ? "bool" : type };
  }
  const type = op === "->>" || op === "#>>" ? "text" : op === "->" || op === "#>" ? l.type : null;
  return { sql: `(${l.sql} ${shown} ${r.sql})`, type };
}

/** Both sides of a comparison PostgreSQL writes out itself (IN, BETWEEN): one common type, numeric casts shown. */
function comparison(ctx: EngineCtx, op: string, left: Node, right: Node): string {
  let l = left;
  let r = right;
  if (isNumberType(l.type) && isNumberType(r.type)) ({ l, r } = numericOperands(ctx, op, l, r));
  return `(${l.sql} ${op} ${r.sql})`;
}

const LIKE_OPERATORS = { like: ["~~", "!~~"], ilike: ["~~*", "!~~*"] } as const;

/** Special syntax forms PostgreSQL prints back in their SQL spelling, or as the operators they stand for. */
function analyzeSyntaxForm(ctx: EngineCtx, e: Expr, top: boolean): Node | null {
  const text = (expr: Expr): Node => coerce(ctx, analyze(ctx, expr), "text", true);
  switch (e.type) {
    case "like": {
      if (e.kind === "similar" || e.escape) return null;
      const op = LIKE_OPERATORS[e.kind][e.not ? 1 : 0];
      return { sql: `(${text(e.left).sql} ${op} ${text(e.pattern).sql})`, type: "bool" };
    }
    case "in_expr": {
      if (!e.list) return null;
      const [left, ...items] = unify(ctx, [analyze(ctx, e.left), ...e.list.map((item) => analyze(ctx, item))]).nodes;
      const array = `ARRAY[${items.map((n) => n.sql).join(", ")}]`;
      return { sql: `(${left!.sql} ${e.not ? "<> ALL" : "= ANY"} (${array}))`, type: "bool" };
    }
    case "between": {
      if (e.symmetric) return null;
      const [value, low, high] = unify(ctx, [analyze(ctx, e.left), analyze(ctx, e.low), analyze(ctx, e.high)])
        .nodes as [Node, Node, Node];
      const lower = comparison(ctx, e.not ? "<" : ">=", value, low);
      const upper = comparison(ctx, e.not ? ">" : "<=", value, high);
      return { sql: `(${lower} ${e.not ? "OR" : "AND"} ${upper})`, type: "bool" };
    }
    case "position":
      return { sql: `POSITION((${text(e.needle).sql}) IN (${text(e.haystack).sql}))`, type: "int4" };
    case "substring_sql": {
      if (e.similar) return null;
      const from = e.from ? ` FROM ${analyze(ctx, e.from).sql}` : "";
      const length = e.forLen ? ` FOR ${analyze(ctx, e.forLen).sql}` : "";
      return { sql: `SUBSTRING(${text(e.source).sql}${from}${length})`, type: "text" };
    }
    case "trim": {
      const chars = e.chars ? `${text(e.chars).sql} ` : "";
      return { sql: `TRIM(${e.side.toUpperCase()} ${chars}FROM ${text(e.source).sql})`, type: "text" };
    }
    case "case": {
      const results = unify(
        ctx,
        [...e.whens.map((arm) => arm.then), ...(e.elseExpr ? [e.elseExpr] : [])].map((r) => analyze(ctx, r)),
      );
      const operand = e.operand ? analyze(ctx, e.operand) : null;
      const arms = e.whens.map((arm, i) => {
        const when = analyze(ctx, arm.when);
        const test = operand ? resolveUnknown(ctx, when, operand.type ?? "text") : coerce(ctx, when, "bool", true);
        return `WHEN ${test.sql} THEN ${results.nodes[i]!.sql}`;
      });
      if (e.elseExpr) arms.push(`ELSE ${results.nodes[e.whens.length]!.sql}`);
      const head = operand ? `CASE ${operand.sql}` : "CASE";
      // pg_get_expr lays a CASE out over several lines; only the outermost one is reproduced that way
      const sql = top ? `\n${head}\n    ${arms.join("\n    ")}\nEND` : `${head} ${arms.join(" ")} END`;
      return { sql, type: results.type };
    }
    default:
      return null;
  }
}

// --- expressions ----------------------------------------------------------------

function analyzeCast(ctx: EngineCtx, e: Extract<Expr, { type: "cast" }>): Node {
  const target = resolveTypeName(ctx.state, e.target).column;
  const label = formatType(ctx, target.id, target.mod);
  if (e.expr.type === "array_ctor" && isArrayType(target.id)) {
    const elem = arrayElemType(target.id);
    const items = e.expr.items.map((item) => coerce(ctx, analyze(ctx, item), elem, true));
    const body = `ARRAY[${items.map((n) => n.sql).join(", ")}]`;
    return { sql: items.length === 0 ? `${body}::${label}` : body, type: target.id };
  }
  const inner = analyze(ctx, e.expr);
  if (inner.isNull) return { sql: `NULL::${label}`, type: target.id, isNull: true };
  if (inner.unknown !== undefined) {
    const constant = resolveUnknown(ctx, inner, target.id);
    return target.mod && constant.bare !== undefined ? { ...constant, sql: `${constant.bare}::${label}` } : constant;
  }
  if (inner.type === target.id) {
    if (!target.mod) return inner;
    if (inner.bare !== undefined) return { ...inner, sql: `${inner.bare}::${label}` };
  }
  return { sql: `(${inner.sql})::${label}`, type: target.id };
}

function analyze(ctx: EngineCtx, e: Expr, top = false): Node {
  switch (e.type) {
    case "null_lit":
      return { sql: "NULL", type: null, isNull: true };
    case "string_lit":
      return { sql: quoteLiteral(e.value), type: UNKNOWN, unknown: e.value };
    case "number_lit": {
      const value = numberLitValue(e.raw);
      return typedConst(ctx, value.t, value.v);
    }
    case "bool_lit":
      return typedConst(ctx, "bool", e.value);
    case "unop": {
      if (e.op === "-" && e.operand.type === "number_lit") {
        // The grammar folds a negated numeric literal into one negative constant.
        const value = numberLitValue(`-${e.operand.raw}`);
        return typedConst(ctx, value.t, value.v);
      }
      const operand = analyze(ctx, e.operand);
      if (e.op === "not") return { sql: `(NOT ${coerce(ctx, operand, "bool", true).sql})`, type: "bool" };
      return { sql: `(${e.op} ${operand.sql})`, type: operand.unknown === undefined ? operand.type : null };
    }
    case "binop":
      return analyzeBinary(ctx, e.op, e.left, e.right);
    case "cast":
      return analyzeCast(ctx, e);
    case "func":
      return analyzeFunc(ctx, e);
    case "array_ctor": {
      const unified = unify(
        ctx,
        e.items.map((item) => analyze(ctx, item)),
      );
      return { sql: `ARRAY[${unified.nodes.map((n) => n.sql).join(", ")}]`, type: arrayTypeOf(unified.type) };
    }
    case "at_time_zone": {
      const source = analyze(ctx, e.expr);
      const zone = coerce(ctx, analyze(ctx, e.zone), "text", true);
      const type = source.type === "timestamptz" ? "timestamp" : source.type === "timestamp" ? "timestamptz" : null;
      return { sql: `(${source.sql} AT TIME ZONE ${zone.sql})`, type };
    }
    case "extract":
      return { sql: `EXTRACT(${e.field} FROM ${analyze(ctx, e.source).sql})`, type: "numeric" };
    case "collate": {
      const inner = coerce(ctx, analyze(ctx, e.expr), "text", true);
      return { sql: `(${inner.sql} COLLATE ${e.collation.map((p) => `"${p}"`).join(".")})`, type: inner.type };
    }
    case "is_null": {
      const inner = analyze(ctx, e.expr);
      return { sql: `(${resolveUnknown(ctx, inner, "text").sql} IS ${e.not ? "NOT " : ""}NULL)`, type: "bool" };
    }
    default:
      return analyzeSyntaxForm(ctx, e, top) ?? { sql: deparseExpr(e), type: null };
  }
}

/** True when the default is a NULL constant, which PostgreSQL does not store as a default. */
export function isNullDefault(ctx: EngineCtx, expr: Expr): boolean {
  return analyze(ctx, expr).isNull === true;
}

/**
 * Static type of a default expression: a type name, `unknown` for an untyped
 * string literal, or null when the expression is outside what is analyzed.
 */
export function defaultExprType(ctx: EngineCtx, expr: Expr): TypeId | null {
  const node = analyze(ctx, expr);
  return node.isNull ? null : node.type;
}

/** PostgreSQL's text for a column default of the given column type, or null for a NULL default. */
export function deparseDefault(ctx: EngineCtx, expr: Expr, column: ColumnType): string | null {
  try {
    const node = coerce(ctx, analyze(ctx, expr, true), column.id, false);
    return node.isNull ? null : node.sql;
  } catch {
    // e.g. a cast to a type that has since been dropped: a catalog read must still answer
    return deparseExpr(expr);
  }
}
