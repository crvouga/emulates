import { decode, encode } from "@msgpack/msgpack"
import { fromLatin1, latin1, utf8, utf8Text } from "./bytes.ts"
import { sha1Hex } from "./sha1.ts"

export class LuaTable {
  readonly array = new Map<number, LuaValue>()
  readonly map = new Map<string, LuaValue>()

  set(key: LuaValue, value: LuaValue): void {
    if (typeof key === "number" && Number.isInteger(key) && key >= 1) {
      if (value === null) this.array.delete(key)
      else this.array.set(key, value)
      return
    }
    const name = keyString(key)
    if (value === null) this.map.delete(name)
    else this.map.set(name, value)
  }

  get(key: LuaValue): LuaValue {
    if (typeof key === "number" && Number.isInteger(key) && key >= 1) {
      return this.array.has(key) ? (this.array.get(key) ?? null) : null
    }
    const name = keyString(key)
    return this.map.has(name) ? (this.map.get(name) ?? null) : null
  }

  has(key: LuaValue): boolean {
    if (typeof key === "number" && Number.isInteger(key) && key >= 1) return this.array.has(key)
    return this.map.has(keyString(key))
  }

  length(): number {
    let n = 0
    while (this.array.has(n + 1)) n++
    return n
  }
}

export class LuaStatus {
  constructor(readonly ok: string) {}
}

export class LuaFailure {
  constructor(readonly err: string) {}
}

export class LuaClosure {
  constructor(
    readonly params: string[],
    readonly vararg: boolean,
    readonly body: Stmt[],
    readonly env: Env,
  ) {}
}

export type LuaHost = (args: LuaValue[]) => LuaValue[]
export type LuaValue =
  | null
  | boolean
  | number
  | string
  | LuaTable
  | LuaClosure
  | LuaHost
  | LuaStatus
  | LuaFailure

function keyString(key: LuaValue): string {
  if (typeof key === "string") return key
  if (typeof key === "number") return String(key)
  if (typeof key === "boolean") return key ? "true" : "false"
  if (key === null) throw new Error("table index is nil")
  return `value:${typeof key}`
}

export class Env {
  readonly vars = new Map<string, LuaValue>()
  varargs: LuaValue[] = []

  constructor(readonly parent: Env | null) {}

  get(name: string): LuaValue {
    if (this.vars.has(name)) return this.vars.get(name) ?? null
    return this.parent ? this.parent.get(name) : null
  }

  define(name: string, value: LuaValue): void {
    this.vars.set(name, value)
  }

  set(name: string, value: LuaValue): void {
    if (this.vars.has(name) || this.parent === null) {
      this.vars.set(name, value)
      return
    }
    this.parent.set(name, value)
  }
}

type Expr =
  | { k: "nil" }
  | { k: "bool"; v: boolean }
  | { k: "num"; v: number }
  | { k: "str"; v: string }
  | { k: "name"; v: string }
  | { k: "dots" }
  | { k: "un"; op: string; e: Expr }
  | { k: "bin"; op: string; l: Expr; r: Expr }
  | { k: "and"; l: Expr; r: Expr }
  | { k: "or"; l: Expr; r: Expr }
  | { k: "index"; t: Expr; i: Expr }
  | { k: "field"; t: Expr; n: string }
  | { k: "call"; callee: Expr; args: Expr[]; method?: string }
  | { k: "table"; fields: Field[] }
  | { k: "fn"; params: string[]; vararg: boolean; body: Stmt[] }

interface Field {
  key?: Expr
  name?: string
  value: Expr
}

type Stmt =
  | { k: "if"; arms: Array<{ cond: Expr; body: Stmt[] }>; elseBody: Stmt[] }
  | { k: "while"; cond: Expr; body: Stmt[] }
  | { k: "for"; name: string; start: Expr; stop: Expr; step: Expr | null; body: Stmt[] }
  | { k: "forin"; names: string[]; iter: Expr[]; body: Stmt[] }
  | { k: "do"; body: Stmt[] }
  | { k: "return"; values: Expr[] }
  | { k: "local"; names: string[]; values: Expr[] }
  | { k: "localfn"; name: string; params: string[]; vararg: boolean; body: Stmt[] }
  | { k: "assign"; targets: Target[]; values: Expr[] }
  | { k: "call"; expr: Expr }
  | { k: "break" }

type Target =
  | { k: "name"; name: string }
  | { k: "index"; table: Expr; key: Expr }
  | { k: "field"; table: Expr; name: string }

type Flow = { k: "next" } | { k: "return"; values: LuaValue[] } | { k: "break" }

const NEXT: Flow = { k: "next" }

function truthy(value: LuaValue): boolean {
  return value !== null && value !== false
}

function luaEqual(a: LuaValue, b: LuaValue): boolean {
  if (typeof a === "number" && typeof b === "string") return numberEqualsString(a, b)
  if (typeof b === "number" && typeof a === "string") return numberEqualsString(b, a)
  if (a instanceof LuaTable || b instanceof LuaTable) return a === b
  return a === b
}

function numberEqualsString(value: number, text: string): boolean {
  const trimmed = text.trim()
  if (!/^[-+]?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(trimmed)) return false
  return Number(trimmed) === value
}

function asNumber(value: LuaValue): number {
  if (typeof value === "number") return value
  if (typeof value === "string" && /^[-+]?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(value.trim())) {
    return Number(value.trim())
  }
  throw new Error("attempt to perform arithmetic on a non-number")
}

