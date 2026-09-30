import { describe, expect, test } from "bun:test"
import { scopeEmbeddedCss } from "./pasteHtml.js"

describe("scopeEmbeddedCss", () => {
  test("rewrites document selectors onto .page and keeps at-rules intact", () => {
    const css = scopeEmbeddedCss(`
*{box-sizing:border-box}body{margin:0;min-height:100svh}h1{font-size:24px}
@media(prefers-color-scheme:dark){:root{--bg:#111}}
@keyframes arrive{from{opacity:0;transform:translateY(5px)}to{opacity:1}}
/* Fill the viewport, then grow with the content so the background covers the scroll. */
html { height: 100%; }
html, body { height: 100%; }
:root[data-theme="dark"]{color:red}
.app{min-height:100vh}
.pane{height:100%}
.body{color:blue}
`)
    expect(css).toContain(":host{display:block;box-sizing:border-box}")
    expect(css).toContain(".page{box-sizing:border-box;min-height:100%}")
    expect(css).toContain(".page{margin:0;min-height:100%}")
    expect(css).toContain("h1{font-size:24px}")
    expect(css).toContain("@media(prefers-color-scheme:dark){.page{--bg:#111}}")
    expect(css).toContain(
      "@keyframes arrive{from{opacity:0;transform:translateY(5px)}to{opacity:1}}",
    )
    expect(css).toContain(".page {min-height: 100%; }")
    expect(css).toContain(".page, .page {min-height: 100%; }")
    expect(css).toContain('.page[data-theme="dark"]{color:red}')
    expect(css).toContain(".app{min-height:100%}")
    expect(css).toContain(".pane{height:100%}")
    expect(css.match(/(?<![\w-])height:\s*100%/g)).toEqual(["height:100%"])
    expect(css).toContain(".body{color:blue}")
    expect(css).not.toContain(":root")
    expect(css).not.toContain("100vh")
    expect(css).not.toContain("100svh")
  })
})
