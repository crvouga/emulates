/**
 * The TraceQL subset the emulator evaluates: one spanset filter holding `true`/`false`, exact
 * attribute equality (`.name`, `span.name`, `resource.name` against a string, number or boolean)
 * and `&&` between them.
 *
 * Anything else is refused, never matched loosely. The lexer follows Tempo's
 * (`pkg/traceql/lexer.go`): the same token table, the same attribute runes, and positions as
 * Go's `text/scanner` reports them, so an error reads like Tempo's
 * `parse error at line 1, col 3: syntax error: unexpected IDENTIFIER`. Input that is valid
 * TraceQL outside the subset is refused as `<feature> not yet supported`, the wording Tempo's
 * validator uses for features it lacks, with a note that the limit is the emulator's.
 */
import { type AttributeValue, comparableValues, findAttribute, type WireKeyValue } from "./otlp.js"

/** The text Tempo puts after `invalid TraceQL query: ` in a 400 body. */
export class TraceQLError extends Error {
  constructor(
    message: string,
    /** `syntax`: Tempo's parser rejects it too. `unsupported`: outside the emulated subset. */
    readonly kind: "syntax" | "unsupported",
  ) {
    super(message)
    this.name = "TraceQLError"
  }
}

export const UNSUPPORTED_NOTE = "(Mockingbird emulates a TraceQL subset)"

const parseError = (message: string, line: number, column: number): TraceQLError =>
  new TraceQLError(
    line === 0 && column === 0
      ? `parse error : ${message}`
      : `parse error at line ${line}, col ${column}: ${message}`,
    "syntax",
  )

const unsupported = (feature: string): TraceQLError =>
  new TraceQLError(`${feature} not yet supported ${UNSUPPORTED_NOTE}`, "unsupported")

/** Tempo's `tokenMap`: every operator and keyword of the full language. */
const TOKENS = new Set([
  ...[",", ".", "{", "}", "(", ")", "=", "!=", "=~", "!~", ">", ">=", "<", "<=", "+", "-", "/"],
  ...["%", "*", "^", "true", "false", "nil", "ok", "error", "unset", "unspecified", "internal"],
  ...["server", "client", "producer", "consumer", "&&", "||", "!", "|", ">>", "<<", "~", "!>"],
  ...["!<", "!>>", "!<<", "&~", "&>", "&<", "&>>", "&<<", "duration", "childCount", "name"],
  ...["status", "statusMessage", "kind", "rootName", "rootServiceName", "rootService"],
  ...["traceDuration", "nestedSetLeft", "nestedSetRight", "nestedSetParent", "id", "traceID"],
  ...["spanID", "parentID", "timeSinceStart", "version", "parent", "parent.", "resource."],
  ...["span.", "trace:", "span:", "event:", "link:", "instrumentation:", "event.", "link."],
  ...["instrumentation.", "count", "avg", "max", "min", "sum", "by", "coalesce", "select"],
  ...["rate", "count_over_time", "min_over_time", "max_over_time", "avg_over_time"],
  ...["sum_over_time", "quantile_over_time", "histogram_over_time", "compare", "topk"],
  ...["bottomk", "with"],
])