function asString(value: LuaValue): string {
  if (typeof value === "string") return value
  if (typeof value === "number") return Number.isInteger(value) ? String(value) : String(value)
  if (typeof value === "boolean") return value ? "true" : "false"
  if (value === null) throw new Error("attempt to concatenate a nil value")
  throw new Error("attempt to concatenate a non-string value")
}

function execBlock(body: Stmt[], env: Env): Flow {
  for (const stmt of body) {
    const flow = exec(stmt, env)
    if (flow.k !== "next") return flow
  }
  return NEXT
}

function exec(stmt: Stmt, env: Env): Flow {
  switch (stmt.k) {
    case "if": {
      for (const arm of stmt.arms) {
        if (truthy(first(evalExpr(arm.cond, env)))) return execBlock(arm.body, new Env(env))
      }
      return execBlock(stmt.elseBody, new Env(env))
    }
    case "while": {
      while (truthy(first(evalExpr(stmt.cond, env)))) {
        const flow = execBlock(stmt.body, new Env(env))
        if (flow.k === "return") return flow
        if (flow.k === "break") break
      }
      return NEXT
    }
    case "for": {
      const start = asNumber(first(evalExpr(stmt.start, env)))
      const stop = asNumber(first(evalExpr(stmt.stop, env)))
      const step = stmt.step ? asNumber(first(evalExpr(stmt.step, env))) : 1
      if (step === 0) throw new Error("'for' step is zero")
      for (let i = start; step > 0 ? i <= stop : i >= stop; i += step) {
        const local = new Env(env)
        local.define(stmt.name, i)
        const flow = execBlock(stmt.body, local)
        if (flow.k === "return") return flow
        if (flow.k === "break") break
      }
      return NEXT
    }
    case "forin": {
      const produced = evalList(stmt.iter, env)
      const iter = produced[0] ?? null
      const state = produced[1] ?? null
      let control = produced[2] ?? null
      if (typeof iter !== "function" && !(iter instanceof LuaClosure)) {
        throw new Error("attempt to call a non-function")
      }
      for (;;) {
        const values = callValue(iter, [state, control])
        const next = values[0] ?? null
        if (next === null) break
        control = next
        const local = new Env(env)
        stmt.names.forEach((name, index) => {
          local.define(name, values[index] ?? null)
        })
        const flow = execBlock(stmt.body, local)
        if (flow.k === "return") return flow
        if (flow.k === "break") break
      }
      return NEXT
    }
    case "do":
      return execBlock(stmt.body, new Env(env))
    case "return":
      return { k: "return", values: evalList(stmt.values, env) }
    case "local": {
      const values = evalList(stmt.values, env)
      stmt.names.forEach((name, index) => {
        env.define(name, values[index] ?? null)
      })
      return NEXT
    }
    case "localfn": {
      const closure = new LuaClosure(stmt.params, stmt.vararg, stmt.body, env)
      env.define(stmt.name, closure)
      return NEXT
    }
    case "assign": {
      const values = evalList(stmt.values, env)
      stmt.targets.forEach((target, index) => {
        assign(target, values[index] ?? null, env)
      })
      return NEXT
    }
    case "call":
      evalExpr(stmt.expr, env)
      return NEXT
    case "break":
      return { k: "break" }
    default: {
      const never: never = stmt
      return never
    }
  }
}

function assign(target: Target, value: LuaValue, env: Env): void {
  if (target.k === "name") {
    env.set(target.name, value)
    return
  }
  const table = first(evalExpr(target.k === "index" ? target.table : target.table, env))
  if (!(table instanceof LuaTable)) throw new Error("attempt to index a non-table")
  if (target.k === "field") table.set(target.name, value)
  else table.set(first(evalExpr(target.key, env)), value)
}

function evalList(exprs: Expr[], env: Env): LuaValue[] {
  if (exprs.length === 0) return []
  const out: LuaValue[] = []
  for (let i = 0; i < exprs.length; i++) {
    const expr = exprs[i]
    if (!expr) continue
    const values = evalExpr(expr, env)
    if (i === exprs.length - 1) out.push(...values)
    else out.push(values[0] ?? null)
  }
  return out
}

function first(values: LuaValue[]): LuaValue {
  return values[0] ?? null
}

