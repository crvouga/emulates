import { describe, expect, test } from "bun:test"
import {
  matchesSpan,
  parseTraceQL,
  TraceQLError,
  type WireAnyValue,
  type WireKeyValue,
} from "./src/index.js"

const failure = (query: string): { kind: string; message: string } => {
  try {
    parseTraceQL(query)
  } catch (error) {
    if (error instanceof TraceQLError) return { kind: error.kind, message: error.message }
    throw error
  }
  throw new Error(`expected ${JSON.stringify(query)} to be refused`)
}

const kv = (key: string, value: WireAnyValue): WireKeyValue => ({ key, value })
const matches = (query: string, span: WireKeyValue[], resource: WireKeyValue[] = []) =>
  matchesSpan(parseTraceQL(query), { span, resource })

describe("TraceQL subset", () => {
  /**
   * Inputs and expected errors copied from Tempo's own parser tests
   * (`pkg/traceql/parse_test.go` at v3.1.0), where `newParseError(msg, line, col)` prints as
   * `parse error at line L, col C: msg`. Line 0 is Tempo's: its lexer advances past the token
   * it scanned, which voids the scanner's line.
   */
  test.each([
    ["", "parse error : syntax error: unexpected $end"],
    ["wharblgarbl", "parse error at line 1, col 1: syntax error: unexpected IDENTIFIER"],
    ["{ + }", "parse error at line 1, col 3: syntax error: unexpected +"],
    ["{ .a | .b }", "parse error at line 1, col 6: syntax error: unexpected |"],
    ["{ .foo .bar }", "parse error at line 1, col 8: syntax error: unexpected ."],
    [
      "{ . foo }",
      "parse error at line 1, col 3: syntax error: unexpected END_ATTRIBUTE, expecting IDENTIFIER",
    ],
    [
      '{ . "foo" }',
      "parse error at line 1, col 3: syntax error: unexpected END_ATTRIBUTE, expecting IDENTIFIER",
    ],
    [
      "{ parent. }",
      "parse error at line 0, col 3: syntax error: unexpected END_ATTRIBUTE, expecting IDENTIFIER or resource. or span.",
    ],
    ['{ ."foo }', 'parse error at line 0, col 3: unexpected EOF, expecting "'],
    [
      "{ true } &&",
      "parse error at line 1, col 12: syntax error: unexpected $end, expecting { or (",
    ],
  ])("Tempo's parser error for %j", (query, message) => {
    expect(failure(query)).toEqual({ kind: "syntax", message })
  })

  test("truncated and misspelt filters are syntax errors positioned like Tempo's", () => {
    expect(failure("{").message).toBe("parse error at line 1, col 2: syntax error: unexpected $end")
    expect(failure('{ .user.id = "u" ').message).toBe(
      "parse error at line 1, col 18: syntax error: unexpected $end",
    )
    expect(failure('{ .a = "b" && }').message).toBe(
      "parse error at line 1, col 15: syntax error: unexpected }",
    )
    expect(failure("{ .a = }").message).toBe(
      "parse error at line 1, col 8: syntax error: unexpected }",
    )
    expect(failure("{ .a = foo }").message).toBe(
      "parse error at line 1, col 8: syntax error: unexpected IDENTIFIER",
    )
    expect(failure('{ .a = "b" "c" }').message).toBe(
      "parse error at line 1, col 12: syntax error: unexpected STRING",
    )
    expect(failure('{ .a = "b').message).toBe(
      "parse error at line 1, col 8: literal not terminated",
    )
    expect(failure('{ .a = "b" } }').kind).toBe("syntax")
    expect(failure('{ .a = "b" } = 1').message).toBe(
      "parse error at line 1, col 14: syntax error: unexpected =",
    )
    // Comments are skipped, as Go's scanner does for Tempo.
    expect(parseTraceQL('{ .a = "b" } // by user').conditions).toHaveLength(1)
    expect(parseTraceQL('{ /* user */ .a = "b" }').conditions).toHaveLength(1)
  })

  test("valid TraceQL outside the subset is refused as not yet supported, never matched loosely", () => {
    for (const query of [
      '{ .a =~ "b.*" }',
      '{ .a != "b" }',
      "{ .a > 1 }",
      '{ .a = "b" || .c = "d" }',
      "{ .a }",
      "{ .a = .b }",
      "{ .a = nil }",
      "{ .a = 5s }",
      "{ !(.a = 1) }",
      '{ name = "x" }',
      "{ status = error }",
      "{ kind = server }",
      "{ duration > 1s }",
      '{ trace:id = "abc" }',
      '{ event.name = "x" }',
      '{ parent.span.a = "x" }',
      "{ 2 = .b }",
      '( { .a = "b" } )',
      '{ .a = "b" } | count() > 1',
      '{ .a = "b" } && { .c = "d" }',
      '{ .a = "b" } >> { .c = "d" }',
      '{ .a = "b" } | select(.c)',
      '{ .a = "b" } with (most_recent=true)',
      "count() > 1",
    ]) {
      const refused = failure(query)
      expect([query, refused.kind]).toEqual([query, "unsupported"])
      expect(refused.message).toEndWith("not yet supported (Mockingbird emulates a TraceQL subset)")
    }
    expect(failure('{ .a =~ "b" }').message).toStartWith("binary operation (=~) ")
    expect(failure("{ status = error }").message).toStartWith("intrinsic (status) ")
  })

  test("the subset: empty and literal filters, scoped and quoted attributes, typed equality", () => {
    expect(parseTraceQL("{}")).toEqual({ conditions: [], never: false })
    expect(parseTraceQL("{ true }")).toEqual({ conditions: [], never: false })
    expect(parseTraceQL("{ false }").never).toBe(true)
    expect(parseTraceQL('{.a="b"&&span.c=1&&resource.d=true}').conditions).toEqual([
      { scope: "any", name: "a", value: { type: "string", value: "b" } },
      { scope: "span", name: "c", value: { type: "int", value: 1n } },
      { scope: "resource", name: "d", value: { type: "bool", value: true } },
    ])
    expect(parseTraceQL('{ span."user id".x = `raw "text"` }').conditions).toEqual([
      { scope: "span", name: "user id.x", value: { type: "string", value: 'raw "text"' } },
    ])
    expect(parseTraceQL('{ .a = "tab\\t\\"q\\" \\u00e9" }').conditions[0]?.value).toEqual({
      type: "string",
      value: 'tab\t"q" é',
    })
    expect(parseTraceQL("{ .a = -1.5 }").conditions[0]?.value).toEqual({
      type: "float",
      value: -1.5,
    })

    const span = [
      kv("user.id", { stringValue: "user-1" }),
      kv("attempt", { intValue: "2" }),
      kv("ratio", { doubleValue: 2 }),
      kv("ok", { boolValue: false }),
      kv("tags", { arrayValue: { values: [{ stringValue: "a" }, { stringValue: "b" }] } }),
    ]
    const resource = [
      kv("service.name", { stringValue: "api" }),
      kv("user.id", { stringValue: "resource-user" }),
    ]
    expect(matches("{ }", [])).toBe(true)
    expect(matches("{ false }", span, resource)).toBe(false)
    expect(matches('{ .user.id = "user-1" }', span, resource)).toBe(true)
    expect(matches('{ .user.id = "user" }', span, resource)).toBe(false)
    // Numbers compare across int and float, never against a string.
    expect(matches("{ .attempt = 2 }", span)).toBe(true)
    expect(matches("{ .attempt = 2.0 }", span)).toBe(true)
    expect(matches("{ .ratio = 2 }", span)).toBe(true)
    expect(matches('{ .attempt = "2" }', span)).toBe(false)
    expect(matches("{ .ok = false }", span)).toBe(true)
    expect(matches("{ .ok = true }", span)).toBe(false)
    expect(matches('{ .tags = "b" }', span)).toBe(true)
    expect(matches('{ .tags = "c" }', span)).toBe(false)
    // Unscoped: the span's attribute wins over the resource's; scoped reads only its scope.
    expect(matches('{ .user.id = "resource-user" }', span, resource)).toBe(false)
    expect(matches('{ resource.user.id = "resource-user" }', span, resource)).toBe(true)
    expect(matches('{ .service.name = "api" }', span, resource)).toBe(true)
    expect(matches('{ span.service.name = "api" }', span, resource)).toBe(false)
    expect(
      matches('{ .user.id = "user-1" && resource.service.name = "api" }', span, resource),
    ).toBe(true)
    expect(matches('{ .user.id = "user-1" && .attempt = 3 }', span, resource)).toBe(false)
    expect(matches('{ .missing = "x" }', span, resource)).toBe(false)
  })
})