const ATTRIBUTE_SCOPES = new Set([
  ".",
  "span.",
  "resource.",
  "parent.",
  "event.",
  "link.",
  "instrumentation.",
])
const SUPPORTED_SCOPES: Record<string, Scope> = {
  ".": "any",
  "span.": "span",
  "resource.": "resource",
}
const INTRINSICS = new Set([
  ...["duration", "childCount", "name", "status", "statusMessage", "kind", "rootName"],
  ...["rootServiceName", "rootService", "traceDuration", "nestedSetLeft", "nestedSetRight"],
  ...["nestedSetParent", "id", "traceID", "spanID", "parentID", "timeSinceStart", "version"],
  ...["parent", "trace:", "span:", "event:", "link:", "instrumentation:"],
])
const AGGREGATES = new Set([
  ...["count", "avg", "max", "min", "sum", "rate", "count_over_time", "min_over_time"],
  ...["max_over_time", "avg_over_time", "sum_over_time", "quantile_over_time"],
  ...["histogram_over_time", "compare", "topk", "bottomk"],
])
const ENUM_STATICS = new Set([
  ...["nil", "ok", "error", "unset", "unspecified", "internal", "server", "client"],
  ...["producer", "consumer"],
])
/** Tokens that only ever sit between two operands, so one in operand position is a syntax error. */
const BINARY_ONLY = new Set([
  ...["=", "!=", "=~", "!~", ">", ">=", "<", "<=", "+", "/", "%", "*", "^", "&&", "||", "|"],
  ...[">>", "<<", "~", "!>", "!<", "!>>", "!<<", "&~", "&>", "&<", "&>>", "&<<"],
])
/** Spanset and pipeline operators: valid between `{…}` blocks, never inside one. */
const SPANSET_ONLY = new Set([
  ...["|", ">>", "<<", "~", "!>", "!<", "!>>", "!<<", "&~", "&>", "&<", "&>>", "&<<"],
])
/** Operators that join two spansets (`{…} && {…}`, `{…} >> {…}`). */
const SPANSET_OPERATORS = new Set([
  ...["&&", "||", ">", "<", ">>", "<<", "~", "!~", "!>", "!<", "!>>", "!<<"],
  ...["&~", "&>", "&<", "&>>", "&<<"],
])
const CLOSERS = new Set(["}", ")", ","])
const LITERALS = new Set(["STRING", "INTEGER", "FLOAT", "DURATION"])

type Scope = "any" | "span" | "resource"

type Token = {
  /** Tempo's name for the token, as its error messages print it. */
  name: string
  /** `0` when Tempo's lexer advanced past the scanned token, which voids the line. */
  line: number
  column: number
  /** Decoded text of a STRING, INTEGER or FLOAT. */
  value?: string
  /** Attribute name after a scope token. */
  attribute?: string
  /** A lexer failure, raised when the parser reaches this token (Tempo lexes lazily). */
  error?: TraceQLError
}

