/**
 * Embedded browsers (IDE panes, in-app webviews) refuse nested frames.
 * Example apps fetch a provider's real HTML and paste it into the page.
 * `:root` / `html` / `body` are rewritten onto an inner `.page` so the
 * document's own sheet does not restyle the host page.
 *
 * Width breakpoints are rewritten onto that `.page` as container queries.
 * A viewport query would still see the browser window, so a desktop-width
 * window would keep a two-column layout inside a narrow popup.
 */

export type HostedSubmit = (action: string, method: string, body: string) => void

export type PastedLocation = {
  href: string
  origin: string
  pathname: string
  search: string
  hash: string
}

export type PasteFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

export type PasteOptions = {
  /** Fetch implementation inline scripts see. Defaults to the page's fetch. */
  fetch?: PasteFetch
  /** `location` inline scripts read. Defaults to the host page. */
  location?: PastedLocation
  /** Intercept form submits and same-document link clicks. */
  onSubmit?: HostedSubmit
  /** Run inline scripts. Default true. */
  scripts?: boolean
}

type TrackedListener = {
  type: string
  listener: EventListener
  options?: boolean | AddEventListenerOptions
}

/** Scope a full document's CSS so it applies inside the pasted shadow tree. */
export const scopeEmbeddedCss = (css: string): string => {
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
      out += `${rewriteWidthMedia(css.slice(cursor, brace))}{`
      cursor = brace + 1
      continue
    }
    const close = prelude.lastIndexOf("}")
    const head = close === -1 ? "" : prelude.slice(0, close + 1)
    const selector = close === -1 ? prelude : prelude.slice(close + 1)
    const selectorTrimmed = selector.trimStart()
    if (
      close !== -1 &&
      (selectorTrimmed.startsWith("@keyframes") || selectorTrimmed.startsWith("@font-face"))
    ) {
      const end = skipBlock(css, brace)
      out += head + css.slice(cursor + close + 1, end)
      cursor = end
      continue
    }
    if (close !== -1 && selectorTrimmed.startsWith("@")) {
      out += `${head}${rewriteWidthMedia(selector)}{`
      cursor = brace + 1
      continue
    }
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
  // `.page` is the query container. Its inline size is the host's width, not
  // the min-content of a wide layout, so the rewritten queries stack inside a popup.
  return `:host{display:block;box-sizing:border-box;width:100%;max-width:100%;min-width:0}.page{box-sizing:border-box;width:100%;max-width:100%;min-width:0;min-height:100%;container-type:inline-size}${sized}`
}

/**
 * `@media (min-width: …)` measures the browser. Inside a pasted popup the
 * browser is often wide while the host is not, so a width-only query becomes
 * a container query. Preference queries stay media queries.
 */
const rewriteWidthMedia = (prelude: string): string => {
  const at = prelude.search(/@media\b/i)
  if (at === -1) return prelude
  const condition = prelude.slice(at + "@media".length)
  if (!isWidthOnlyMedia(condition)) return prelude
  // Container queries have no media type. Drop a leading `screen and`.
  const query = condition.replace(/^\s*(?:only\s+)?(?:all|screen|print|speech)\s+and\s+/i, " ")
  return `${prelude.slice(0, at)}@container${query}`
}

const isWidthOnlyMedia = (condition: string): boolean => {
  const body = condition.replace(/\/\*[\s\S]*?\*\//g, " ")
  if (/\bnot\b/i.test(body)) return false
  if (!/(?:min-|max-)?width/i.test(body)) return false
  const stripped = body
    .replace(/\bonly\b/gi, " ")
    .replace(/\b(?:all|screen|print|speech)\b/gi, " ")
    .replace(/\b(?:and|or)\b/gi, " ")
    .replace(/\(\s*(?:min-|max-)?width\s*:\s*[^)]+\)/gi, " ")
    .replace(/\(\s*[^)]*?\bwidth\b[^)]*\)/gi, " ")
  return !/[a-z]/i.test(stripped)
}

/**
 * Paste `html` into `host`. Returns a cleanup that drops the tree and any
 * window listeners the pasted scripts attached.
 */
