import type { MockAdmin } from "../adapters/identity/oauthMockIdentity.js"
import type { Db } from "../app/ports/db.js"

type AdminCall = (
  id: string,
  path: string,
  method: string,
  headers: [string, string][],
  body: string | null,
) => Promise<Response>

const fetches = new Map<string, MockAdmin["fetch"]>()

const installBridge = (): void => {
  const host = window as Window & { __coveAdminFetch?: AdminCall }
  if (host.__coveAdminFetch) return
  host.__coveAdminFetch = (id, path, method, headers, body) => {
    const fetchImpl = fetches.get(id)
    if (!fetchImpl) return Promise.resolve(new Response("Unknown admin", { status: 404 }))
    const hasBody = body !== null && method !== "GET" && method !== "HEAD"
    return fetchImpl(
      new Request(`https://mock.local${path}`, {
        method,
        headers,
        ...(hasBody ? { body } : {}),
      }),
    )
  }
}

/** The admin document fetches relative URLs. Point those at this demo's in-process mock. */
const adminSrcdoc = (html: string, id: string): string => {
  const script = `<script>(function(id){var call=parent.__coveAdminFetch;window.fetch=function(input,init){var request=new Request(input,init);var url=new URL(request.url,parent.location.href);var method=request.method;var headers=[];request.headers.forEach(function(value,key){headers.push([key,value])});var read=method==="GET"||method==="HEAD"?Promise.resolve(null):request.text();return read.then(function(body){return call(id,url.pathname+url.search,method,headers,body)})}})(${JSON.stringify(id)})</script>`
  return html.includes("<head>") ? html.replace("<head>", `<head>${script}`) : script + html
}

const STYLES = `
.demo-shell {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  min-width: 0;
  background: var(--bg, #fff);
  color: var(--fg, #111);
  font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
}
.demo-tabs {
  display: flex;
  gap: 4px;
  flex: none;
  overflow-x: auto;
  padding: 8px 10px;
  border-bottom: 1px solid var(--border, #e7e7ea);
  background: var(--bg, #fff);
}
.demo-tabs button {
  flex: none;
  border: 0;
  background: transparent;
  color: var(--fg-muted, #5c5c66);
  border-radius: 999px;
  min-height: 36px;
  padding: 0 12px;
  font: inherit;
  font-size: 13px;
  cursor: pointer;
}
.demo-tabs button:hover { color: var(--fg, #111); }
.demo-tabs button[aria-selected="true"] {
  background: var(--bg-subtle, #f4f4f5);
  color: var(--fg, #111);
  font-weight: 600;
  box-shadow: inset 0 -2px 0 var(--accent, #5b4fe0);
}
.demo-tabs button:focus-visible { outline: 2px solid var(--accent, #5b4fe0); outline-offset: 2px; }
.demo-stage { position: relative; flex: 1; min-height: 0; min-width: 0; }
.demo-panel { position: absolute; inset: 0; display: flex; flex-direction: column; min-width: 0; }
.demo-panel[hidden] { display: none !important; }
.demo-panel > .cove-app { height: 100%; }
.demo-frame { flex: 1; width: 100%; border: 0; background: var(--bg, #fff); }
.demo-status { margin: 24px; color: var(--fg-muted, #5c5c66); font-size: 13.5px; }
.demo-db {
  height: 100%;
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-height: 0;
  padding: 16px;
  box-sizing: border-box;
}
.demo-db h2 { margin: 0; font-size: 18px; letter-spacing: -0.02em; }
.demo-db p { margin: 0; color: var(--fg-muted, #5c5c66); font-size: 13px; }
.demo-db-bar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.demo-db-bar button, .demo-refresh {
  border: 1px solid var(--border, #e7e7ea);
  background: var(--bg, #fff);
  color: inherit;
  border-radius: 999px;
  min-height: 32px;
  padding: 0 10px;
  font: inherit;
  font-size: 12.5px;
  cursor: pointer;
}
.demo-db-bar button[aria-current="true"] {
  background: var(--bg-subtle, #f4f4f5);
  font-weight: 600;
}
.demo-db-scroll {
  flex: 1;
  min-height: 0;
  overflow: auto;
  border: 1px solid var(--border, #e7e7ea);
  border-radius: 12px;
}
.demo-db table { width: max-content; min-width: 100%; border-collapse: collapse; font-size: 13px; }
.demo-db th, .demo-db td {
  text-align: left;
  padding: 8px 10px;
  border-bottom: 1px solid var(--border, #e7e7ea);
  vertical-align: top;
}
.demo-db th { font-size: 12px; white-space: nowrap; color: var(--fg-muted, #5c5c66); }
.demo-db td { overflow-wrap: anywhere; }
.demo-error { color: var(--danger, #a33b32); }
`