/** Characters that end an attribute name (`isAttributeRune` is false for them). */
const ENDS_ATTRIBUTE = new Set(["{", "}", "(", ")", "=", "~", "!", "<", ">", "&", "|", "^", ","])
/** What Go's `text/scanner` skips between tokens (`GoWhitespace`): tab, LF, CR and space. */
const isSpace = (c: string | undefined) => c === " " || c === "\t" || c === "\n" || c === "\r"
/** Go's `unicode.IsSpace`, which ends an attribute name. */
const UNICODE_SPACE = /[\t\n\v\f\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/
const isAttributeRune = (c: string | undefined) =>
  c !== undefined && !UNICODE_SPACE.test(c) && !ENDS_ATTRIBUTE.has(c)
const DURATION = /^(?:\d+(?:\.\d+)?(?:ns|us|µs|ms|s|m|h|d|w|y))+$/
/** Longer than any duration literal worth writing; bounds the look-ahead after a number. */
const MAX_DURATION_LENGTH = 40

/** Go's `strconv.Unquote` for an interpreted string body; `undefined` when it is invalid. */
const unquote = (body: string): string | undefined => {
  let out = ""
  for (let i = 0; i < body.length; i++) {
    const c = body[i] as string
    if (c === "\n") return undefined
    if (c !== "\\") {
      out += c
      continue
    }
    const next = body[++i]
    const simple: Record<string, string> = {
      a: "\x07",
      b: "\b",
      f: "\f",
      n: "\n",
      r: "\r",
      t: "\t",
      v: "\v",
      "\\": "\\",
      '"': '"',
    }
    if (next !== undefined && next in simple) {
      out += simple[next]
      continue
    }
    const octal = /^[0-7]{3}/.exec(body.slice(i))?.[0]
    if (octal !== undefined) {
      const byte = Number.parseInt(octal, 8)
      if (byte > 0xff) return undefined
      out += String.fromCharCode(byte)
      i += 2
      continue
    }
    const width = next === "x" ? 2 : next === "u" ? 4 : next === "U" ? 8 : 0
    const digits = body.slice(i + 1, i + 1 + width)
    if (width === 0 || digits.length !== width || !/^[0-9a-fA-F]+$/.test(digits)) return undefined
    const code = Number.parseInt(digits, 16)
    // Go rejects surrogate halves and anything past the last code point.
    if (code > 0x10ffff || (width !== 2 && code >= 0xd800 && code <= 0xdfff)) return undefined
    out += String.fromCodePoint(code)
    i += width
  }
  return out
}

const lex = (input: string): Token[] => {
  const tokens: Token[] = []
  const fail = (message: string, line: number, column: number): Token[] => {
    tokens.push({ name: "$error", line, column, error: parseError(message, line, column) })
    return tokens
  }
  let pos = 0
  let line = 1
  let column = 1
  /** Consume one character (a surrogate pair is one), as Go's scanner counts columns. */
  const advance = (): string => {
    const c = String.fromCodePoint(input.codePointAt(pos) as number)
    pos += c.length
    if (c === "\n") {
      line++
      column = 1
    } else column++
    return c
  }
  for (;;) {
    // Go's scanner, which Tempo lexes with, skips white space and comments.
    for (;;) {
      while (pos < input.length && isSpace(input[pos])) advance()
      if (input[pos] === "/" && input[pos + 1] === "/") {
        while (pos < input.length && input[pos] !== "\n") advance()
      } else if (input[pos] === "/" && input[pos + 1] === "*") {
        const startOfComment = { line, column }
        advance()
        advance()
        while (pos < input.length && !(input[pos] === "*" && input[pos + 1] === "/")) advance()
        if (pos >= input.length) {
          return fail("comment not terminated", startOfComment.line, startOfComment.column)
        }
        advance()
        advance()
      } else break
    }
    if (pos >= input.length) {
      tokens.push({
        name: "$end",
        line: input.length === 0 ? 0 : line,
        column: input.length === 0 ? 0 : column,
      })
      return tokens
    }
    const start = { line, column }
    const c = input[pos] as string
    if (c === '"' || c === "`") {
      advance()
      let body = ""
      let closed = false
      while (pos < input.length) {
        const ch = advance()
        if (ch === c) {
          closed = true
          break
        }
        body += ch
        if (c === '"' && ch === "\\" && pos < input.length) body += advance()
      }
      if (!closed) return fail("literal not terminated", start.line, start.column)
      const value = c === "`" ? body : unquote(body)
      if (value === undefined) return fail("invalid syntax", start.line, start.column)
      tokens.push({ name: "STRING", ...start, value })
      continue
    }
    if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(input[pos + 1] ?? ""))) {
      const number = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(input.slice(pos))?.[0] ?? c
      for (let i = 0; i < number.length; i++) advance()
      let rest = ""
      while (
        rest.length <= MAX_DURATION_LENGTH &&
        /[0-9nsumhµdwy.]/.test(input[pos + rest.length] ?? "")
      ) {
        rest += input[pos + rest.length]
      }
      if (rest !== "" && rest.length <= MAX_DURATION_LENGTH && DURATION.test(number + rest)) {
        for (let i = 0; i < rest.length; i++) advance()
        tokens.push({ name: "DURATION", line: 0, column: start.column })
        continue
      }
      if (/^\d+$/.test(number)) {
        // Go scans a leading zero as an octal literal; Tempo then reads the text as an int.
        const stray = /^0\d*?([89])/.exec(number)?.[1]
        if (stray !== undefined) {
          return fail(`invalid digit '${stray}' in octal literal`, start.line, start.column)
        }
        if (BigInt(number) >= 2n ** 63n) {
          return fail(
            `strconv.Atoi: parsing ${JSON.stringify(number)}: value out of range`,
            start.line,
            start.column,
          )
        }
        tokens.push({ name: "INTEGER", ...start, value: number })
        continue
      }
      if (!Number.isFinite(Number(number))) {
        return fail(
          `strconv.ParseFloat: parsing ${JSON.stringify(number)}: value out of range`,
          start.line,
          start.column,
        )
      }
      tokens.push({ name: "FLOAT", ...start, value: number })
      continue
    }
    let text = advance()
    if (/[A-Za-z_]/.test(c)) {
      while (/[A-Za-z0-9_]/.test(input[pos] ?? "")) text += advance()
    }
    // Tempo extends a token one character at a time while the result is still a known token
    // (`!` → `!=`, `span` → `span.`); advancing this way is what voids the reported line.
    let extended = false
    while (pos < input.length && TOKENS.has(text + input[pos])) {
      text += advance()
      extended = true
    }
    const position = { line: extended ? 0 : start.line, column: start.column }
    if (!TOKENS.has(text)) {
      tokens.push({ name: "IDENTIFIER", ...position })
      continue
    }
    if (!ATTRIBUTE_SCOPES.has(text)) {
      tokens.push({ name: text, ...position })
      continue
    }
    if (!isAttributeRune(input[pos])) {
      // `parent.` may also be followed by a nested scope, which Tempo's message lists.
      return fail(
        `syntax error: unexpected END_ATTRIBUTE, expecting IDENTIFIER${text === "parent." ? " or resource. or span." : ""}`,
        position.line,
        position.column,
      )
    }
    let attribute = ""
    while (pos < input.length) {
      const ch = input[pos] as string
      if (ch === '"') {
        advance()
        let closed = false
        while (pos < input.length) {
          const q = advance()
          if (q === '"') {
            closed = true
            break
          }
          if (q !== "\\") {
            attribute += q
            continue
          }
          const escaped = input[pos]
          if (escaped !== "\\" && escaped !== '"') {
            return fail("invalid escape sequence", 0, position.column)
          }
          attribute += advance()
        }
        if (!closed) return fail('unexpected EOF, expecting "', 0, position.column)
      } else if (isAttributeRune(ch)) attribute += advance()
      else break
    }
    tokens.push({ name: text, ...position, attribute })
  }
}

