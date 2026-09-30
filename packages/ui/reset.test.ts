import { expect, test } from "bun:test"
import { CSS_RESET, scopeReset } from "./src/reset.js"

test("reset.css is the stylesheet form of CSS_RESET", async () => {
  const css = await Bun.file(new URL("./src/reset.css", import.meta.url)).text()
  expect(css).toBe(`${CSS_RESET}\n`)
})

test("scopeReset stays inside the root and does not raise specificity", () => {
  const css = scopeReset(".cove-app")
  expect(css).toContain(":where(.cove-app) button")
  expect(css).toContain(":where(.cove-app),\n:where(.cove-app) *")
  expect(css).toContain(":where(.cove-app):focus-visible")
  expect(css).toContain("@media (prefers-reduced-motion: reduce)")
  expect(css).toContain("min-height: 100%")
  expect(css).not.toContain("100dvh")
  expect(css).not.toContain("100svh")
  expect(css).not.toContain("100vh")
  expect(CSS_RESET).toContain("min-height: 100svh")
  expect(CSS_RESET).not.toContain("100dvh")
  expect(css).not.toMatch(/(^|\n)button \{/)
  expect(css).not.toMatch(/(^|\n)html \{/)
})

test("scopeReset rewrites a shadow host the same way", () => {
  const css = scopeReset(":host")
  expect(css).toContain(":where(:host) input")
  expect(css).not.toContain(":where(:where(")
})
