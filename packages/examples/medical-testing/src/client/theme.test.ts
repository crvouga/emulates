import { describe, expect, test } from "bun:test"
import { STYLES } from "./theme.js"

/**
 * Document resets the example is mounted under (the docs site and the UI
 * reset both set `button { color: inherit }`). A parent+element rule in the
 * example sheet must not outrank a class that paints the label.
 */
const HOST_RESET = `
button, input, select, textarea { font: inherit; color: inherit; }
button { appearance: none; background: none; border: 0; padding: 0; color: inherit; }
p { margin: 0; color: inherit; }
`

type Node = {
  tag: string
  classes: string[]
  parent?: Node
}

const specificity = (selector: string): number => {
  const plain = selector.replace(/:where\((?:[^()]|\([^()]*\))*\)/g, "")
  const ids = plain.match(/#[\w-]+/g)?.length ?? 0
  const classes = plain.match(/\.[\w-]+|\[[^\]]+\]|:(?!where\b)[\w-]+(?:\([^)]*\))?/g)?.length ?? 0
  const stripped = plain
    .replace(/#[\w-]+/g, " ")
    .replace(/\.[\w-]+/g, " ")
    .replace(/\[[^\]]+\]/g, " ")
    .replace(/:(?!where\b)[\w-]+(?:\([^)]*\))?/g, " ")
    .replace(/[+>~*,]/g, " ")
  const elements = stripped.match(/[a-zA-Z][\w-]*/g)?.length ?? 0
  return ids * 100 + classes * 10 + elements
}

/** Resting-state match for the selectors this sheet actually uses. */
const matches = (selector: string, node: Node): boolean => {
  const resting = selector.replace(/:not\([^)]*\)/g, "")
  if (/:(?:hover|active|focus|disabled)\b/.test(resting)) return false
  const parts = selector
    .trim()
    .split(/\s+/)
    .filter((part) => part !== "")
  let current: Node | undefined = node
  for (let i = parts.length - 1; i >= 0; i--) {
    const part = parts[i]
    if (!part || !current) return false
    if (!matchesCompound(part, current)) return false
    if (i > 0) current = current.parent
  }
  return true
}

const simples = (compound: string): string[] => {
  const out: string[] = []
  let i = 0
  while (i < compound.length) {
    if (compound.startsWith(":where(", i) || compound.startsWith(":not(", i)) {
      const open = compound.indexOf("(", i)
      let depth = 0
      let j = open
      for (; j < compound.length; j++) {
        if (compound[j] === "(") depth += 1
        else if (compound[j] === ")") {
          depth -= 1
          if (depth === 0) {
            j += 1
            break
          }
        }
      }
      out.push(compound.slice(i, j))
      i = j
      continue
    }
    const start = i
    i += 1
    while (i < compound.length && !".:#[".includes(compound[i] ?? "")) i += 1
    out.push(compound.slice(start, i))
  }
  return out.filter((part) => part !== "")
}

const matchesCompound = (compound: string, node: Node): boolean =>
  simples(compound).every((simple) => {
    if (simple.startsWith(":not(")) return true
    if (simple.startsWith(":where(")) {
      const inner = simple.slice(":where(".length, -1)
      return matchesCompound(inner, node)
    }
    if (simple.startsWith(".")) return node.classes.includes(simple.slice(1))
    return simple === node.tag
  })

const declarations = (
  css: string,
): { selector: string; prop: string; value: string; index: number }[] => {
  const rules: { selector: string; prop: string; value: string; index: number }[] = []
  const body = css.replace(/\/\*[\s\S]*?\*\//g, "")
  let index = 0
  for (const match of body.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const prelude = match[1] ?? ""
    const block = match[2] ?? ""
    if (prelude.includes("@")) continue
    for (const selector of prelude.split(",")) {
      for (const decl of block.split(";")) {
        const split = decl.split(":")
        const prop = split[0]?.trim()
        const value = split.slice(1).join(":").trim()
        if (!prop || !value) continue
        rules.push({ selector: selector.trim(), prop, value, index })
        index += 1
      }
    }
  }
  return rules
}

const computed = (node: Node, prop: string): string | undefined => {
  let winner: { value: string; spec: number; index: number } | undefined
  for (const rule of declarations(`${HOST_RESET}\n${STYLES}`)) {
    if (rule.prop !== prop || !matches(rule.selector, node)) continue
    const spec = specificity(rule.selector)
    if (!winner || spec > winner.spec || (spec === winner.spec && rule.index > winner.index)) {
      winner = { value: rule.value, spec, index: rule.index }
    }
  }
  return winner?.value
}

const app = (child: Node): Node => ({ ...child, parent: { tag: "div", classes: ["cove-app"] } })

describe("example button contrast", () => {
  test("filled buttons keep the on-brand label over the button color reset", () => {
    const primary = app({ tag: "button", classes: ["cove-btn", "cove-btn-primary"] })
    const accent = app({ tag: "button", classes: ["cove-btn", "cove-btn-accent"] })
    expect(computed(primary, "background")).toBe("var(--cove-primary)")
    expect(computed(primary, "color")).toBe("var(--cove-on-brand)")
    expect(computed(accent, "background")).toBe("var(--cove-accent)")
    expect(computed(accent, "color")).toBe("var(--cove-on-brand)")
  })

  test("ghost, oauth, and close buttons keep the color their class sets", () => {
    expect(computed(app({ tag: "button", classes: ["cove-btn", "cove-btn-ghost"] }), "color")).toBe(
      "var(--cove-primary)",
    )
    expect(computed(app({ tag: "button", classes: ["cove-oauth-btn"] }), "color")).toBe(
      "var(--cove-ink)",
    )
    expect(computed(app({ tag: "button", classes: ["cove-modal-close"] }), "color")).toBe(
      "var(--cove-muted)",
    )
  })

  test("a selected test's add pill is on-brand on the dark fill", () => {
    const card = app({ tag: "button", classes: ["cove-test-card", "is-selected"] })
    const pill = { tag: "span", classes: ["cove-test-add"], parent: card }
    expect(computed(pill, "background")).toBe("var(--cove-primary)")
    expect(computed(pill, "color")).toBe("var(--cove-on-brand)")
  })

  test("a muted paragraph is not forced back to full ink", () => {
    expect(computed(app({ tag: "p", classes: ["cove-muted"] }), "color")).toBe("var(--cove-muted)")
    expect(computed(app({ tag: "p", classes: ["cove-alert", "cove-alert-error"] }), "color")).toBe(
      "var(--cove-danger)",
    )
  })
})