export type Static =
  | { type: "string"; value: string }
  | { type: "int"; value: bigint }
  | { type: "float"; value: number }
  | { type: "bool"; value: boolean }

export type Condition = { scope: Scope; name: string; value: Static }

/** A parsed query of the subset: every condition must hold on one span. */
export type Query = {
  conditions: Condition[]
  /** A literal `false` term: no span can match. */
  never: boolean
}

const describe = (token: Token): string => {
  const { name } = token
  if (name === "(") return "parenthesised expression"
  if (name === "|") return "pipeline (|)"
  if (name === "with") return "query hints (with)"
  if (name === "by" || name === "select" || name === "coalesce") return `${name}() operation`
  if (AGGREGATES.has(name)) return `aggregate operation (${name})`
  if (INTRINSICS.has(name)) return `intrinsic (${name})`
  if (ATTRIBUTE_SCOPES.has(name)) return `attribute scope (${name})`
  if (ENUM_STATICS.has(name)) return `static value (${name})`
  if (name === "DURATION") return "duration static"
  if (LITERALS.has(name)) return "comparison with a static on the left"
  if (name === "!" || name === "-") return `unary operation (${name})`
  return `binary operation (${name})`
}

const unexpected = (token: Token): TraceQLError =>
  parseError(`syntax error: unexpected ${token.name}`, token.line, token.column)

/**
 * Refuse `token`: a syntax error when no TraceQL production could continue with it here,
 * otherwise a construct the subset does not evaluate.
 */
const refuse = (token: Token, syntaxNames: (name: string) => boolean): TraceQLError =>
  token.name === "$end" || token.name === "IDENTIFIER" || syntaxNames(token.name)
    ? unexpected(token)
    : unsupported(describe(token))

/** Where an operand must start: a closer or a binary operator cannot. */
const beforeOperand = (name: string): boolean => CLOSERS.has(name) || BINARY_ONLY.has(name)
/** Right after an operand: another operand, or an operator that only joins spansets, cannot follow. */
const afterOperand = (name: string): boolean =>
  LITERALS.has(name) ||
  ATTRIBUTE_SCOPES.has(name) ||
  SPANSET_ONLY.has(name) ||
  name === ")" ||
  name === ","