function evalExpr(expr: Expr, env: Env): LuaValue[] {
  switch (expr.k) {
    case "nil":
      return [null]
    case "bool":
      return [expr.v]
    case "num":
      return [expr.v]
    case "str":
      return [expr.v]
    case "name":
      return [env.get(expr.v)]
    case "dots":
      return env.varargs
    case "un": {
      const value = first(evalExpr(expr.e, env))
      if (expr.op === "not") return [!truthy(value)]
      if (expr.op === "#") {
        if (typeof value === "string") return [value.length]
        if (value instanceof LuaTable) return [value.length()]
        throw new Error("attempt to get length of a non-table")
      }
      return [-asNumber(value)]
    }
    case "bin": {
      if (expr.op === "..") {
        return [asString(first(evalExpr(expr.l, env))) + asString(first(evalExpr(expr.r, env)))]
      }
      if (expr.op === "==" || expr.op === "~=") {
        const equal = luaEqual(first(evalExpr(expr.l, env)), first(evalExpr(expr.r, env)))
        return [expr.op === "==" ? equal : !equal]
      }
      if (expr.op === "<" || expr.op === ">" || expr.op === "<=" || expr.op === ">=") {
        const op = expr.op
        return [
          compare(expr.l, expr.r, env, (a, b) =>
            op === "<" ? a < b : op === ">" ? a > b : op === "<=" ? a <= b : a >= b,
          ),
        ]
      }
      const left = asNumber(first(evalExpr(expr.l, env)))
      const right = asNumber(first(evalExpr(expr.r, env)))
      switch (expr.op) {
        case "+":
          return [left + right]
        case "-":
          return [left - right]
        case "*":
          return [left * right]
        case "/":
          return [left / right]
        case "%":
          return [left % right]
        case "^":
          return [left ** right]
        default:
          throw new Error(`unexpected operator ${expr.op}`)
      }
    }
    case "and": {
      const left = evalExpr(expr.l, env)
      if (!truthy(first(left))) return [first(left)]
      return evalExpr(expr.r, env)
    }
    case "or": {
      const left = evalExpr(expr.l, env)
      if (truthy(first(left))) return [first(left)]
      return evalExpr(expr.r, env)
    }
    case "index": {
      const table = first(evalExpr(expr.t, env))
      if (!(table instanceof LuaTable)) throw new Error("attempt to index a non-table")
      return [table.get(first(evalExpr(expr.i, env)))]
    }
    case "field": {
      const table = first(evalExpr(expr.t, env))
      if (!(table instanceof LuaTable)) throw new Error("attempt to index a non-table")
      return [table.get(expr.n)]
    }
    case "call":
      return callExpr(expr, env)
    case "table":
      return [buildTable(expr, env)]
    case "fn":
      return [new LuaClosure(expr.params, expr.vararg, expr.body, env)]
    default: {
      const never: never = expr
      return never
    }
  }
}

function compare(
  left: Expr,
  right: Expr,
  env: Env,
  op: (a: number | string, b: number | string) => boolean,
): boolean {
  const a = first(evalExpr(left, env))
  const b = first(evalExpr(right, env))
  if (typeof a === "number" && typeof b === "number") return op(a, b)
  if (typeof a === "string" && typeof b === "string") return op(a, b)
  throw new Error("attempt to compare incompatible values")
}

function callExpr(expr: Extract<Expr, { k: "call" }>, env: Env): LuaValue[] {
  if (expr.method) {
    const self = first(evalExpr(expr.callee, env))
    if (!(self instanceof LuaTable)) throw new Error("attempt to index a non-table")
    const fn = self.get(expr.method)
    const args = evalList(expr.args, env)
    return callValue(fn, [self, ...args])
  }
  const fn = first(evalExpr(expr.callee, env))
  return callValue(fn, evalList(expr.args, env))
}

function callValue(fn: LuaValue, args: LuaValue[]): LuaValue[] {
  if (fn instanceof LuaClosure) {
    const local = new Env(fn.env)
    fn.params.forEach((name, index) => {
      local.define(name, args[index] ?? null)
    })
    local.varargs = fn.vararg ? args.slice(fn.params.length) : []
    const flow = execBlock(fn.body, local)
    return flow.k === "return" ? flow.values : [null]
  }
  if (typeof fn === "function") return fn(args)
  throw new Error("attempt to call a non-function")
}

function buildTable(expr: Extract<Expr, { k: "table" }>, env: Env): LuaTable {
  const table = new LuaTable()
  let index = 1
  expr.fields.forEach((field, fieldIndex) => {
    if (field.name !== undefined) {
      table.set(field.name, first(evalExpr(field.value, env)))
      return
    }
    if (field.key) {
      table.set(first(evalExpr(field.key, env)), first(evalExpr(field.value, env)))
      return
    }
    const values = evalExpr(field.value, env)
    const last = fieldIndex === expr.fields.length - 1
    const produced = last ? values : [values[0] ?? null]
    if (produced.length === 0) return
    for (const value of produced) {
      if (value !== null) table.set(index, value)
      index++
    }
  })
  return table
}

type Tok =
  | { k: "num"; v: number; line: number }
  | { k: "str"; v: string; line: number }
  | { k: "name"; v: string; line: number }
  | { k: "sym"; v: string; line: number }
  | { k: "eof"; line: number }

