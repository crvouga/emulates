import type { ClockState } from "./clock.js"
import type { FaultPresetList } from "./faults.js"
import type { StateCollectionView, StateField, StateFieldKind, StateView } from "./state-view.js"

/**
 * Admin page behavior. `adminClientSource` inlines these functions into the document.
 * They run in the browser, so they cannot close over module bindings — configuration
 * arrives as the argument to `bootAdmin`.
 */
export type AdminBootConfig = {
  standardRoutes: readonly string[]
  adminPrefix: string
  adminKeyHeader: string
  brandsUrl: string
  service: string
}

export type AdminBrandEnv = {
  document: Document
  $: (id: string) => HTMLElement | null
  params: URLSearchParams
  location: { href: string; origin: string }
  fetch: typeof fetch
  brandsUrl: string
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * Highlight already-serialized JSON without trusting any of its contents as markup.
 * Kept dependency-free because this function is inlined into every mock's admin page.
 */
export function highlightJsonText(text: string): string {
  const escapeToken = (value: string): string =>
    value.replace(/[&<>"']/g, (char) => {
      switch (char) {
        case "&":
          return "&amp;"
        case "<":
          return "&lt;"
        case ">":
          return "&gt;"
        case '"':
          return "&quot;"
        default:
          return "&#39;"
      }
    })
  const token =
    /("(?:\\u[\da-fA-F]{4}|\\[^u]|[^\\"])*"\s*:|"(?:\\u[\da-fA-F]{4}|\\[^u]|[^\\"])*"|\b(?:true|false)\b|\bnull\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g
  let cursor = 0
  let html = ""
  for (const match of text.matchAll(token)) {
    const index = match.index ?? 0
    const value = match[0]
    html += escapeToken(text.slice(cursor, index))
    const kind = value.startsWith('"')
      ? value.trimEnd().endsWith(":")
        ? "key"
        : "string"
      : value === "true" || value === "false"
        ? "boolean"
        : value === "null"
          ? "null"
          : "number"
    html += `<span class="json-${kind}">${escapeToken(value)}</span>`
    cursor = index + value.length
  }
  return html + escapeToken(text.slice(cursor))
}

/** Paint the header chip from a brands catalog. Hostile URLs and markup are dropped. */
export function mountAdminBrand(
  doc: Document,
  host: HTMLElement,
  service: string,
  catalog: unknown,
): void {
  const clip = (value: unknown, max: number): string | null => {
    if (typeof value !== "string") return null
    const trimmed = value.trim()
    if (trimmed === "") return null
    return trimmed.length > max ? trimmed.slice(0, max) : trimmed
  }
  const httpUrl = (value: unknown): string | null => {
    if (typeof value !== "string" || value.length > 2000) return null
    try {
      const url = new URL(value)
      if (url.protocol !== "https:" && url.protocol !== "http:") return null
      return url.href
    } catch {
      return null
    }
  }
  const hexColor = (value: unknown): string | null => {
    if (typeof value !== "string") return null
    const raw = value.trim()
    return /^#[0-9a-fA-F]{3,8}$/.test(raw) ? raw : null
  }
  const hostname = (value: string): string => {
    try {
      return new URL(value).hostname.replace(/^www\./, "")
    } catch {
      return value
    }
  }
  host.replaceChildren()
  host.hidden = true
  if (!isRecord(catalog) || !Object.hasOwn(catalog, service)) return
  const row = catalog[service]
  if (!isRecord(row)) return
  const vendor = clip(row.vendor, 80)
  const website = httpUrl(row.website)
  const guide = httpUrl(row.guide)
  const docs = httpUrl(row.docs)
  const logo = httpUrl(row.logo)
  const color = hexColor(row.color)
  const description = clip(row.description, 280)
  if (vendor === null || (website === null && guide === null && docs === null)) return
  const add = <T extends Node>(node: T): T => {
    host.append(node)
    return node
  }
  if (logo !== null) {
    const img = doc.createElement("img")
    img.alt = ""
    img.src = logo
    img.width = 16
    img.height = 16
    img.decoding = "async"
    img.referrerPolicy = "no-referrer"
    if (color !== null) img.style.borderColor = color
    add(img)
  }
  const name = doc.createElement("span")
  name.className = "vendor-name"
  name.textContent = vendor
  if (description !== null) name.title = description
  add(name)
  const sep = (): HTMLSpanElement => {
    const node = doc.createElement("span")
    node.className = "vendor-sep"
    node.setAttribute("aria-hidden", "true")
    node.textContent = "·"
    return node
  }
  const link = (href: string, label: string, title: string): HTMLAnchorElement => {
    const node = doc.createElement("a")
    node.className = "vendor-link"
    node.href = href
    node.target = "_blank"
    node.rel = "noopener noreferrer"
    node.referrerPolicy = "no-referrer"
    node.textContent = label
    node.title = title
    return node
  }
  if (website !== null) {
    add(sep())
    add(link(website, hostname(website), `${vendor} website`))
  }
  if (guide !== null) {
    add(sep())
    add(link(guide, "Docs", `Docs for ${vendor}`))
  }
  if (docs !== null) {
    add(sep())
    add(link(docs, "API", `${vendor} API reference`))
  }
  host.removeAttribute("hidden")
  host.hidden = false
}

/** Fetch the brands catalog and paint `#vendor`. `?brands=` may name a local copy. */
export function startAdminBrand(env: AdminBrandEnv): void {
  const requested = env.params.get("brands")
  let brandsUrl = env.brandsUrl
  if (requested) {
    try {
      const url = new URL(requested, env.location.href)
      const local =
        url.hostname === "localhost" ||
        url.hostname === "127.0.0.1" ||
        url.hostname === "::1" ||
        url.hostname === "[::1]" ||
        url.origin === env.location.origin
      if ((url.protocol === "https:" || url.protocol === "http:") && local) brandsUrl = url.href
    } catch {
      brandsUrl = env.brandsUrl
    }
  }
  const vendorHost = env.$("vendor")
  const brandRoot = env.document.querySelector("[data-mockingbird-admin]")
  const brandService = brandRoot?.getAttribute("data-service") || ""
  if (vendorHost === null) return
  env
    .fetch(brandsUrl, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(5000),
    })
    .then(async (response) => {
      if (!response.ok) return null
      const catalog: unknown = await response.json()
      return catalog
    })
    .then((catalog) => {
      mountAdminBrand(env.document, vendorHost, brandService, catalog)
    })
    .catch(() => {})
}

/**
 * Names from `GET /__admin/faults/presets`.
 * The payload's `presets` field is a list. A record keyed by preset name is rejected
 * here, which is also a type error at the handler that builds a {@link FaultPresetList}.
 */
export function faultPresetList(value: unknown): FaultPresetList {
  if (!isRecord(value)) throw new Error("Fault presets response was not an object")
  if (!Object.hasOwn(value, "presets") || value.presets === undefined || value.presets === null) {
    return { presets: [] }
  }
  if (!Array.isArray(value.presets)) throw new Error("Fault presets response was not a list")
  return {
    presets: value.presets.flatMap((item) => {
      if (!isRecord(item) || typeof item.name !== "string") return []
      return [{ name: item.name }]
    }),
  }
}

/**
 * Table list and query box for a `sql` admin extension.
 * Inlined into the page; do not close over module bindings. Use `root` for every
 * lookup so two documents can boot in one page.
 */
export function mountSqlExplorer(
  root: HTMLElement,
  api: {
    get: (path: string) => Promise<unknown>
    send: (method: string, path: string, body?: unknown) => Promise<unknown>
    namespace: () => string
  },
): void {
  const cell = (value: unknown): string => {
    if (value === null || value === undefined) return ""
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      return String(value)
    }
    return JSON.stringify(value) ?? ""
  }
  root.replaceChildren()
  const layout = document.createElement("div")
  layout.className = "sql-layout"
  const tables = document.createElement("div")
  tables.className = "sql-tables"
  const stack = document.createElement("div")
  stack.className = "stack"
  const banner = document.createElement("p")
  banner.className = "banner"
  const grid = document.createElement("div")
  const input = document.createElement("textarea")
  input.className = "sql-input"
  input.spellcheck = false
  input.placeholder = "SELECT * FROM ..."
  const actions = document.createElement("div")
  actions.className = "row-actions"
  const run = document.createElement("button")
  run.type = "button"
  run.textContent = "Run"
  actions.append(run)
  const result = document.createElement("pre")
  stack.append(banner, grid, input, actions, result)
  layout.append(tables, stack)
  root.append(layout)

  const showError = (error: unknown): void => {
    banner.textContent = error instanceof Error ? error.message : String(error)
    banner.classList.add("show")
  }
  const clearError = (): void => {
    banner.textContent = ""
    banner.classList.remove("show")
  }
  const renderGrid = (
    columns: readonly string[],
    rows: readonly Record<string, unknown>[],
  ): void => {
    grid.replaceChildren()
    if (columns.length === 0) {
      const empty = document.createElement("p")
      empty.className = "empty"
      empty.textContent = "No rows."
      grid.append(empty)
      return
    }
    const table = document.createElement("table")
    const head = document.createElement("thead")
    const headRow = document.createElement("tr")
    for (const column of columns) {
      const th = document.createElement("th")
      th.textContent = column
      headRow.append(th)
    }
    head.append(headRow)
    const body = document.createElement("tbody")
    for (const row of rows) {
      const tr = document.createElement("tr")
      for (const column of columns) {
        const td = document.createElement("td")
        td.dataset.label = column
        td.textContent = cell(row[column])
        tr.append(td)
      }
      body.append(tr)
    }
    table.append(head, body)
    grid.append(table)
  }
  const rowsOf = (value: unknown): Record<string, unknown>[] => {
    if (!isRecord(value) || !Array.isArray(value.rows)) return []
    return value.rows.flatMap((row) => (isRecord(row) ? [row] : []))
  }
  const columnsOf = (value: unknown, rows: readonly Record<string, unknown>[]): string[] => {
    if (isRecord(value) && Array.isArray(value.columns)) {
      const named = value.columns.flatMap((column) => (typeof column === "string" ? [column] : []))
      if (named.length > 0) return named
    }
    const first = rows[0]
    return first === undefined ? [] : Object.keys(first)
  }
  let selected = ""
  const loadPage = async (schema: string, name: string): Promise<void> => {
    selected = `${schema}.${name}`
    const page = await api.get(
      `/sql/tables/${encodeURIComponent(schema)}/${encodeURIComponent(name)}?limit=50`,
    )
    const rows = rowsOf(page)
    renderGrid(columnsOf(page, rows), rows)
    const total = isRecord(page) && typeof page.total === "number" ? page.total : rows.length
    result.textContent = `${selected} · ${total} rows`
    for (const button of tables.querySelectorAll("button")) {
      if (!(button instanceof HTMLButtonElement)) continue
      button.setAttribute(
        "aria-current",
        button.dataset.schema === schema && button.dataset.table === name ? "true" : "false",
      )
    }
  }
  const loadTables = async (): Promise<void> => {
    const payload = await api.get("/sql/tables")
    const listed = isRecord(payload) && Array.isArray(payload.tables) ? payload.tables : []
    tables.replaceChildren()
    if (listed.length === 0) {
      const empty = document.createElement("p")
      empty.className = "empty"
      empty.textContent = "No tables."
      tables.append(empty)
      return
    }
    for (const item of listed) {
      if (!isRecord(item) || typeof item.schema !== "string" || typeof item.name !== "string")
        continue
      const button = document.createElement("button")
      button.type = "button"
      button.dataset.schema = item.schema
      button.dataset.table = item.name
      button.textContent = `${item.schema}.${item.name}`
      tables.append(button)
    }
  }
  tables.addEventListener("click", (event) => {
    const target = event.target
    if (!(target instanceof Element)) return
    const button = target.closest("button")
    if (!(button instanceof HTMLButtonElement)) return
    const schema = button.dataset.schema
    const name = button.dataset.table
    if (schema === undefined || name === undefined) return
    clearError()
    loadPage(schema, name).catch(showError)
  })
  run.addEventListener("click", () => {
    const sql = input.value.trim()
    if (sql === "") {
      showError(new Error("Enter a statement"))
      return
    }
    clearError()
    api
      .send("POST", "/sql/query", { sql })
      .then((payload) => {
        const rows = rowsOf(payload)
        renderGrid(columnsOf(payload, rows), rows)
        const count =
          isRecord(payload) && typeof payload.rowCount === "number" ? payload.rowCount : rows.length
        const truncated = isRecord(payload) && payload.truncated === true ? " (truncated)" : ""
        result.textContent = `${count} rows${truncated}`
      })
      .catch(showError)
  })
  const namespace = document.getElementById("namespace")
  if (namespace) {
    namespace.addEventListener("change", () => {
      clearError()
      loadTables().catch(showError)
    })
  }
  loadTables().catch(showError)
}