/** Parse `query`; throws {@link TraceQLError} for anything outside the subset. */
export const parseTraceQL = (query: string): Query => {
  const tokens = lex(query)
  let index = 0
  const peek = (): Token => {
    const token = tokens[index] as Token
    if (token.error) throw token.error
    return token
  }
  const take = (): Token => tokens[index++] as Token
  const out: Query = { conditions: [], never: false }

  if (peek().name !== "{") {
    throw refuse(peek(), (n) => CLOSERS.has(n) || BINARY_ONLY.has(n) || n === "STRING")
  }
  take()
  if (peek().name === "}") take()
  else {
    for (;;) {
      const term = peek()
      if (term.name === "true" || term.name === "false") {
        take()
        if (term.name === "false") out.never = true
      } else if (Object.hasOwn(SUPPORTED_SCOPES, term.name)) {
        take()
        const operator = peek()
        if (operator.name !== "=") {
          if (operator.name === "}" || operator.name === "&&") {
            throw unsupported("attribute existence expression")
          }
          throw refuse(operator, afterOperand)
        }
        take()
        out.conditions.push({
          scope: SUPPORTED_SCOPES[term.name] as Scope,
          name: term.attribute ?? "",
          value: parseStatic(peek, take),
        })
      } else {
        throw refuse(term, beforeOperand)
      }
      const next = peek()
      if (next.name === "&&") {
        take()
        continue
      }
      if (next.name === "}") {
        take()
        break
      }
      throw refuse(next, afterOperand)
    }
  }
  const trailing = peek()
  if (trailing.name !== "$end") {
    if (SPANSET_OPERATORS.has(trailing.name)) {
      take()
      const operand = peek()
      // Tempo's own message for a spanset operator with nothing after it (`{ true } &&`).
      if (operand.name === "$end") {
        throw parseError(
          "syntax error: unexpected $end, expecting { or (",
          operand.line,
          operand.column,
        )
      }
      throw unsupported(`spanset operation (${trailing.name})`)
    }
    throw refuse(
      trailing,
      (n) => CLOSERS.has(n) || LITERALS.has(n) || n === "{" || (BINARY_ONLY.has(n) && n !== "|"),
    )
  }
  return out
}

const parseStatic = (peek: () => Token, take: () => Token): Static => {
  const token = peek()
  if (token.name === "STRING") {
    take()
    return { type: "string", value: token.value ?? "" }
  }
  if (token.name === "true" || token.name === "false") {
    take()
    return { type: "bool", value: token.name === "true" }
  }
  const negative = token.name === "-"
  if (negative) take()
  const number = peek()
  if (number.name === "INTEGER") {
    take()
    return { type: "int", value: BigInt(`${negative ? "-" : ""}${number.value}`) }
  }
  if (number.name === "FLOAT") {
    take()
    return { type: "float", value: Number(`${negative ? "-" : ""}${number.value}`) }
  }
  if (negative) throw refuse(number, beforeOperand)
  if (ATTRIBUTE_SCOPES.has(token.name)) throw unsupported("comparison of two attributes")
  throw refuse(token, beforeOperand)
}

const equal = (attribute: AttributeValue, wanted: Static): boolean => {
  const numeric = (v: AttributeValue | Static) => v.type === "int" || v.type === "float"
  if (numeric(attribute) && numeric(wanted)) {
    return attribute.type === "int" && wanted.type === "int"
      ? attribute.value === wanted.value
      : Number(attribute.value) === Number(wanted.value)
  }
  return attribute.type === wanted.type && attribute.value === wanted.value
}

export type SpanAttributes = {
  span: WireKeyValue[] | undefined
  resource: WireKeyValue[] | undefined
}

/**
 * The attribute a condition reads. An unscoped name resolves to the span attribute first, then
 * the resource attribute, as Tempo's `AttributeFor` does.
 */
export const resolveAttribute = (
  condition: Pick<Condition, "scope" | "name">,
  attributes: SpanAttributes,
): WireKeyValue | undefined => {
  if (condition.scope === "span") return findAttribute(attributes.span, condition.name)
  if (condition.scope === "resource") return findAttribute(attributes.resource, condition.name)
  return (
    findAttribute(attributes.span, condition.name) ??
    findAttribute(attributes.resource, condition.name)
  )
}

/** Whether one span satisfies every condition of `query`. */
export const matchesSpan = (query: Query, attributes: SpanAttributes): boolean =>
  !query.never &&
  query.conditions.every((condition) =>
    comparableValues(resolveAttribute(condition, attributes)?.value).some((value) =>
      equal(value, condition.value),
    ),
  )