function tokenize(source: string): Tok[] {
  const toks: Tok[] = []
  let i = 0
  let line = 1
  const peek = (offset = 0) => source[i + offset]
  while (i < source.length) {
    const ch = peek()
    if (ch === "\n") {
      line++
      i++
      continue
    }
    if (ch === " " || ch === "\t" || ch === "\r") {
      i++
      continue
    }
    if (ch === "-" && peek(1) === "-") {
      if (peek(2) === "[") {
        const close = longBracket(source, i + 2)
        if (close) {
          const end = source.indexOf(close.end, close.next)
          if (end < 0) throw new Error(`unfinished long comment at line ${line}`)
          const skipped = source.slice(i, end)
          line += skipped.split("\n").length - 1
          i = end + close.end.length
          continue
        }
      }
      while (i < source.length && source[i] !== "\n") i++
      continue
    }
    if (ch === "'" || ch === '"') {
      const quote = ch
      i++
      let value = ""
      while (i < source.length && source[i] !== quote) {
        if (source[i] === "\n") line++
        if (source[i] === "\\") {
          i++
          const esc = source[i]
          const map: Record<string, string> = {
            n: "\n",
            r: "\r",
            t: "\t",
            a: "\u0007",
            b: "\b",
            f: "\f",
            v: "\v",
            "\\": "\\",
            "'": "'",
            '"': '"',
            "\n": "\n",
          }
          if (esc !== undefined && map[esc] !== undefined) value += map[esc]
          else if (esc !== undefined && esc >= "0" && esc <= "9") {
            let digits = esc
            for (let n = 0; n < 2; n++) {
              const next = source[i + 1]
              if (next === undefined || next < "0" || next > "9") break
              i++
              digits += next
            }
            value += String.fromCharCode(Number(digits) & 0xff)
          } else value += esc ?? ""
          i++
          continue
        }
        value += source[i] ?? ""
        i++
      }
      if (source[i] !== quote) throw new Error(`unfinished string at line ${line}`)
      i++
      toks.push({ k: "str", v: value, line })
      continue
    }
    if (ch === "[") {
      const bracket = longBracket(source, i)
      if (bracket) {
        let start = bracket.next
        if (source[start] === "\n") {
          start++
          line++
        }
        const end = source.indexOf(bracket.end, start)
        if (end < 0) throw new Error(`unfinished long string at line ${line}`)
        const value = source.slice(start, end)
        line += value.split("\n").length - 1
        i = end + bracket.end.length
        toks.push({ k: "str", v: value, line })
        continue
      }
    }
    const digit = peek(1)
    if (
      (ch !== undefined && ch >= "0" && ch <= "9") ||
      (ch === "." && digit !== undefined && digit >= "0" && digit <= "9")
    ) {
      const start = i
      if (ch === "0" && (peek(1) === "x" || peek(1) === "X")) {
        i += 2
        while (i < source.length && /[0-9a-fA-F]/.test(source[i] ?? "")) i++
        toks.push({ k: "num", v: Number(source.slice(start, i)), line })
        continue
      }
      while (i < source.length && /[0-9]/.test(source[i] ?? "")) i++
      if (source[i] === ".") {
        i++
        while (i < source.length && /[0-9]/.test(source[i] ?? "")) i++
      }
      if (source[i] === "e" || source[i] === "E") {
        i++
        if (source[i] === "+" || source[i] === "-") i++
        while (i < source.length && /[0-9]/.test(source[i] ?? "")) i++
      }
      toks.push({ k: "num", v: Number(source.slice(start, i)), line })
      continue
    }
    if (ch !== undefined && /[A-Za-z_]/.test(ch)) {
      const start = i
      i++
      while (i < source.length && /[A-Za-z0-9_]/.test(source[i] ?? "")) i++
      toks.push({ k: "name", v: source.slice(start, i), line })
      continue
    }
    const three = source.slice(i, i + 3)
    const two = source.slice(i, i + 2)
    if (three === "...") {
      toks.push({ k: "sym", v: "...", line })
      i += 3
      continue
    }
    if (["==", "~=", "<=", ">=", ".."].includes(two)) {
      toks.push({ k: "sym", v: two, line })
      i += 2
      continue
    }
    toks.push({ k: "sym", v: ch ?? "", line })
    i++
  }
  toks.push({ k: "eof", line })
  return toks
}

function longBracket(source: string, at: number): { next: number; end: string } | null {
  if (source[at] !== "[") return null
  let i = at + 1
  while (source[i] === "=") i++
  if (source[i] !== "[") return null
  const marks = i - (at + 1)
  return { next: i + 1, end: `]${"=".repeat(marks)}]` }
}

class Parser {
  private i = 0
  constructor(private readonly toks: Tok[]) {}

  private cur(): Tok {
    return this.toks[this.i] ?? { k: "eof", line: 0 }
  }

  private line(): number {
    return this.cur().line
  }

  private eat(): Tok {
    const tok = this.cur()
    this.i++
    return tok
  }

  private eatSym(value: string): boolean {
    const tok = this.cur()
    if (tok.k === "sym" && tok.v === value) {
      this.i++
      return true
    }
    return false
  }

  private expectSym(value: string): void {
    if (!this.eatSym(value)) throw new Error(`expected '${value}' at line ${this.line()}`)
  }

  private isName(value?: string): boolean {
    const tok = this.cur()
    return tok.k === "name" && (value === undefined || tok.v === value)
  }

  private eatName(value?: string): string | null {
    if (!this.isName(value)) return null
    const tok = this.eat()
    return tok.k === "name" ? tok.v : null
  }

  private expectName(): string {
    const name = this.eatName()
    if (name === null) throw new Error(`expected name at line ${this.line()}`)
    return name
  }

  parseChunk(): Stmt[] {
    const body = this.parseBlock()
    if (this.cur().k !== "eof") throw new Error(`unexpected token at line ${this.line()}`)
    return body
  }

  private parseBlock(): Stmt[] {
    const body: Stmt[] = []
    while (!this.blockEnd()) {
      if (this.isName("return")) {
        body.push(this.parseReturn())
        this.eatSym(";")
        break
      }
      body.push(this.parseStmt())
      this.eatSym(";")
    }
    return body
  }

  private blockEnd(): boolean {
    return (
      this.cur().k === "eof" ||
      this.isName("end") ||
      this.isName("else") ||
      this.isName("elseif") ||
      this.isName("until")
    )
  }

