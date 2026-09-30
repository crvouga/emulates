/**
 * Embedded browsers refuse nested frames, so the example pastes each
 * fetched document into its own shadow tree. `:root` / `html` / `body`
 * land on an inner `.page` and do not restyle the shell around it.
 * Returns that `.page` element.
 */
export function pasteDocument(host: HTMLElement, html: string): HTMLElement {
  const owner = host.ownerDocument
  const parsed = new DOMParser().parseFromString(html, "text/html")
  for (const script of parsed.querySelectorAll("script")) script.remove()
  const css = [...parsed.querySelectorAll("style")]
    .map((style) => style.textContent ?? "")
    .join("\n")
  for (const style of parsed.querySelectorAll("style")) style.remove()

  const shadow = host.shadowRoot ?? host.attachShadow({ mode: "open" })
  shadow.replaceChildren()
  const style = owner.createElement("style")
  style.textContent = scopeEmbeddedCss(css)
  const page = owner.createElement("div")
  page.className = "page"
  shadow.append(style, page)
  for (const node of [...parsed.body.childNodes]) page.append(owner.adoptNode(node))
  return page
}

const scopeEmbeddedCss = (css: string): string => {
  let out = ""
  let cursor = 0
  while (cursor < css.length) {
    const brace = css.indexOf("{", cursor)
    if (brace === -1) {
      out += css.slice(cursor)
      break
    }
    const prelude = css.slice(cursor, brace)
    const trimmed = prelude.trimStart()
    if (trimmed.startsWith("@keyframes") || trimmed.startsWith("@font-face")) {
      const end = skipBlock(css, brace)
      out += css.slice(cursor, end)
      cursor = end
      continue
    }
    if (trimmed.startsWith("@")) {
      out += css.slice(cursor, brace + 1)
      cursor = brace + 1
      continue
    }
    const close = prelude.lastIndexOf("}")
    const head = close === -1 ? "" : prelude.slice(0, close + 1)
    const selector = close === -1 ? prelude : prelude.slice(close + 1)
    const rewritten = rewriteSelectorList(selector)
    out += `${head}${rewritten}{`
    if (isDocumentBox(rewritten)) {
      const end = skipBlock(css, brace)
      out += `${loosenDocumentHeight(css.slice(brace + 1, end - 1))}}`
      cursor = end
      continue
    }
    cursor = brace + 1
  }
  const sized = out.replaceAll("100svh", "100%").replaceAll("100vh", "100%")
  return `:host{display:block;box-sizing:border-box}.page{box-sizing:border-box;min-height:100%}${sized}`
}

/** Comments are not selectors. A comma inside one must not split the list. */
const stripComments = (value: string): string => value.replace(/\/\*[\s\S]*?\*\//g, "")

const isDocumentBox = (selector: string): boolean =>
  stripComments(selector)
    .split(",")
    .every((part) => part.trim() === ".page")

const loosenDocumentHeight = (declarations: string): string =>
  declarations.replace(/(^|;)\s*height(\s*:\s*100%)/g, "$1min-height$2")

const rewriteSelectorList = (selector: string): string => {
  if (selector.trim() === "") return selector
  return selector
    .split(",")
    .map((part) => part.replace(/:root\b|(?<![.\w-])(?:html|body)\b/g, ".page"))
    .join(",")
}

const skipBlock = (css: string, openBrace: number): number => {
  let depth = 0
  for (let index = openBrace; index < css.length; index++) {
    const char = css[index]
    if (char === "{") depth++
    else if (char === "}") {
      depth--
      if (depth === 0) return index + 1
    }
  }
  return css.length
}
