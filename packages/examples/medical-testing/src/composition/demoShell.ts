import { scopeReset } from "@crvouga/mockingbird-ui"
import type { MockAdmin } from "../adapters/admin.js"
import { type PastedLocation, type PasteFetch, pasteHtml } from "../client/pasteHtml.js"

const ADMIN_ORIGIN = "https://mock.local"
const ADMIN_LOCATION: PastedLocation = {
  href: `${ADMIN_ORIGIN}/__admin/ui`,
  origin: ADMIN_ORIGIN,
  pathname: "/__admin/ui",
  search: "",
  hash: "",
}

/** Relative admin calls stay in-process. Absolute catalog URLs use the network. */
const adminFetch = (fetchImpl: MockAdmin["fetch"]): PasteFetch => {
  return (input, init) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    const url = new URL(raw, `${ADMIN_ORIGIN}/`)
    if (url.origin !== ADMIN_ORIGIN) return fetch(input, init)
    return fetchImpl(new Request(url, init))
  }
}

const STYLES = `
${scopeReset(".demo-shell")}
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
  align-items: center;
  gap: 6px;
  flex: none;
  overflow-x: auto;
  min-height: 56px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--border, #e7e7ea);
  background: var(--bg, #fff);
}
.demo-tabs button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  border: 0;
  background: transparent;
  color: var(--fg-muted, #5c5c66);
  border-radius: 999px;
  height: 36px;
  padding: 0 14px;
  font: inherit;
  font-size: 13px;
  line-height: 1;
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
.demo-frame { flex: 1; width: 100%; height: 100%; min-height: 0; overflow: auto; background: var(--bg, #fff); }
.demo-status { margin: 24px; color: var(--fg-muted, #5c5c66); font-size: 13.5px; }
.demo-retry { margin: 0 24px; padding: 8px 12px; align-self: flex-start; cursor: pointer; }
.demo-error { color: var(--danger, #a33b32); }
`

const installStyles = (): void => {
  if (document.getElementById("cove-demo-shell")) return
  const style = document.createElement("style")
  style.id = "cove-demo-shell"
  style.textContent = STYLES
  document.head.appendChild(style)
}

/**
 * Every service and data source uses its own shared `/__admin/ui`, fetched
 * and mounted against the same in-process instance the app is using.
 */
export const mountDemoShell = (
  host: HTMLElement,
  options: {
    mountApp: (panel: HTMLElement) => () => void
    admins: readonly MockAdmin[]
  },
): (() => void) => {
  installStyles()
  host.style.position = "relative"
  host.style.overflow = "hidden"

  const shell = document.createElement("div")
  shell.className = "demo-shell"
  const tabs = document.createElement("div")
  tabs.className = "demo-tabs"
  tabs.setAttribute("role", "tablist")
  tabs.setAttribute("aria-label", "Example app and the services it is using")
  const stage = document.createElement("div")
  stage.className = "demo-stage"
  shell.append(tabs, stage)
  host.append(shell)

  const tabPrefix = `demo-${crypto.randomUUID()}`
  const panels = new Map<string, HTMLElement>()
  const buttons: HTMLButtonElement[] = []
  let selected = "app"
  let adminTicket = 0
  let unpaste: (() => void) | undefined

  const addTab = (id: string, label: string): HTMLElement => {
    const button = document.createElement("button")
    button.type = "button"
    button.setAttribute("role", "tab")
    button.id = `${tabPrefix}-tab-${id}`
    button.setAttribute("aria-controls", `${tabPrefix}-panel-${id}`)
    button.dataset.demoTab = id
    button.textContent = label
    button.setAttribute("aria-selected", "false")
    button.tabIndex = -1
    tabs.append(button)
    buttons.push(button)
    const panel = document.createElement("div")
    panel.id = `${tabPrefix}-panel-${id}`
    panel.setAttribute("aria-labelledby", button.id)
    panel.className = "demo-panel"
    panel.dataset.demoPanel = id
    panel.setAttribute("role", "tabpanel")
    panel.hidden = true
    stage.append(panel)
    panels.set(id, panel)
    return panel
  }

  const appPanel = addTab("app", "Example")
  const appRoot = document.createElement("div")
  appPanel.append(appRoot)
  const unmountApp = options.mountApp(appRoot)
  for (const admin of options.admins) addTab(admin.id, admin.label)

  const showStatus = (panel: HTMLElement, text: string, isError = false): void => {
    panel.replaceChildren()
    const status = document.createElement("p")
    status.className = isError ? "demo-status demo-error" : "demo-status"
    status.textContent = text
    status.setAttribute("role", isError ? "alert" : "status")
    panel.append(status)
  }

  const showAdmin = async (admin: MockAdmin): Promise<void> => {
    const panel = panels.get(admin.id)
    if (!panel) return
    const ticket = ++adminTicket
    unpaste?.()
    unpaste = undefined
    showStatus(panel, `Loading ${admin.label} admin…`)
    try {
      const response = await admin.fetch(new Request(`${ADMIN_ORIGIN}/__admin/ui`))
      const html = await response.text()
      if (ticket !== adminTicket || selected !== admin.id) return
      if (!response.ok) {
        throw new Error(`${admin.label} admin returned ${response.status}`)
      }
      const frame = document.createElement("div")
      frame.className = "demo-frame"
      frame.setAttribute("role", "region")
      frame.setAttribute("aria-label", `${admin.label} admin`)
      panel.replaceChildren(frame)
      unpaste = pasteHtml(frame, html, {
        fetch: adminFetch(admin.fetch),
        location: ADMIN_LOCATION,
      })
    } catch (error) {
      if (ticket !== adminTicket || selected !== admin.id) return
      showStatus(panel, error instanceof Error ? error.message : String(error), true)
      const retry = document.createElement("button")
      retry.type = "button"
      retry.className = "demo-retry"
      retry.textContent = "Try again"
      retry.addEventListener("click", () => void showAdmin(admin))
      panel.append(retry)
    }
  }

  const select = (id: string): void => {
    adminTicket++
    unpaste?.()
    unpaste = undefined
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
    unpaste?.()
    unmountApp()
    shell.remove()
  }
}