export const pasteHtml = (
  host: HTMLElement,
  html: string,
  options: PasteOptions = {},
): (() => void) => {
  const owner = host.ownerDocument
  const parsed = new DOMParser().parseFromString(html, "text/html")
  const sources = [...parsed.querySelectorAll("script")].map((script) => script.textContent ?? "")
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

  const detach = options.onSubmit ? attachFormInterceptor(shadow, options.onSubmit) : () => {}
  // Hosted pages call form.submit() to auto-post (Apple's form_post callback).
  // That navigates the surrounding document. Fire a cancelable submit instead,
  // which the interceptor above keeps in-process.
  for (const form of shadow.querySelectorAll("form")) {
    Object.defineProperty(form, "submit", {
      configurable: true,
      value: () => form.requestSubmit(),
    })
  }

  const windowListeners: TrackedListener[] = []
  const shadowListeners: TrackedListener[] = []
  if (options.scripts !== false) {
    const scopedWindow = new Proxy(window, {
      get(target, prop) {
        if (prop === "addEventListener") {
          return (
            type: string,
            listener: EventListener,
            opts?: boolean | AddEventListenerOptions,
          ) => {
            windowListeners.push({
              type,
              listener,
              ...(opts !== undefined ? { options: opts } : {}),
            })
            window.addEventListener(type, listener, opts)
          }
        }
        if (prop === "removeEventListener") {
          return (
            type: string,
            listener: EventListener,
            opts?: boolean | AddEventListenerOptions,
          ) => {
            window.removeEventListener(type, listener, opts)
          }
        }
        // Native Window getters require their real Window as the receiver.
        const value: unknown = Reflect.get(target, prop, target)
        return typeof value === "function" ? value.bind(target) : value
      },
    })
    const documentProxy = scopedDocument(owner, shadow, page, shadowListeners)
    const fetchImpl: PasteFetch = options.fetch ?? ((input, init) => fetch(input, init))
    const locationStub = options.location ?? window.location
    const historyStub = { replaceState() {} }
    for (const source of sources) {
      if (source.trim() === "") continue
      const run = new Function(
        "document",
        "fetch",
        "location",
        "history",
        "sessionStorage",
        "localStorage",
        "window",
        source,
      ) as (
        document: Document,
        fetch: PasteFetch,
        location: PastedLocation | Location,
        history: { replaceState: () => void },
        sessionStorage: Storage,
        localStorage: Storage,
        window: Window,
      ) => void
      try {
        run(
          documentProxy,
          fetchImpl,
          locationStub,
          historyStub,
          sessionStorage,
          localStorage,
          scopedWindow,
        )
      } catch (error) {
        console.error(error instanceof Error ? (error.stack ?? error.message) : String(error))
      }
    }
  }

  return () => {
    // Framework clients unmount their roots before their document is detached.
    shadow.dispatchEvent(new Event("mockingbird:unmount"))
    detach()
    for (const item of windowListeners)
      window.removeEventListener(item.type, item.listener, item.options)
    for (const item of shadowListeners)
      shadow.removeEventListener(item.type, item.listener, item.options)
    shadow.replaceChildren()
  }
}

const attachFormInterceptor = (
  root: ParentNode & EventTarget,
  onSubmit: HostedSubmit,
): (() => void) => {
  const submit = (event: Event) => {
    const formEvent = event as SubmitEvent
    formEvent.preventDefault()
    const form = formEvent.target as HTMLFormElement
    const submitter = formEvent.submitter as HTMLButtonElement | null
    const formData = new FormData(form)
    if (submitter?.name) formData.set(submitter.name, submitter.value)
    const params = new URLSearchParams()
    for (const [key, value] of formData.entries()) {
      if (typeof value === "string") params.append(key, value)
    }
    // `form.action` / `form.method` are unreliable: these hosted pages carry a
    // hidden `<input name="action">`, and a same-named control shadows the
    // form's IDL properties. The content attributes are immune.
    onSubmit(
      form.getAttribute("action") ?? "",
      form.getAttribute("method") ?? "GET",
      params.toString(),
    )
  }

  const click = (event: Event) => {
    const anchor = (event.target as Element | null)?.closest?.("a")
    if (!(anchor instanceof HTMLAnchorElement) || anchor.getAttribute("href") === null) return
    event.preventDefault()
    onSubmit(anchor.href, "GET", "")
  }

  root.addEventListener("submit", submit, { capture: true })
  root.addEventListener("click", click, { capture: true })
  return () => {
    root.removeEventListener("submit", submit, { capture: true })
    root.removeEventListener("click", click, { capture: true })
  }
}

const scopedDocument = (
  owner: Document,
  shadow: ShadowRoot,
  page: HTMLElement,
  listeners: TrackedListener[],
): Document =>
  new Proxy(owner, {
    get(target, prop) {
      if (prop === "getElementById") return (id: string) => shadow.getElementById(id)
      if (prop === "querySelector") return (selector: string) => shadow.querySelector(selector)
      if (prop === "querySelectorAll")
        return (selector: string) => shadow.querySelectorAll(selector)
      if (prop === "createElement")
        return (tag: string, options?: ElementCreationOptions) =>
          options === undefined ? owner.createElement(tag) : owner.createElement(tag, options)
      if (prop === "createElementNS")
        return (namespace: string, tag: string) => owner.createElementNS(namespace, tag)
      if (prop === "documentElement" || prop === "body" || prop === "head") return page
      if (prop === "addEventListener")
        return (
          type: string,
          listener: EventListener,
          opts?: boolean | AddEventListenerOptions,
        ) => {
          listeners.push({ type, listener, ...(opts !== undefined ? { options: opts } : {}) })
          shadow.addEventListener(type, listener, opts)
        }
      if (prop === "removeEventListener")
        return (type: string, listener: EventListener, opts?: boolean | AddEventListenerOptions) =>
          shadow.removeEventListener(type, listener, opts)
      const value: unknown = Reflect.get(target, prop, target)
      return typeof value === "function" ? value.bind(target) : value
    },
  }) as Document

/** Comments are not selectors. A comma inside one must not split the list. */
const stripComments = (value: string): string => value.replace(/\/\*[\s\S]*?\*\//g, "")

/** True when every selector is the pasted document box (rewritten html/body/:root). */
const isDocumentBox = (selector: string): boolean =>
  stripComments(selector)
    .split(",")
    .every((part) => part.trim() === ".page")

/**
 * A pasted document has no canvas. `height: 100%` on the document box paints
 * only the first screen, and the host page shows through the rest of the scroll.
 * `min-height` still fills the frame and grows with the content.
 */
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