  private parseStmt(): Stmt {
    if (this.isName("if")) return this.parseIf()
    if (this.isName("while")) return this.parseWhile()
    if (this.isName("for")) return this.parseFor()
    if (this.isName("do")) {
      this.eat()
      const body = this.parseBlock()
      if (!this.eatName("end")) throw new Error(`expected 'end' at line ${this.line()}`)
      return { k: "do", body }
    }
    if (this.isName("local")) {
      this.eat()
      if (this.isName("function")) {
        this.eat()
        const name = this.expectName()
        const fn = this.parseFunctionTail()
        return { k: "localfn", name, params: fn.params, vararg: fn.vararg, body: fn.body }
      }
      const names = [this.expectName()]
      while (this.eatSym(",")) names.push(this.expectName())
      const values: Expr[] = []
      if (this.eatSym("=")) values.push(...this.parseExprList())
      return { k: "local", names, values }
    }
    if (this.isName("function")) {
      this.eat()
      const name = this.expectName()
      const fn = this.parseFunctionTail()
      return {
        k: "assign",
        targets: [{ k: "name", name }],
        values: [{ k: "fn", params: fn.params, vararg: fn.vararg, body: fn.body }],
      }
    }
    if (this.isName("break")) {
      this.eat()
      return { k: "break" }
    }
    const expr = this.parsePrefix()
    if (
      this.cur().k === "sym" &&
      this.cur().k === "sym" &&
      ((this.cur() as { v: string }).v === "=" || (this.cur() as { v: string }).v === ",")
    ) {
      const targets = [this.asTarget(expr)]
      while (this.eatSym(",")) targets.push(this.asTarget(this.parsePrefix()))
      this.expectSym("=")
      return { k: "assign", targets, values: this.parseExprList() }
    }
    if (expr.k !== "call") throw new Error(`expected statement at line ${this.line()}`)
    return { k: "call", expr }
  }

  private parseReturn(): Stmt {
    this.eat()
    if (
      this.blockEnd() ||
      (this.cur().k === "sym" && this.cur().k === "sym" && (this.cur() as { v: string }).v === ";")
    ) {
      return { k: "return", values: [] }
    }
    return { k: "return", values: this.parseExprList() }
  }

  private parseIf(): Stmt {
    this.eat()
    const arms: Array<{ cond: Expr; body: Stmt[] }> = []
    arms.push({ cond: this.parseExpr(), body: this.afterThen() })
    while (this.eatName("elseif")) arms.push({ cond: this.parseExpr(), body: this.afterThen() })
    let elseBody: Stmt[] = []
    if (this.eatName("else")) elseBody = this.parseBlock()
    if (!this.eatName("end")) throw new Error(`expected 'end' at line ${this.line()}`)
    return { k: "if", arms, elseBody }
  }

  private afterThen(): Stmt[] {
    if (!this.eatName("then")) throw new Error(`expected 'then' at line ${this.line()}`)
    return this.parseBlock()
  }

  private parseWhile(): Stmt {
    this.eat()
    const cond = this.parseExpr()
    if (!this.eatName("do")) throw new Error(`expected 'do' at line ${this.line()}`)
    const body = this.parseBlock()
    if (!this.eatName("end")) throw new Error(`expected 'end' at line ${this.line()}`)
    return { k: "while", cond, body }
  }

  private parseFor(): Stmt {
    this.eat()
    const name = this.expectName()
    if (this.eatSym("=")) {
      const start = this.parseExpr()
      this.expectSym(",")
      const stop = this.parseExpr()
      const step = this.eatSym(",") ? this.parseExpr() : null
      if (!this.eatName("do")) throw new Error(`expected 'do' at line ${this.line()}`)
      const body = this.parseBlock()
      if (!this.eatName("end")) throw new Error(`expected 'end' at line ${this.line()}`)
      return { k: "for", name, start, stop, step, body }
    }
    const names = [name]
    while (this.eatSym(",")) names.push(this.expectName())
    if (!this.eatName("in")) throw new Error(`expected 'in' at line ${this.line()}`)
    const iter = this.parseExprList()
    if (!this.eatName("do")) throw new Error(`expected 'do' at line ${this.line()}`)
    const body = this.parseBlock()
    if (!this.eatName("end")) throw new Error(`expected 'end' at line ${this.line()}`)
    return { k: "forin", names, iter, body }
  }

  private asTarget(expr: Expr): Target {
    if (expr.k === "name") return { k: "name", name: expr.v }
    if (expr.k === "index") return { k: "index", table: expr.t, key: expr.i }
    if (expr.k === "field") return { k: "field", table: expr.t, name: expr.n }
    throw new Error(`invalid assignment target at line ${this.line()}`)
  }

  private parseExprList(): Expr[] {
    const exprs = [this.parseExpr()]
    while (this.eatSym(",")) exprs.push(this.parseExpr())
    return exprs
  }

  private parseExpr(): Expr {
    return this.parseOr()
  }

  private parseOr(): Expr {
    let left = this.parseAnd()
    while (this.eatName("or")) left = { k: "or", l: left, r: this.parseAnd() }
    return left
  }

  private parseAnd(): Expr {
    let left = this.parseCmp()
    while (this.eatName("and")) left = { k: "and", l: left, r: this.parseCmp() }
    return left
  }

  private parseCmp(): Expr {
    let left = this.parseConcat()
    const tok = this.cur()
    if (tok.k === "sym" && ["==", "~=", "<", ">", "<=", ">="].includes(tok.v)) {
      this.eat()
      left = { k: "bin", op: tok.v, l: left, r: this.parseConcat() }
    }
    return left
  }

  private parseConcat(): Expr {
    const left = this.parseAdd()
    if (this.eatSym("..")) return { k: "bin", op: "..", l: left, r: this.parseConcat() }
    return left
  }

  private parseAdd(): Expr {
    let left = this.parseMul()
    while (
      this.cur().k === "sym" &&
      this.cur().k === "sym" &&
      ((this.cur() as { v: string }).v === "+" || (this.cur() as { v: string }).v === "-")
    ) {
      const op = (this.eat() as { v: string }).v
      left = { k: "bin", op, l: left, r: this.parseMul() }
    }
    return left
  }