/** Boot the admin document. Inlined into the page; do not close over module bindings. */
export function bootAdmin(config: AdminBootConfig): void {
  const fieldKinds = ["string", "number", "boolean", "null", "object", "array", "unknown"] as const
  const sources = ["declared", "inferred", "mixed"] as const
  const isFieldKind = (value: unknown): value is StateFieldKind =>
    typeof value === "string" && fieldKinds.some((kind) => kind === value)
  const isSource = (value: unknown): value is StateCollectionView["source"] =>
    typeof value === "string" && sources.some((source) => source === value)
  const readJson = (text: string): unknown => {
    const value: unknown = JSON.parse(text)
    return value
  }
  const esc = (value: unknown): string =>
    String(value ?? "").replace(/[&<>"']/g, (char) => {
      switch (char) {
        case "&":
          return "&amp;"
        case "<":
          return "&lt;"
        case ">":
          return "&gt;"
        case '"':
          return "&quot;"
        default:
          return "&#39;"
      }
    })
  const el = <T extends HTMLElement>(id: string, kind: new () => T): T => {
    const node = document.getElementById(id)
    if (!(node instanceof kind)) throw new Error(`admin shell is missing #${id}`)
    return node
  }
  const errorMessage = (data: unknown, fallback: string): string => {
    if (!isRecord(data)) return fallback
    const error = data.error
    if (!isRecord(error) || typeof error.message !== "string" || error.message === "") {
      return fallback
    }
    return error.message
  }
  const requireList = (value: unknown, label: string): unknown[] => {
    if (value === undefined || value === null) return []
    if (!Array.isArray(value)) throw new Error(`${label} was not a list`)
    return value
  }

  const state: {
    namespace: string
    key: string
    view: string
    collection: string
    shape: StateView | null
    route: string | null
    editing: string | null
  } = {
    namespace: "default",
    key: sessionStorage.getItem("mockingbird-admin-key") || "",
    view: ["overview", "state", "clock", "faults", "journal", "routes"].includes(
      location.hash.slice(1),
    )
      ? location.hash.slice(1)
      : "overview",
    collection: "",
    shape: null,
    route: null,
    editing: null,
  }
  const standard = new Set(config.standardRoutes)
  const banner = el("banner", HTMLElement)
  const bannerMessage = el("banner-message", HTMLElement)
  const keyInput = el("admin-key", HTMLInputElement)
  keyInput.value = state.key
  const params = new URLSearchParams(location.search)
  const queryKey = params.get("key")
  if (queryKey) {
    state.key = queryKey
    keyInput.value = state.key
    sessionStorage.setItem("mockingbird-admin-key", state.key)
    params.delete("key")
    const next = params.toString()
    history.replaceState(null, "", location.pathname + (next ? `?${next}` : "") + location.hash)
  }
  const queryNamespace = params.get("namespace")
  if (queryNamespace) state.namespace = queryNamespace

  const showError = (error: unknown): void => {
    bannerMessage.textContent = error instanceof Error ? error.message : String(error)
    banner.classList.add("show")
    banner.scrollIntoView({ behavior: "smooth", block: "nearest" })
  }
  const clearError = (): void => {
    banner.classList.remove("show")
    bannerMessage.textContent = ""
  }
  el("banner-dismiss", HTMLButtonElement).addEventListener("click", clearError)

  const api = async (method: string, path: string, body?: unknown): Promise<unknown> => {
    const headers: Record<string, string> = { accept: "application/json" }
    if (state.key !== "") headers[config.adminKeyHeader] = state.key
    if (state.namespace !== "") headers["x-mockingbird-namespace"] = state.namespace
    if (body !== undefined) headers["content-type"] = "application/json"
    const init: RequestInit = { method, headers }
    if (body !== undefined) init.body = JSON.stringify(body)
    const response = await fetch(config.adminPrefix + path, init)
    const text = await response.text()
    let data: unknown = null
    if (text !== "") {
      try {
        data = readJson(text)
      } catch {
        data = { raw: text }
      }
    }
    if (response.status === 401) {
      keyInput.focus()
      throw new Error(errorMessage(data, "Admin key required"))
    }
    if (!response.ok) {
      throw new Error(errorMessage(data, `${response.status} ${method} ${path}`))
    }
    return data
  }
  const originGet = async (path: string): Promise<unknown> => {
    const response = await fetch(path, { headers: { accept: "application/json" } })
    if (!response.ok) throw new Error(`${response.status} ${path}`)
    const value: unknown = await response.json()
    return value
  }
  type PanelApi = {
    get: (path: string) => Promise<unknown>
    send: (method: string, path: string, body?: unknown) => Promise<unknown>
    namespace: () => string
  }
  const panelApi: PanelApi = {
    get: (path) => api("GET", path),
    send: (method, path, body) => api(method, path, body),
    namespace: () => state.namespace,
  }
  const isPanelScript = (value: unknown): value is (root: HTMLElement, api: PanelApi) => void =>
    typeof value === "function"

  const themeButton = el("theme", HTMLButtonElement)
  const setTheme = (theme: string | null): void => {
    if (theme) document.documentElement.dataset.theme = theme
    else delete document.documentElement.dataset.theme
    const dark = theme ? theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches
    themeButton.innerHTML = dark
      ? '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><circle cx="10" cy="10" r="3.2" stroke="currentColor" stroke-width="1.5"/><path d="M10 2v1.5M10 16.5V18M18 10h-1.5M3.5 10H2M15.7 4.3l-1 1M5.3 14.7l-1 1M15.7 15.7l-1-1M5.3 5.3l-1-1" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>'
      : '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M16.8 12.2A7 7 0 0 1 7.8 3.2a7 7 0 1 0 9 9Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>'
    const label = dark ? "Use light theme" : "Use dark theme"
    themeButton.setAttribute("aria-label", label)
    themeButton.title = label
  }
  const storedTheme = localStorage.getItem("mockingbird-admin-theme")
  setTheme(storedTheme === "dark" || storedTheme === "light" ? storedTheme : null)
  themeButton.addEventListener("click", () => {
    const current = document.documentElement.dataset.theme
    const dark = current ? current === "dark" : matchMedia("(prefers-color-scheme: dark)").matches
    const next = dark ? "light" : "dark"
    localStorage.setItem("mockingbird-admin-theme", next)
    setTheme(next)
  })

  const show = (view: string): void => {
    state.view = view
    for (const button of document.querySelectorAll("#nav button")) {
      if (!(button instanceof HTMLButtonElement)) continue
      button.setAttribute("aria-current", button.dataset.view === view ? "true" : "false")
    }
    for (const section of document.querySelectorAll("main .view")) {
      if (!(section instanceof HTMLElement)) continue
      section.hidden = section.id !== `view-${view}`
    }
    history.replaceState(
      null,
      "",
      `${location.pathname}${location.search}#${encodeURIComponent(view)}`,
    )
  }
  el("nav", HTMLElement).addEventListener("click", (event) => {
    const target = event.target
    if (!(target instanceof Element)) return
    const button = target.closest("button[data-view]")
    if (!(button instanceof HTMLButtonElement)) return
    const view = button.dataset.view
    if (view === undefined) return
    show(view)
    refresh().catch(showError)
  })

  const cards = (items: readonly { k: string; v: string }[]): string =>
    `<div class="grid">${items
      .map(
        (item) =>
          `<article class="card stat-card"><div class="k">${item.k}</div><div class="v">${item.v}</div></article>`,
      )
      .join("")}</div>`
  const table = <Row extends object>(
    columns: readonly { label: string; cell: (row: Row) => string }[],
    rows: readonly Row[],
  ): string => {
    if (rows.length === 0) return '<p class="empty">Nothing here yet.</p>'
    const head = `<tr>${columns.map((column) => `<th>${column.label}</th>`).join("")}</tr>`
    const body = rows
      .map((row) => {
        const cells = columns
          .map((column) => `<td data-label="${column.label}">${column.cell(row)}</td>`)
          .join("")
        const attrs = "attrs" in row && typeof row.attrs === "string" ? row.attrs : ""
        return `<tr${attrs}>${cells}</tr>`
      })
      .join("")
    return `<div class="table-shell"><table><thead>${head}</thead><tbody>${body}</tbody></table></div>`
  }
  const preview = (value: unknown): string => {
    const text = JSON.stringify(value) ?? "null"
    const clipped = text.length > 180 ? `${text.slice(0, 180)}…` : text
    return `<code class="json-inline">${highlightJsonText(clipped)}</code>`
  }
  const when = (epoch: number): string => {
    const date = new Date(epoch)
    return Number.isNaN(date.getTime()) ? String(epoch) : date.toISOString()
  }
  const clockCard = (epoch: number): string => {
    const date = new Date(epoch)
    if (Number.isNaN(date.getTime())) return esc(String(epoch))
    const iso = date.toISOString()
    return `${esc(iso.slice(0, 10))}<span class="clock-time">${esc(iso.slice(11, 19))} UTC</span>`
  }
  const decodeClock = (value: unknown): ClockState => {
    if (
      !isRecord(value) ||
      typeof value.now !== "number" ||
      typeof value.offsetMs !== "number" ||
      typeof value.frozen !== "boolean"
    ) {
      throw new Error("Clock response was not a clock")
    }
    return { now: value.now, offsetMs: value.offsetMs, frozen: value.frozen }
  }
  const decodeField = (value: unknown): StateField | undefined => {
    if (!isRecord(value) || typeof value.name !== "string" || !isFieldKind(value.kind)) {
      return undefined
    }
    const field: StateField = {
      name: value.name,
      kind: value.kind,
      optional: value.optional === true,
    }
    if (typeof value.description === "string") field.description = value.description
    if (Array.isArray(value.fields)) {
      field.fields = value.fields.flatMap((item) => {
        const child = decodeField(item)
        return child === undefined ? [] : [child]
      })
    }
    return field
  }
  const decodeCollection = (value: unknown): StateCollectionView | undefined => {
    if (!isRecord(value) || typeof value.name !== "string") return undefined
    const fields = Array.isArray(value.fields)
      ? value.fields.flatMap((item) => {
          const field = decodeField(item)
          return field === undefined ? [] : [field]
        })
      : []
    const collection: StateCollectionView = {
      name: value.name,
      label: typeof value.label === "string" ? value.label : value.name,
      count: typeof value.count === "number" ? value.count : 0,
      source: isSource(value.source) ? value.source : "inferred",
      fields,
    }
    if (typeof value.description === "string") collection.description = value.description
    return collection
  }
  const decodeState = (value: unknown): StateView => {
    if (!isRecord(value) || !Array.isArray(value.collections)) {
      throw new Error("State response has no collection list")
    }
    return {
      namespace: typeof value.namespace === "string" ? value.namespace : state.namespace,
      storageNamespace: typeof value.storageNamespace === "string" ? value.storageNamespace : "",
      collections: value.collections.flatMap((item) => {
        const collection = decodeCollection(item)
        return collection === undefined ? [] : [collection]
      }),
    }
  }
  type RecordRow = { id: string; seq: number; value: unknown; attrs: string }
  const decodeRecords = (value: unknown): RecordRow[] =>
    requireList(isRecord(value) ? value.records : undefined, "Records").flatMap((item) => {
      if (!isRecord(item) || typeof item.id !== "string") return []
      return [
        {
          id: item.id,
          seq: typeof item.seq === "number" ? item.seq : 0,
          value: item.value,
          attrs: ` class="clickable" data-id="${esc(item.id)}"`,
        },
      ]
    })
  type JournalRow = {
    at: string
    method: string
    path: string
    status: string
    durationMs: string
    operationId: string
  }
  const textOf = (value: unknown): string =>
    typeof value === "string" || typeof value === "number" || typeof value === "boolean"
      ? String(value)
      : ""
  const decodeJournal = (value: unknown): JournalRow[] =>
    requireList(isRecord(value) ? value.requests : undefined, "Journal").flatMap((item) => {
      if (!isRecord(item)) return []
      return [
        {
          at: textOf(item.at),
          method: textOf(item.method),
          path: textOf(item.path),
          status: textOf(item.status),
          durationMs: textOf(item.durationMs),
          operationId: textOf(item.operationId),
        },
      ]
    })
  type FaultRow = {
    id: string
    method: string | undefined
    pathPrefix: string | undefined
    operationId: string | undefined
    status: number | undefined
    effect: string | undefined
    drop: boolean | undefined
    latencyMs: number | undefined
  }
  const decodeFaults = (value: unknown): FaultRow[] =>
    requireList(isRecord(value) ? value.faults : undefined, "Faults").flatMap((item) => {
      if (!isRecord(item)) return []
      return [
        {
          id: textOf(item.id),
          method: typeof item.method === "string" ? item.method : undefined,
          pathPrefix: typeof item.pathPrefix === "string" ? item.pathPrefix : undefined,
          operationId: typeof item.operationId === "string" ? item.operationId : undefined,
          status: typeof item.status === "number" ? item.status : undefined,
          effect: typeof item.effect === "string" ? item.effect : undefined,
          drop: typeof item.drop === "boolean" ? item.drop : undefined,
          latencyMs: typeof item.latencyMs === "number" ? item.latencyMs : undefined,
        },
      ]
    })

  const loadNamespaces = async (): Promise<void> => {
    const data = await api("GET", "/namespaces")
    const select = el("namespace", HTMLSelectElement)
    const listed = requireList(isRecord(data) ? data.namespaces : undefined, "Namespaces")
    const fallback =
      isRecord(data) && typeof data.default === "string" && data.default !== ""
        ? data.default
        : "default"
    const names = (listed.length > 0 ? listed.map((name) => String(name)) : [fallback]).slice()
    if (!names.includes(state.namespace)) names.unshift(state.namespace)
    select.innerHTML = names
      .map((name) => `<option value="${esc(name)}">${esc(name)}</option>`)
      .join("")
    select.value = state.namespace
  }

  const renderOverview = async (): Promise<void> => {
    const [health, shape, clock, journal] = await Promise.all([
      originGet(`${config.adminPrefix}/health`),
      api("GET", "/state"),
      api("GET", "/clock"),
      api("GET", "/requests?limit=8"),
    ])
    if (!isRecord(health)) throw new Error("Health response was not an object")
    const decoded = decodeState(shape)
    state.shape = decoded
    const time = decodeClock(clock)
    el("overview-cards", HTMLElement).innerHTML = cards([
      {
        k: "Service",
        v: esc(
          typeof health.service === "string" && health.service !== ""
            ? health.service
            : config.service,
        ),
      },
      {
        k: "Status",
        v: `<span class="badge ok">${esc(
          typeof health.status === "string" && health.status !== "" ? health.status : "ok",
        )}</span>`,
      },
      { k: "Namespace", v: esc(state.namespace) },
      { k: "Collections", v: String(decoded.collections.length) },
      {
        k: "Records",
        v: String(decoded.collections.reduce((sum, item) => sum + item.count, 0)),
      },
      { k: "Clock", v: clockCard(time.now) },
    ])
    el("overview-requests", HTMLElement).innerHTML = table(
      [
        { label: "Method", cell: (row: JournalRow) => esc(row.method) },
        { label: "Path", cell: (row: JournalRow) => esc(row.path) },
        {
          label: "Status",
          cell: (row: JournalRow) =>
            `<span class="status-${row.status.charAt(0)}">${esc(row.status)}</span>`,
        },
        { label: "Operation", cell: (row: JournalRow) => esc(row.operationId) },
      ],
      decodeJournal(journal),
    )
  }

  const schemaChips = (collection: StateCollectionView): string => {
    if (collection.fields.length === 0) {
      return '<p class="empty">No fields yet. Add a record or declare the collection on the service.</p>'
    }
    return `<div class="chips">${collection.fields
      .map(
        (field) =>
          `<span class="chip">${esc(field.name)} <i>${esc(field.kind)}${field.optional ? "?" : ""}</i></span>`,
      )
      .join("")}</div>`
  }

  const renderState = async (): Promise<void> => {
    const shape = decodeState(await api("GET", "/state"))
    state.shape = shape
    const host = el("collections", HTMLElement)
    if (shape.collections.length === 0) {
      host.innerHTML = '<p class="empty">This namespace has no collections yet.</p>'
      el("schema", HTMLElement).innerHTML = ""
      el("records", HTMLElement).innerHTML = ""
      return
    }
    if (!shape.collections.some((item) => item.name === state.collection)) {
      const first = shape.collections[0]
      if (first === undefined) return
      state.collection = first.name
    }
    host.innerHTML = shape.collections
      .map(
        (item) =>
          `<button type="button" class="collection" data-collection="${esc(item.name)}" aria-current="${
            item.name === state.collection ? "true" : "false"
          }"><strong>${esc(item.label)}</strong><small>${esc(item.count)} · ${esc(item.source)}</small></button>`,
      )
      .join("")
    const selected = shape.collections.find((item) => item.name === state.collection)
    if (selected === undefined) return
    const description = selected.description
      ? `<p class="lede">${esc(selected.description)}</p>`
      : ""
    el("schema", HTMLElement).innerHTML =
      `<h3>${esc(selected.label)}</h3>${description}${schemaChips(selected)}`
    const page = await api("GET", `/state/${encodeURIComponent(state.collection)}?limit=50`)
    el("records", HTMLElement).innerHTML = table(
      [
        { label: "Id", cell: (row: RecordRow) => `<code>${esc(row.id)}</code>` },
        { label: "Seq", cell: (row: RecordRow) => esc(row.seq) },
        { label: "Value", cell: (row: RecordRow) => preview(row.value) },
      ],
      decodeRecords(page),
    )
  }

  const renderClock = async (): Promise<void> => {
    const clock = decodeClock(await api("GET", "/clock"))
    el("clock-readout", HTMLElement).innerHTML =
      `<div class="k">Now</div><div class="v">${esc(when(clock.now))}</div><p>${esc(clock.now)} ms · offset ${esc(
        clock.offsetMs,
      )} ms ${
        clock.frozen
          ? "<span class='badge warn'>frozen</span>"
          : "<span class='badge ok'>live</span>"
      }</p>`
    const freeze = el("freeze", HTMLButtonElement)
    freeze.textContent = clock.frozen ? "Unfreeze" : "Freeze"
    freeze.dataset.frozen = clock.frozen ? "1" : "0"
  }

  const renderFaults = async (): Promise<void> => {
    const [faults, presets] = await Promise.all([
      api("GET", "/faults"),
      api("GET", "/faults/presets").catch((): unknown => ({ presets: [] })),
    ])
    const select = el("fault-preset", HTMLSelectElement)
    const current = select.value
    const list = faultPresetList(presets).presets
    select.innerHTML = `<option value="">Custom rule</option>${list
      .map((preset) => `<option value="${esc(preset.name)}">${esc(preset.name)}</option>`)
      .join("")}`
    select.value = current
    el("fault-list", HTMLElement).innerHTML = table(
      [
        { label: "Id", cell: (row: FaultRow) => esc(row.id) },
        {
          label: "Match",
          cell: (row: FaultRow) =>
            esc(
              [row.method, row.pathPrefix, row.operationId]
                .filter((part): part is string => Boolean(part))
                .join(" ") || "all",
            ),
        },
        {
          label: "Effect",
          cell: (row: FaultRow) =>
            esc(row.status ?? row.effect ?? (row.drop ? "drop" : row.latencyMs || "")),
        },
      ],
      decodeFaults(faults),
    )
  }

  const renderJournal = async (): Promise<void> => {
    const journal = await api("GET", "/requests?limit=100")
    el("journal", HTMLElement).innerHTML = table(
      [
        { label: "When", cell: (row: JournalRow) => esc(when(Number(row.at))) },
        {
          label: "Method",
          cell: (row: JournalRow) => `<span class="method">${esc(row.method)}</span>`,
        },
        { label: "Path", cell: (row: JournalRow) => esc(row.path) },
        {
          label: "Status",
          cell: (row: JournalRow) =>
            `<span class="badge ${row.status.startsWith("2") ? "ok" : row.status.startsWith("4") || row.status.startsWith("5") ? "warn" : ""}">${esc(row.status)}</span>`,
        },
        { label: "ms", cell: (row: JournalRow) => esc(row.durationMs) },
      ],
      decodeJournal(journal),
    )
  }

  const renderRoutes = async (): Promise<void> => {
    const data = await api("GET", "/")
    if (!isRecord(data)) throw new Error("Route list was not an object")
    const routes = requireList(data.routes, "Routes").map((route) => String(route))
    if (routes.length === 0) {
      el("route-list", HTMLElement).innerHTML =
        '<p class="empty">No admin routes are available.</p>'
      return
    }
    el("route-list", HTMLElement).innerHTML = routes
      .map((route) => {
        const extra = standard.has(route) ? "" : " <span class='badge'>extension</span>"
        const parts = route.split(" ")
        const method = parts[0] ?? ""
        const path = parts.slice(1).join(" ")
        return `<div class="route"><span class="method">${esc(method)}</span><span>${esc(path)}${extra}</span><button class="btn" type="button" data-route="${esc(route)}">Use</button></div>`
      })
      .join("")
  }

  const renderers: Record<string, () => Promise<void>> = {
    overview: renderOverview,
    state: renderState,
    clock: renderClock,
    faults: renderFaults,
    journal: renderJournal,
    routes: renderRoutes,
  }
  let refreshToken = 0
  async function refresh(): Promise<void> {
    const token = ++refreshToken
    clearError()
    const main = el("views", HTMLElement)
    const sync = el("sync-status", HTMLElement)
    main.setAttribute("aria-busy", "true")
    sync.classList.add("busy")
    sync.textContent = "Updating"
    const render = renderers[state.view]
    try {
      if (render) await render()
      if (token === refreshToken) sync.textContent = "Up to date"
    } finally {
      if (token === refreshToken) {
        main.removeAttribute("aria-busy")
        sync.classList.remove("busy")
      }
    }
  }

  const delay = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      window.setTimeout(resolve, ms)
    })
  /**
   * Keep the button pressed through the request, then show `done` before the
   * label returns. An action that leaves the screen unchanged still reads as finished.
   */
  const confirmAction = async (
    button: HTMLButtonElement,
    pending: string,
    done: string,
    work: () => Promise<unknown>,
    confirmLabel?: string,
  ): Promise<void> => {
    if (button.dataset.pending === "1") return
    const label = button.textContent ?? ""
    if (confirmLabel !== undefined && button.dataset.confirming !== "1") {
      button.dataset.confirming = "1"
      button.classList.add("confirming")
      button.textContent = confirmLabel
      window.setTimeout(() => {
        if (button.dataset.confirming !== "1") return
        button.textContent = label
        button.classList.remove("confirming")
        delete button.dataset.confirming
      }, 3000)
      return
    }
    button.classList.remove("confirming")
    delete button.dataset.confirming
    const width = button.offsetWidth
    button.dataset.pending = "1"
    button.classList.add("pressed")
    button.setAttribute("aria-busy", "true")
    button.style.minWidth = `${width}px`
    button.textContent = pending
    try {
      await work()
      button.textContent = done
      await delay(1000)
    } catch (error) {
      showError(error)
    } finally {
      button.textContent = label
      button.style.minWidth = ""
      button.classList.remove("pressed")
      button.removeAttribute("aria-busy")
      delete button.dataset.pending
    }
  }

  const wireJsonEditor = (
    textareaId: string,
    highlightId: string,
    statusId: string,
    shellId: string,
    allowEmpty: boolean,
  ): (() => void) => {
    const textarea = el(textareaId, HTMLTextAreaElement)
    const highlight = el(highlightId, HTMLElement)
    const status = el(statusId, HTMLElement)
    const shell = el(shellId, HTMLElement)
    const sync = (): void => {
      const text = textarea.value
      highlight.innerHTML = `${highlightJsonText(text)}\n`
      let valid = true
      let message = "Valid JSON"
      if (allowEmpty && text.trim() === "") message = "No body"
      else {
        try {
          readJson(text)
        } catch {
          valid = false
          message = "Invalid JSON"
        }
      }
      shell.classList.toggle("invalid", !valid)
      status.classList.toggle("invalid", !valid)
      status.textContent = message
      textarea.setAttribute("aria-invalid", valid ? "false" : "true")
    }
    const syncScroll = (): void => {
      const preview = highlight.parentElement
      if (!(preview instanceof HTMLElement)) return
      preview.scrollTop = textarea.scrollTop
      preview.scrollLeft = textarea.scrollLeft
    }
    textarea.addEventListener("input", sync)
    textarea.addEventListener("scroll", syncScroll)
    sync()
    return sync
  }
  const syncRouteEditor = wireJsonEditor(
    "route-body",
    "route-highlight",
    "route-json-status",
    "route-editor",
    true,
  )
  const syncRecordEditor = wireJsonEditor(
    "editor-value",
    "editor-highlight",
    "editor-json-status",
    "record-editor",
    false,
  )
  for (const button of document.querySelectorAll("[data-format]")) {
    if (!(button instanceof HTMLButtonElement)) continue
    button.addEventListener("click", () => {
      const target = button.dataset.format
      if (target === undefined) return
      const textarea = document.getElementById(target)
      if (!(textarea instanceof HTMLTextAreaElement) || textarea.value.trim() === "") return
      try {
        textarea.value = JSON.stringify(readJson(textarea.value), null, 2) ?? ""
        textarea.dispatchEvent(new Event("input"))
        textarea.focus()
      } catch {
        showError(new Error("Fix the JSON before formatting it"))
      }
    })
  }
  document.addEventListener("click", (event) => {
    const target = event.target
    if (!(target instanceof Element)) return
    const button = target.closest("button")
    if (!(button instanceof HTMLButtonElement) || button.dataset.pending === "1") return
    button.classList.add("pressed")
    const token = String(Date.now())
    button.dataset.press = token
    window.setTimeout(() => {
      if (button.dataset.press !== token || button.dataset.pending === "1") return
      button.classList.remove("pressed")
      delete button.dataset.press
    }, 450)
  })

  el("namespace", HTMLSelectElement).addEventListener("change", () => {
    state.namespace = el("namespace", HTMLSelectElement).value
    refresh().catch(showError)
  })
  keyInput.addEventListener("change", () => {
    state.key = keyInput.value.trim()
    sessionStorage.setItem("mockingbird-admin-key", state.key)
    refresh().catch(showError)
  })
  el("refresh", HTMLButtonElement).addEventListener("click", () => {
    confirmAction(el("refresh", HTMLButtonElement), "Refreshing...", "Updated", () =>
      refresh(),
    ).catch(showError)
  })

  el("collections", HTMLElement).addEventListener("click", (event) => {
    const target = event.target
    if (!(target instanceof Element)) return
    const button = target.closest("[data-collection]")
    if (!(button instanceof HTMLElement)) return
    const collection = button.dataset.collection
    if (collection === undefined) return
    state.collection = collection
    renderState().catch(showError)
  })
  el("records", HTMLElement).addEventListener("click", (event) => {
    const target = event.target
    if (!(target instanceof Element)) return
    const row = target.closest("[data-id]")
    if (!(row instanceof HTMLElement)) return
    const id = row.dataset.id
    if (id === undefined) return
    openEditor(id).catch(showError)
  })

  const editor = el("editor", HTMLDialogElement)
  const editorId = el("editor-id", HTMLInputElement)
  const editorValue = el("editor-value", HTMLTextAreaElement)
  const editorDelete = el("editor-delete", HTMLButtonElement)
  async function openEditor(id: string | null): Promise<void> {
    state.editing = id
    el("editor-title", HTMLElement).textContent = id ? "Edit record" : "New record"
    editorId.value = id ?? ""
    editorId.readOnly = id !== null
    editorDelete.hidden = id === null
    if (id) {
      const record = await api(
        "GET",
        `/state/${encodeURIComponent(state.collection)}/${encodeURIComponent(id)}`,
      )
      if (!isRecord(record)) throw new Error("Record response was not an object")
      editorValue.value = JSON.stringify(record.value, null, 2) ?? ""
    } else {
      editorValue.value = "{\n  \n}"
    }
    syncRecordEditor()
    editor.showModal()
  }
  el("new-record", HTMLButtonElement).addEventListener("click", () => {
    openEditor(null).catch(showError)
  })
  el("editor-form", HTMLFormElement).addEventListener("submit", (event) => {
    const submitter = event.submitter
    if (!(submitter instanceof HTMLButtonElement) || submitter.value !== "save") return
    event.preventDefault()
    let value: unknown
    try {
      value = readJson(editorValue.value)
    } catch {
      showError(new Error("Value is not JSON"))
      return
    }
    const id = editorId.value.trim()
    const path = `/state/${encodeURIComponent(state.collection)}`
    const request = state.editing
      ? api("PUT", `${path}/${encodeURIComponent(id)}`, { value })
      : api("POST", path, { id: id || undefined, value })
    request
      .then(() => {
        editor.close()
        return renderState()
      })
      .catch(showError)
  })
  editorDelete.addEventListener("click", () => {
    const id = state.editing
    if (!id) return
    confirmAction(
      editorDelete,
      "Deleting...",
      "Deleted",
      () =>
        api(
          "DELETE",
          `/state/${encodeURIComponent(state.collection)}/${encodeURIComponent(id)}`,
        ).then(() => {
          editor.close()
          return renderState()
        }),
      "Confirm delete",
    ).catch(showError)
  })

  for (const button of document.querySelectorAll("[data-advance]")) {
    if (!(button instanceof HTMLButtonElement)) continue
    button.addEventListener("click", () => {
      const raw = button.dataset.advance
      if (raw === undefined) return
      api("POST", "/clock", { advance: Number(raw) })
        .then(() => renderClock())
        .catch(showError)
    })
  }
  el("freeze", HTMLButtonElement).addEventListener("click", () => {
    const frozen = el("freeze", HTMLButtonElement).dataset.frozen === "1"
    api("POST", "/clock", { freeze: !frozen })
      .then(() => renderClock())
      .catch(showError)
  })
  el("clock-reset", HTMLButtonElement).addEventListener("click", () => {
    api("POST", "/clock", { reset: true })
      .then(() => renderClock())
      .catch(showError)
  })
  el("clock-set", HTMLFormElement).addEventListener("submit", (event) => {
    event.preventDefault()
    const raw = el("clock-instant", HTMLInputElement).value.trim()
    const set = /^-?\d+$/.test(raw) ? Number(raw) : raw
    api("POST", "/clock", { set })
      .then(() => renderClock())
      .catch(showError)
  })

  el("fault-form", HTMLFormElement).addEventListener("submit", (event) => {
    event.preventDefault()
    const preset = el("fault-preset", HTMLSelectElement).value
    if (preset !== "") {
      api("POST", "/faults", { preset })
        .then(() => renderFaults())
        .catch(showError)
      return
    }
    const status = Number(el("fault-status", HTMLInputElement).value)
    if (!Number.isFinite(status)) {
      showError(new Error("Status must be a number, or choose a preset"))
      return
    }
    const path = el("fault-path", HTMLInputElement).value
    const method = el("fault-method", HTMLInputElement).value
    api("POST", "/faults", {
      status,
      ...(path !== "" ? { pathPrefix: path } : {}),
      ...(method !== "" ? { method } : {}),
    })
      .then(() => renderFaults())
      .catch(showError)
  })
  el("fault-clear", HTMLButtonElement).addEventListener("click", () => {
    confirmAction(
      el("fault-clear", HTMLButtonElement),
      "Clearing...",
      "Cleared",
      () => api("DELETE", "/faults").then(() => renderFaults()),
      "Confirm clear",
    ).catch(showError)
  })
  el("journal-clear", HTMLButtonElement).addEventListener("click", () => {
    confirmAction(
      el("journal-clear", HTMLButtonElement),
      "Clearing...",
      "Cleared",
      () => api("DELETE", "/requests").then(() => renderJournal()),
      "Confirm clear",
    ).catch(showError)
  })

  el("route-list", HTMLElement).addEventListener("click", (event) => {
    const target = event.target
    if (!(target instanceof Element)) return
    const button = target.closest("[data-route]")
    if (!(button instanceof HTMLElement)) return
    const route = button.dataset.route
    if (route === undefined) return
    state.route = route
    el("route-title", HTMLElement).textContent = route
    el("route-send", HTMLButtonElement).disabled = false
    const method = route.split(" ")[0] ?? ""
    const routeBody = el("route-body", HTMLTextAreaElement)
    routeBody.disabled = method === "GET" || method === "DELETE"
    el("route-editor", HTMLElement).hidden = routeBody.disabled
    el("route-json-status", HTMLElement).parentElement?.toggleAttribute(
      "hidden",
      routeBody.disabled,
    )
    syncRouteEditor()
  })
  el("route-form", HTMLFormElement).addEventListener("submit", (event) => {
    event.preventDefault()
    const send = async (): Promise<void> => {
      if (state.route === null) throw new Error("Choose a route first")
      const parts = state.route.split(" ")
      const method = parts[0]
      const path = parts.slice(1).join(" ")
      if (method === undefined) throw new Error("Choose a route first")
      const concrete = path.replace(
        /:([A-Za-z0-9_]+)/g,
        (_match, key: string) => prompt(`Value for ${key}`) || "",
      )
      let body: unknown
      const routeBody = el("route-body", HTMLTextAreaElement)
      if (method !== "GET" && method !== "DELETE" && routeBody.value.trim() !== "") {
        try {
          body = readJson(routeBody.value)
        } catch {
          throw new Error("Body is not JSON")
        }
      }
      const data = await api(method, concrete, body)
      const text = JSON.stringify(data, null, 2) ?? "null"
      el("route-result", HTMLElement).innerHTML = `<code>${highlightJsonText(text)}</code>`
    }
    send().catch(showError)
  })

  type Panel = { id: string; title: string; description: string; html: string; script?: string }
  const decodePanel = (value: unknown): Panel | undefined => {
    if (!isRecord(value) || typeof value.id !== "string" || typeof value.title !== "string") {
      return undefined
    }
    const panel: Panel = {
      id: value.id,
      title: value.title,
      description: typeof value.description === "string" ? value.description : "",
      html: typeof value.html === "string" ? value.html : "",
    }
    if (typeof value.script === "string") panel.script = value.script
    return panel
  }
  type Extension =
    | (Panel & { kind: "panel" })
    | { kind: "sql"; id: string; title: string; description: string }
  const decodeExtension = (value: unknown): Extension | undefined => {
    if (!isRecord(value)) return undefined
    if (value.kind === "sql") {
      return {
        kind: "sql",
        id: typeof value.id === "string" && value.id !== "" ? value.id : "sql",
        title: typeof value.title === "string" && value.title !== "" ? value.title : "SQL",
        description:
          typeof value.description === "string"
            ? value.description
            : "Browse tables and run queries.",
      }
    }
    if (value.kind !== "panel") return undefined
    const panel = decodePanel(value)
    return panel === undefined ? undefined : { kind: "panel", ...panel }
  }
  const mountPanels = (panels: readonly Panel[]): void => {
    const nav = el("nav", HTMLElement)
    const views = el("views", HTMLElement)
    for (const panel of panels) {
      const button = document.createElement("button")
      button.type = "button"
      button.dataset.view = panel.id
      button.textContent = panel.title
      nav.append(button)
      const section = document.createElement("section")
      section.className = "view"
      section.id = `view-${panel.id}`
      section.hidden = true
      const title = document.createElement("h2")
      title.textContent = panel.title
      const lede = document.createElement("p")
      lede.className = "lede"
      lede.textContent = panel.description
      const body = document.createElement("div")
      body.className = "panel-body"
      body.id = `panel-${panel.id}`
      body.innerHTML = panel.html
      section.append(title, lede, body)
      views.append(section)
      if (panel.script === undefined) continue
      try {
        const compiled: unknown = new Function("root", "api", panel.script)
        if (!isPanelScript(compiled)) throw new Error("panel script did not compile")
        compiled(body, panelApi)
      } catch (error) {
        const note = document.createElement("p")
        note.className = "banner show"
        note.textContent = error instanceof Error ? error.message : String(error)
        body.append(note)
      }
    }
  }

  startAdminBrand({
    document,
    $: (id) => document.getElementById(id),
    params,
    location: { href: location.href, origin: location.origin },
    fetch,
    brandsUrl: config.brandsUrl,
  })
  loadNamespaces()
    .then(() => api("GET", "/ui/manifest"))
    .then((manifest) => {
      const panels = requireList(
        isRecord(manifest) ? manifest.panels : undefined,
        "Panels",
      ).flatMap((panel) => {
        const decoded = decodePanel(panel)
        return decoded === undefined ? [] : [decoded]
      })
      mountPanels(panels)
      const extensions = requireList(
        isRecord(manifest) ? manifest.extensions : undefined,
        "Extensions",
      ).flatMap((extension) => {
        const decoded = decodeExtension(extension)
        return decoded === undefined ? [] : [decoded]
      })
      const extensionPanels = extensions.flatMap((extension) =>
        extension.kind === "panel" ? [extension] : [],
      )
      mountPanels(extensionPanels)
      for (const extension of extensions) {
        if (extension.kind !== "sql") continue
        const nav = el("nav", HTMLElement)
        const views = el("views", HTMLElement)
        const button = document.createElement("button")
        button.type = "button"
        button.dataset.view = extension.id
        button.textContent = extension.title
        nav.append(button)
        const section = document.createElement("section")
        section.className = "view"
        section.id = `view-${extension.id}`
        section.hidden = true
        const title = document.createElement("h2")
        title.textContent = extension.title
        const lede = document.createElement("p")
        lede.className = "lede"
        lede.textContent = extension.description
        const body = document.createElement("div")
        body.className = "panel-body"
        section.append(title, lede, body)
        views.append(section)
        mountSqlExplorer(body, panelApi)
      }
      show(document.getElementById(`view-${state.view}`) === null ? "overview" : state.view)
      return refresh()
    })
    .catch(showError)
}

const clientPrelude = [
  isRecord,
  highlightJsonText,
  mountAdminBrand,
  startAdminBrand,
  faultPresetList,
  mountSqlExplorer,
  bootAdmin,
]
  .map((fn) => fn.toString())
  .join("\n")

/**
 * The `<script>` embedded in the admin document, typechecked as {@link bootAdmin}.
 * The call uses `bootAdmin.name` because a bundle that includes this module once per
 * mock renames later copies (`bootAdmin2`, …). `toString()` follows the rename, so a
 * literal `bootAdmin(` throws before the section buttons are wired.
 */
export const adminClientSource = (config: AdminBootConfig): string => {
  const payload = JSON.stringify(config).replace(/</g, "\\u003c")
  const entry = bootAdmin.name
  if (!/^[A-Za-z_$][\w$]*$/.test(entry)) {
    throw new Error("admin client cannot call its boot function")
  }
  return `<script>\n${clientPrelude}\n${entry}(${payload});\n</script>`
}