const TABLE_NAME = /^[a-z_][a-z0-9_]*$/

const escapeHtml = (value: string): string =>
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

const cellText = (value: unknown): string => {
  if (value === null || value === undefined) return ""
  if (value instanceof Date) return value.toISOString()
  if (typeof value === "object") return JSON.stringify(value)
  return String(value)
}

const installStyles = (): void => {
  if (document.getElementById("cove-demo-shell")) return
  const style = document.createElement("style")
  style.id = "cove-demo-shell"
  style.textContent = STYLES
  document.head.appendChild(style)
}

/**
 * Tabs over the product and each mock it is running. HTTP mocks get their own
 * `/__admin/ui`, loaded against the same in-process fetch the app is using.
 * Postgres has no HTTP control plane, so its tab queries the tables directly.
 */
export const mountDemoShell = (
  host: HTMLElement,
  options: {
    mountApp: (panel: HTMLElement) => void
    admins: readonly MockAdmin[]
    db: Db
  },
): (() => void) => {
  installStyles()
  installBridge()
  host.style.position = "relative"
  host.style.overflow = "hidden"

  const shell = document.createElement("div")
  shell.className = "demo-shell"
  const tabs = document.createElement("div")
  tabs.className = "demo-tabs"
  tabs.setAttribute("role", "tablist")
  tabs.setAttribute("aria-label", "Cove and the services it is using")
  const stage = document.createElement("div")
  stage.className = "demo-stage"
  shell.append(tabs, stage)
  host.append(shell)

  const panels = new Map<string, HTMLElement>()
  const buttons: HTMLButtonElement[] = []
  let selected = "app"
  let adminTicket = 0
  let dbTable = ""

  const addTab = (id: string, label: string): HTMLElement => {
    const button = document.createElement("button")
    button.type = "button"
    button.setAttribute("role", "tab")
    button.dataset.demoTab = id
    button.textContent = label
    button.setAttribute("aria-selected", "false")
    button.tabIndex = -1
    tabs.append(button)
    buttons.push(button)
    const panel = document.createElement("div")
    panel.className = "demo-panel"
    panel.dataset.demoPanel = id
    panel.setAttribute("role", "tabpanel")
    panel.hidden = true
    stage.append(panel)
    panels.set(id, panel)
    return panel
  }

  const appPanel = addTab("app", "Cove")
  const appRoot = document.createElement("div")
  appPanel.append(appRoot)
  options.mountApp(appRoot)
  for (const admin of options.admins) {
    fetches.set(admin.id, admin.fetch)
    addTab(admin.id, admin.label)
  }
  const dbPanel = addTab("postgres", "Postgres")

  const showStatus = (panel: HTMLElement, text: string, isError = false): void => {
    panel.replaceChildren()
    const status = document.createElement("p")
    status.className = isError ? "demo-status demo-error" : "demo-status"
    status.textContent = text
    panel.append(status)
  }

  const showAdmin = async (admin: MockAdmin): Promise<void> => {
    const panel = panels.get(admin.id)
    if (!panel) return
    const ticket = ++adminTicket
    showStatus(panel, `Loading ${admin.label} admin…`)
    try {
      const response = await admin.fetch(new Request("https://mock.local/__admin/ui"))
      const html = await response.text()
      if (ticket !== adminTicket || selected !== admin.id) return
      if (!response.ok) {
        showStatus(panel, html || `${response.status} from ${admin.label}`, true)
        return
      }
      const frame = document.createElement("iframe")
      frame.className = "demo-frame"
      frame.title = `${admin.label} admin`
      frame.srcdoc = adminSrcdoc(html, admin.id)
      panel.replaceChildren(frame)
    } catch (error) {
      if (ticket !== adminTicket || selected !== admin.id) return
      showStatus(panel, error instanceof Error ? error.message : String(error), true)
    }
  }

  const renderDatabase = async (): Promise<void> => {
    const ticket = ++adminTicket
    showStatus(dbPanel, "Loading Postgres…")
    try {
      const listed = await options.db.query<{ table_name: string }>(
        "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name",
      )
      const names = listed.map((row) => row.table_name).filter((name) => TABLE_NAME.test(name))
      if (ticket !== adminTicket || selected !== "postgres") return
      if (!names.includes(dbTable)) dbTable = names[0] ?? ""
      const rows = dbTable
        ? await options.db.query<Record<string, unknown>>(
            `SELECT * FROM "${dbTable}" ORDER BY 1 LIMIT 50`,
          )
        : []
      if (ticket !== adminTicket || selected !== "postgres") return
      dbPanel.replaceChildren()
      const view = document.createElement("div")
      view.className = "demo-db"
      const heading = document.createElement("h2")
      heading.textContent = "Postgres"
      const lede = document.createElement("p")
      lede.textContent =
        "Tables Cove writes. This engine has no HTTP admin, so the rows come straight from the database the app is using."
      const bar = document.createElement("div")
      bar.className = "demo-db-bar"
      for (const name of names) {
        const button = document.createElement("button")
        button.type = "button"
        button.textContent = name
        button.setAttribute("aria-current", name === dbTable ? "true" : "false")
        button.addEventListener("click", () => {
          dbTable = name
          void renderDatabase()
        })
        bar.append(button)
      }
      const refresh = document.createElement("button")
      refresh.type = "button"
      refresh.className = "demo-refresh"
      refresh.textContent = "Refresh"
      refresh.addEventListener("click", () => void renderDatabase())
      bar.append(refresh)
      const scroller = document.createElement("div")
      scroller.className = "demo-db-scroll"
      if (!dbTable) {
        scroller.textContent = "No tables yet."
      } else if (rows.length === 0) {
        const empty = document.createElement("p")
        empty.className = "demo-status"
        empty.textContent = `${dbTable} has no rows yet.`
        scroller.append(empty)
      } else {
        const columns = Object.keys(rows[0] ?? {})
        const head = columns.map((column) => `<th>${escapeHtml(column)}</th>`).join("")
        const body = rows
          .map(
            (row) =>
              `<tr>${columns.map((column) => `<td>${escapeHtml(cellText(row[column]))}</td>`).join("")}</tr>`,
          )
          .join("")
        scroller.innerHTML = `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`
      }
      view.append(heading, lede, bar, scroller)
      dbPanel.append(view)
    } catch (error) {
      if (ticket !== adminTicket || selected !== "postgres") return
      showStatus(dbPanel, error instanceof Error ? error.message : String(error), true)
    }
  }

  const select = (id: string): void => {
    selected = id
    for (const button of buttons) {
      const on = button.dataset.demoTab === id
      button.setAttribute("aria-selected", String(on))
      button.tabIndex = on ? 0 : -1
      if (on) button.scrollIntoView({ inline: "nearest", block: "nearest" })
    }
    for (const [panelId, panel] of panels) panel.hidden = panelId !== id
    const admin = options.admins.find((item) => item.id === id)
    if (admin) void showAdmin(admin)
    if (id === "postgres") void renderDatabase()
  }

  tabs.addEventListener("click", (event) => {
    const button = (event.target as Element | null)?.closest<HTMLButtonElement>("[data-demo-tab]")
    if (!button?.dataset.demoTab) return
    select(button.dataset.demoTab)
    button.focus()
  })
  tabs.addEventListener("keydown", (event) => {
    if (!["ArrowRight", "ArrowLeft", "Home", "End"].includes(event.key)) return
    const current = buttons.findIndex((button) => button.dataset.demoTab === selected)
    if (current < 0) return
    event.preventDefault()
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? buttons.length - 1
          : (current + (event.key === "ArrowRight" ? 1 : buttons.length - 1)) % buttons.length
    const button = buttons[next]
    if (!button?.dataset.demoTab) return
    select(button.dataset.demoTab)
    button.focus()
  })

  select("app")

  return () => {
    adminTicket++
    for (const admin of options.admins) fetches.delete(admin.id)
    shell.remove()
  }
}