  private parseMul(): Expr {
    let left = this.parseUnary()
    while (this.cur().k === "sym" && ["*", "/", "%"].includes((this.cur() as { v: string }).v)) {
      const op = (this.eat() as { v: string }).v
      left = { k: "bin", op, l: left, r: this.parseUnary() }
    }
    return left
  }

  private parseUnary(): Expr {
    if (this.eatName("not")) return { k: "un", op: "not", e: this.parseUnary() }
    if (this.eatSym("#")) return { k: "un", op: "#", e: this.parseUnary() }
    if (this.eatSym("-")) return { k: "un", op: "-", e: this.parseUnary() }
    return this.parsePower()
  }

  private parsePower(): Expr {
    const left = this.parsePrimary()
    if (this.eatSym("^")) return { k: "bin", op: "^", l: left, r: this.parseUnary() }
    return left
  }

  private parsePrimary(): Expr {
    if (this.eatName("nil")) return { k: "nil" }
    if (this.eatName("false")) return { k: "bool", v: false }
    if (this.eatName("true")) return { k: "bool", v: true }
    if (this.eatSym("...")) return { k: "dots" }
    const tok = this.cur()
    if (tok.k === "num") {
      this.eat()
      return { k: "num", v: tok.v }
    }
    if (tok.k === "str") {
      this.eat()
      return { k: "str", v: tok.v }
    }
    if (this.isName("function")) {
      this.eat()
      const fn = this.parseFunctionTail()
      return { k: "fn", params: fn.params, vararg: fn.vararg, body: fn.body }
    }
    if (this.eatSym("{")) return this.parseTable()
    return this.parsePrefix()
  }

  private parsePrefix(): Expr {
    let expr: Expr
    if (this.eatSym("(")) {
      expr = this.parseExpr()
      this.expectSym(")")
    } else if (this.cur().k === "name") {
      expr = { k: "name", v: this.expectName() }
    } else throw new Error(`expected expression at line ${this.line()}`)
    for (;;) {
      if (this.eatSym(".")) {
        expr = { k: "field", t: expr, n: this.expectName() }
        continue
      }
      if (this.eatSym("[")) {
        const index = this.parseExpr()
        this.expectSym("]")
        expr = { k: "index", t: expr, i: index }
        continue
      }
      if (this.eatSym(":")) {
        const method = this.expectName()
        const args = this.parseCallArgs()
        expr = { k: "call", callee: expr, args, method }
        continue
      }
      if (this.startsArgs()) {
        expr = { k: "call", callee: expr, args: this.parseCallArgs() }
        continue
      }
      return expr
    }
  }

  private startsArgs(): boolean {
    return this.eatSymPeek("(") || this.eatSymPeek("{") || this.cur().k === "str"
  }

  private eatSymPeek(value: string): boolean {
    const tok = this.cur()
    return tok.k === "sym" && tok.v === value
  }

  private parseCallArgs(): Expr[] {
    if (this.eatSym("(")) {
      const args =
        this.cur().k === "sym" && (this.cur() as { v: string }).v === ")"
          ? []
          : this.parseExprList()
      this.expectSym(")")
      return args
    }
    if (this.eatSym("{")) return [this.parseTable()]
    const tok = this.cur()
    if (tok.k === "str") {
      this.eat()
      return [{ k: "str", v: tok.v }]
    }
    throw new Error(`expected arguments at line ${this.line()}`)
  }

  private parseFunctionTail(): { params: string[]; vararg: boolean; body: Stmt[] } {
    this.expectSym("(")
    const params: string[] = []
    let vararg = false
    if (!this.eatSym(")")) {
      for (;;) {
        if (this.eatSym("...")) {
          vararg = true
          break
        }
        params.push(this.expectName())
        if (!this.eatSym(",")) break
      }
      this.expectSym(")")
    }
    const body = this.parseBlock()
    if (!this.eatName("end")) throw new Error(`expected 'end' at line ${this.line()}`)
    return { params, vararg, body }
  }

  private parseTable(): Expr {
    const fields: Field[] = []
    while (!(this.cur().k === "sym" && (this.cur() as { v: string }).v === "}")) {
      if (this.eatSym("[")) {
        const key = this.parseExpr()
        this.expectSym("]")
        this.expectSym("=")
        fields.push({ key, value: this.parseExpr() })
      } else if (
        this.cur().k === "name" &&
        this.toks[this.i + 1]?.k === "sym" &&
        (this.toks[this.i + 1] as { v: string }).v === "="
      ) {
        const name = this.expectName()
        this.expectSym("=")
        fields.push({ name, value: this.parseExpr() })
      } else fields.push({ value: this.parseExpr() })
      if (!this.eatSym(",") && !this.eatSym(";")) break
    }
    this.expectSym("}")
    return { k: "table", fields }
  }
}

function stringSub(value: string, startRaw: number, endRaw?: number): string {
  const n = value.length
  const normalize = (index: number) => (index < 0 ? n + index + 1 : index)
  const start = normalize(startRaw)
  const end = endRaw === undefined ? n : normalize(endRaw)
  if (start > end) return ""
  return value.slice(Math.max(start, 1) - 1, Math.min(end, n))
}

function toJson(value: LuaValue): unknown {
  if (value === null) return null
  if (typeof value === "boolean" || typeof value === "number") return value
  if (typeof value === "string") return utf8Text(fromLatin1(value))
  if (value instanceof LuaTable) {
    const named = [...value.map.keys()]
    if (named.length === 0 && value.length() === 0) return {}
    if (named.length === 0) {
      const list: unknown[] = []
      for (let i = 1; i <= value.length(); i++) list.push(toJson(value.get(i)))
      return list
    }
    const object: Record<string, unknown> = {}
    for (const [key, item] of value.map) object[utf8Text(fromLatin1(key))] = toJson(item)
    return object
  }
  return null
}

function fromJson(value: unknown): LuaValue {
  if (value === null || value === undefined) return null
  if (typeof value === "boolean" || typeof value === "number") return value
  if (typeof value === "string") return latin1(utf8(value))
  if (Array.isArray(value)) {
    const table = new LuaTable()
    value.forEach((item, index) => {
      table.set(index + 1, fromJson(item))
    })
    return table
  }
  if (typeof value === "object") {
    const table = new LuaTable()
    for (const [key, item] of Object.entries(value)) table.set(key, fromJson(item))
    return table
  }
  return null
}

export interface LuaRedisHost {
  call(args: LuaValue[]): LuaValue[]
  pcall(args: LuaValue[]): LuaValue[]
}

export function luaGlobals(host: LuaRedisHost): Env {
  const env = new Env(null)
  const redis = new LuaTable()
  redis.set("call", host.call)
  redis.set("pcall", host.pcall)
  redis.set("error_reply", (args) => [new LuaFailure(asString(args[0] ?? null))])
  redis.set("status_reply", (args) => [new LuaStatus(asString(args[0] ?? null))])
  redis.set("sha1hex", (args) => [sha1Hex(fromLatin1(asString(args[0] ?? null)))])
  redis.set("log", () => [null])
  redis.set("replicate_commands", () => [1])
  redis.set("set_repl", () => [null])
  redis.set("LOG_DEBUG", 0)
  redis.set("LOG_VERBOSE", 1)
  redis.set("LOG_NOTICE", 2)
  redis.set("LOG_WARNING", 3)
  env.define("redis", redis)

  const stringLib = new LuaTable()
  stringLib.set("len", (args) => [asString(args[0] ?? null).length])
  stringLib.set("sub", (args) => [
    stringSub(
      asString(args[0] ?? null),
      asNumber(args[1] ?? 1),
      args[2] === undefined ? undefined : asNumber(args[2] ?? 0),
    ),
  ])
  stringLib.set("byte", (args) => {
    const value = asString(args[0] ?? null)
    const start = args[1] === undefined ? 1 : asNumber(args[1] ?? 1)
    const end = args[2] === undefined ? start : asNumber(args[2] ?? start)
    const slice = stringSub(value, start, end)
    return [...slice].map((ch) => ch.charCodeAt(0))
  })
  stringLib.set("char", (args) => [
    args.map((arg) => String.fromCharCode(asNumber(arg) & 0xff)).join(""),
  ])
  stringLib.set("format", (args) => [formatString(asString(args[0] ?? ""), args.slice(1))])
  stringLib.set("find", (args) => {
    const hay = asString(args[0] ?? null)
    const needle = asString(args[1] ?? "")
    const init = args[2] === undefined ? 1 : asNumber(args[2] ?? 1)
    const at = hay.indexOf(needle, Math.max(0, init - 1))
    if (at < 0) return [null]
    return [at + 1, at + needle.length]
  })
  stringLib.set("lower", (args) => [asString(args[0] ?? null).toLowerCase()])
  stringLib.set("upper", (args) => [asString(args[0] ?? null).toUpperCase()])
  stringLib.set("rep", (args) => [asString(args[0] ?? "").repeat(asNumber(args[1] ?? 0))])
  env.define("string", stringLib)

  const tableLib = new LuaTable()
  tableLib.set("insert", (args) => {
    const table = args[0]
    if (!(table instanceof LuaTable)) throw new Error("bad argument to table.insert")
    if (args.length >= 3) {
      const pos = asNumber(args[1] ?? 1)
      const value = args[2] ?? null
      for (let i = table.length(); i >= pos; i--) table.set(i + 1, table.get(i))
      table.set(pos, value)
    } else table.set(table.length() + 1, args[1] ?? null)
    return [null]
  })
  tableLib.set("remove", (args) => {
    const table = args[0]
    if (!(table instanceof LuaTable)) throw new Error("bad argument to table.remove")
    const pos = args[1] === undefined ? table.length() : asNumber(args[1] ?? 1)
    const value = table.get(pos)
    const len = table.length()
    for (let i = pos; i < len; i++) table.set(i, table.get(i + 1))
    table.set(len, null)
    return [value]
  })
  tableLib.set("concat", (args) => {
    const table = args[0]
    if (!(table instanceof LuaTable)) throw new Error("bad argument to table.concat")
    const sep = args[1] === undefined || args[1] === null ? "" : asString(args[1])
    const start = args[2] === undefined ? 1 : asNumber(args[2] ?? 1)
    const finish = args[3] === undefined ? table.length() : asNumber(args[3] ?? 0)
    const parts: string[] = []
    for (let i = start; i <= finish; i++) parts.push(asString(table.get(i)))
    return [parts.join(sep)]
  })
  tableLib.set("unpack", (args) => unpackTable(args))
  env.define("table", tableLib)

  const mathLib = new LuaTable()
  mathLib.set("floor", (args) => [Math.floor(asNumber(args[0] ?? 0))])
  mathLib.set("ceil", (args) => [Math.ceil(asNumber(args[0] ?? 0))])
  mathLib.set("abs", (args) => [Math.abs(asNumber(args[0] ?? 0))])
  mathLib.set("max", (args) => [Math.max(...args.map((arg) => asNumber(arg)))])
  mathLib.set("min", (args) => [Math.min(...args.map((arg) => asNumber(arg)))])
  mathLib.set("huge", Infinity)
  env.define("math", mathLib)

  const cjson = new LuaTable()
  cjson.set("encode", (args) => [latin1(utf8(JSON.stringify(toJson(args[0] ?? null)) ?? "null"))])
  cjson.set("decode", (args) => {
    const text = utf8Text(fromLatin1(asString(args[0] ?? "null")))
    return [fromJson(JSON.parse(text))]
  })
  env.define("cjson", cjson)

  const cmsgpack = new LuaTable()
  cmsgpack.set("unpack", (args) => [fromJson(decode(fromLatin1(asString(args[0] ?? ""))))])
  cmsgpack.set("pack", (args) => [latin1(encode(toJson(args[0] ?? null)))])
  env.define("cmsgpack", cmsgpack)

  env.define("tonumber", (args) => {
    const value = args[0] ?? null
    if (typeof value === "number") return [value]
    if (typeof value !== "string") return [null]
    if (!/^[-+]?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(value.trim())) return [null]
    return [Number(value.trim())]
  })
  env.define("tostring", (args) => {
    const value = args[0] ?? null
    if (value === null) return ["nil"]
    if (typeof value === "boolean") return [value ? "true" : "false"]
    if (typeof value === "number" || typeof value === "string") return [String(value)]
    if (value instanceof LuaTable) return ["table"]
    if (value instanceof LuaStatus) return [value.ok]
    return ["userdata"]
  })
  env.define("type", (args) => {
    const value = args[0] ?? null
    if (value === null) return ["nil"]
    if (typeof value === "boolean") return ["boolean"]
    if (typeof value === "number") return ["number"]
    if (typeof value === "string") return ["string"]
    if (value instanceof LuaTable) return ["table"]
    if (typeof value === "function" || value instanceof LuaClosure) return ["function"]
    return ["userdata"]
  })
  env.define("unpack", (args) => unpackTable(args))
  env.define("ipairs", (args) => {
    const table = args[0]
    const iter: LuaHost = (callArgs) => {
      const subject = callArgs[0]
      const index = (typeof callArgs[1] === "number" ? callArgs[1] : 0) + 1
      if (!(subject instanceof LuaTable) || !subject.has(index)) return [null]
      return [index, subject.get(index)]
    }
    return [iter, table ?? null, 0]
  })
  env.define("pairs", (args) => {
    const table = args[0]
    if (!(table instanceof LuaTable)) throw new Error("bad argument to pairs")
    const keys: LuaValue[] = [...table.array.keys(), ...table.map.keys()]
    let cursor = 0
    const iter: LuaHost = () => {
      const key = keys[cursor]
      cursor++
      if (key === undefined) return [null]
      return [key, table.get(key)]
    }
    return [iter, table, null]
  })
  env.define("error", (args) => {
    throw new Error(asString(args[0] ?? "error"))
  })
  env.define("select", (args) => {
    const index = args[0]
    const rest = args.slice(1)
    if (index === "#") return [rest.length]
    const at = asNumber(index ?? 1)
    if (at < 1) throw new Error("bad argument to select")
    return rest.slice(at - 1)
  })
  env.define("next", () => {
    throw new Error("next is not implemented")
  })
  return env
}

function unpackTable(args: LuaValue[]): LuaValue[] {
  const table = args[0]
  if (!(table instanceof LuaTable)) throw new Error("bad argument to unpack")
  const start = args[1] === undefined ? 1 : asNumber(args[1] ?? 1)
  const finish = args[2] === undefined ? table.length() : asNumber(args[2] ?? 0)
  const out: LuaValue[] = []
  for (let i = start; i <= finish; i++) out.push(table.get(i))
  return out
}

function formatString(fmt: string, args: LuaValue[]): string {
  let out = ""
  let arg = 0
  for (let i = 0; i < fmt.length; i++) {
    if (fmt[i] !== "%") {
      out += fmt[i] ?? ""
      continue
    }
    const spec = fmt[++i]
    if (spec === "%") {
      out += "%"
      continue
    }
    const value = args[arg++] ?? null
    if (spec === "s") out += value === null ? "nil" : asString(value)
    else if (spec === "d" || spec === "i") out += String(Math.trunc(asNumber(value)))
    else if (spec === "f") out += String(asNumber(value))
    else if (spec === "q")
      out += `"${asString(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`
    else out += spec ?? ""
  }
  return out
}

export function runLua(source: string, env: Env): LuaValue[] {
  let body: Stmt[]
  try {
    body = new Parser(tokenize(source)).parseChunk()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Error compiling script: ${message}`)
  }
  const flow = execBlock(body, env)
  return flow.k === "return" ? flow.values : [null]
}

/** Top-level Redis conversion. Nil ends an array; false becomes a null bulk. */
export function luaToReplyValue(
  value: LuaValue,
): "null" | "true" | "status" | "failure" | "number" | "string" | "table" {
  if (value === null || value === false) return "null"
  if (value === true) return "true"
  if (value instanceof LuaStatus) return "status"
  if (value instanceof LuaFailure) return "failure"
  if (typeof value === "number") return "number"
  if (typeof value === "string") return "string"
  if (value instanceof LuaTable) return "table"
  return "null"
}
