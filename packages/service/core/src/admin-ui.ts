import type { AdminRoutes } from "./control.js"
import { ADMIN_KEY_HEADER, ADMIN_PREFIX } from "./control.js"
import type { AdminUi } from "./surface.js"
import { STANDARD_ADMIN_ROUTES } from "./surface.js"

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

/**
 * The default admin document. It talks only to `/__admin/*`, so every mock can serve it.
 * Bespoke panels arrive later from `GET /ui/manifest`, which stays behind the admin key.
 */
export const renderAdminDocument = (service: string): string => {
  const name = escapeHtml(service)
  const standard = JSON.stringify(STANDARD_ADMIN_ROUTES)
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Crect width='16' height='16' rx='3' fill='%233d4f3a'/%3E%3C/svg%3E">
<title>${name} admin</title>
<style>
  :root {
    color-scheme: light;
    --bg: #f6f5f2;
    --bg-elev: #ffffff;
    --bg-muted: #eeece6;
    --bg-inset: #f3f1eb;
    --line: #e2dfd6;
    --line-strong: #d0ccc1;
    --ink: #1c1915;
    --muted: #5e584f;
    --faint: #8a8378;
    --accent: #3d4f3a;
    --accent-ink: #f7f6f2;
    --accent-soft: #e5ece2;
    --ok: #1f7a45;
    --ok-soft: #e5f4eb;
    --warn: #9a6700;
    --warn-soft: #fbf3df;
    --err: #a33b32;
    --err-soft: #fdecea;
    --shadow: 0 1px 2px rgb(28 25 21 / 0.05), 0 12px 32px rgb(28 25 21 / 0.06);
    --sans: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    --mono: ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, monospace;
    --radius: 14px;
    --header: 60px;
    --nav: 220px;
  }
  :root[data-theme="dark"] {
    color-scheme: dark;
    --bg: #141311;
    --bg-elev: #1e1c19;
    --bg-muted: #26231f;
    --bg-inset: #181715;
    --line: #34302b;
    --line-strong: #4a453d;
    --ink: #f4f1ea;
    --muted: #c4bdb1;
    --faint: #8f877c;
    --accent: #c5d5b8;
    --accent-ink: #1a2118;
    --accent-soft: #2a3328;
    --ok: #8fd6a8;
    --ok-soft: #1a2e22;
    --warn: #f0cc78;
    --warn-soft: #332911;
    --err: #f0a8a2;
    --err-soft: #3a201e;
    --shadow: 0 1px 2px rgb(0 0 0 / 0.3), 0 16px 40px rgb(0 0 0 / 0.28);
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      color-scheme: dark;
      --bg: #141311;
      --bg-elev: #1e1c19;
      --bg-muted: #26231f;
      --bg-inset: #181715;
      --line: #34302b;
      --line-strong: #4a453d;
      --ink: #f4f1ea;
      --muted: #c4bdb1;
      --faint: #8f877c;
      --accent: #c5d5b8;
      --accent-ink: #1a2118;
      --accent-soft: #2a3328;
      --ok: #8fd6a8;
      --ok-soft: #1a2e22;
      --warn: #f0cc78;
      --warn-soft: #332911;
      --err: #f0a8a2;
      --err-soft: #3a201e;
      --shadow: 0 1px 2px rgb(0 0 0 / 0.3), 0 16px 40px rgb(0 0 0 / 0.28);
    }
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; height: 100%; }
  body {
    font-family: var(--sans);
    background: var(--bg);
    color: var(--ink);
    line-height: 1.45;
    padding-left: env(safe-area-inset-left);
    padding-right: env(safe-area-inset-right);
    -webkit-text-size-adjust: 100%;
  }
  button, input, select, textarea { font: inherit; color: inherit; }
  button { cursor: pointer; }
  :focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  @media (prefers-reduced-motion: reduce) {
    * { scroll-behavior: auto !important; transition: none !important; }
  }
  .app { min-height: 100%; display: flex; flex-direction: column; }
  header.top {
    position: sticky; top: 0; z-index: 5;
    display: flex; align-items: center; gap: 12px;
    min-height: var(--header); padding: 10px 16px;
    background: color-mix(in srgb, var(--bg-elev) 92%, transparent);
    border-bottom: 1px solid var(--line);
    backdrop-filter: blur(10px);
  }
  .brand { display: flex; flex-direction: column; min-width: 0; margin-right: auto; }
  .brand strong { font-size: 15px; letter-spacing: -0.01em; }
  .brand span { color: var(--faint); font-size: 12px; }
  .controls { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
  label.field { display: flex; flex-direction: column; gap: 2px; font-size: 11px; color: var(--faint); }
  label.field input, label.field select, .controls input[type="password"] {
    background: var(--bg-inset); border: 1px solid var(--line); border-radius: 8px;
    padding: 7px 8px; min-height: 36px;
  }
  .icon-btn, .btn, .btn-primary, .btn-quiet, .btn-danger {
    border-radius: 9px; min-height: 36px; padding: 0 12px; border: 1px solid var(--line);
    background: var(--bg-elev);
  }
  .btn-primary { background: var(--accent); color: var(--accent-ink); border-color: transparent; }
  .btn-quiet { background: transparent; }
  .btn-danger { color: var(--err); }
  /* minmax(0, 1fr): a 1fr column will not shrink below its content, so a long
     record or the full nav row would widen the page past the viewport. */
  .layout {
    display: grid; grid-template-columns: var(--nav) minmax(0, 1fr);
    flex: 1; min-height: 0; min-width: 0;
  }
  nav.side {
    border-right: 1px solid var(--line); padding: 12px;
    display: flex; flex-direction: column; gap: 4px;
    background: var(--bg-elev);
  }
  nav.side button {
    text-align: left; border: 0; background: transparent; border-radius: 9px;
    padding: 9px 10px; min-height: 40px; color: var(--muted);
  }
  nav.side button[aria-current="true"] { background: var(--accent-soft); color: var(--ink); font-weight: 600; }
  main { padding: 20px; max-width: 1100px; width: 100%; min-width: 0; }
  .view h2 { margin: 0 0 4px; font-size: 22px; letter-spacing: -0.02em; }
  .lede { margin: 0 0 16px; color: var(--muted); }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; }
  .card {
    background: var(--bg-elev); border: 1px solid var(--line); border-radius: var(--radius);
    padding: 14px 16px; box-shadow: var(--shadow);
  }
  .card .k { color: var(--faint); font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em; }
  .card .v { display: flex; flex-direction: column; gap: 2px; font-size: 22px; margin-top: 4px; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
  .card .v .clock-time { font-size: 14px; color: var(--muted); }
  .split { display: grid; grid-template-columns: minmax(0, 240px) minmax(0, 1fr); gap: 16px; align-items: start; }
  .collection {
    width: 100%; text-align: left; border: 1px solid transparent; background: transparent;
    border-radius: 10px; padding: 8px 10px; min-height: 44px;
  }
  .collection[aria-current="true"] { background: var(--bg-elev); border-color: var(--line); }
  .collection small { display: block; color: var(--faint); }
  .chips { display: flex; flex-wrap: wrap; gap: 6px; margin: 8px 0 14px; }
  .chip {
    font-family: var(--mono); font-size: 12px; background: var(--bg-muted);
    border-radius: 999px; padding: 4px 8px;
  }
  .chip i { color: var(--faint); font-style: normal; }
  table { width: 100%; border-collapse: collapse; font-size: 14px; }
  th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--line); vertical-align: top; }
  th { color: var(--faint); font-weight: 600; font-size: 12px; }
  tr.clickable { cursor: pointer; }
  tr.clickable:hover { background: var(--bg-muted); }
  pre, code, .mono { font-family: var(--mono); overflow-wrap: anywhere; }
  pre {
    margin: 0; white-space: pre-wrap; word-break: break-word;
    background: var(--bg-inset); border-radius: 10px; padding: 12px; font-size: 12px;
  }
  .row-actions { display: flex; flex-wrap: wrap; gap: 8px; margin: 12px 0; }
  .banner {
    display: none; margin-bottom: 12px; padding: 10px 12px; border-radius: 10px;
    background: var(--err-soft); color: var(--err);
  }
  .banner.show { display: block; }
  .empty { color: var(--muted); padding: 24px 8px; }
  dialog {
    border: 1px solid var(--line); border-radius: 16px; padding: 0; background: var(--bg-elev);
    color: var(--ink); width: min(640px, calc(100vw - 24px)); box-shadow: var(--shadow);
  }
  dialog::backdrop { background: rgb(20 19 17 / 0.45); }
  dialog form, .dialog-body { padding: 16px; display: flex; flex-direction: column; gap: 10px; }
  textarea {
    width: 100%; min-height: 180px; resize: vertical; border-radius: 10px;
    border: 1px solid var(--line); background: var(--bg-inset); padding: 10px;
    font-family: var(--mono); font-size: 12px;
  }
  .dialog-actions { display: flex; justify-content: flex-end; gap: 8px; }
  .badge { font-size: 11px; border-radius: 999px; padding: 2px 7px; background: var(--bg-muted); color: var(--muted); }
  .badge.ok { background: var(--ok-soft); color: var(--ok); }
  .badge.warn { background: var(--warn-soft); color: var(--warn); }
  .status-2 { color: var(--ok); }
  .status-4, .status-5, .status-0 { color: var(--err); }
  .stack { display: flex; flex-direction: column; gap: 12px; }
  .route {
    display: grid; grid-template-columns: 88px 1fr auto; gap: 8px; align-items: center;
    padding: 8px 0; border-bottom: 1px solid var(--line);
  }
  .method { font-family: var(--mono); font-size: 12px; font-weight: 700; }
  @media (max-width: 800px) {
    header.top {
      align-items: stretch; flex-direction: column;
      padding-top: max(10px, env(safe-area-inset-top));
    }
    input, select, textarea { font-size: 16px; }
    .controls { width: 100%; }
    label.field, label.field select, label.field input { flex: 1; min-width: 0; }
    .layout { grid-template-columns: minmax(0, 1fr); }
    nav.side {
      flex-direction: row; align-items: center; overflow-x: auto; min-width: 0;
      border-right: 0; border-bottom: 1px solid var(--line);
      padding: 8px;
    }
    nav.side button { white-space: nowrap; flex: none; }
    .split { grid-template-columns: minmax(0, 1fr); }
    main { padding: 14px; }
    table, thead, tbody, tr, th, td { display: block; }
    thead { display: none; }
    tr {
      border: 1px solid var(--line); border-radius: 12px; margin-bottom: 8px; padding: 6px;
      background: var(--bg-elev); min-width: 0;
    }
    td {
      border: 0; display: flex; flex-wrap: wrap; justify-content: space-between; gap: 4px 12px;
      min-width: 0; overflow-wrap: anywhere;
    }
    td::before { content: attr(data-label); color: var(--faint); font-size: 12px; flex: none; }
    .route { grid-template-columns: 72px 1fr; }
    .route button { grid-column: 1 / -1; }
  }
</style>
</head>
<body>
<div class="app" data-service="${name}" data-mockingbird-admin>
  <header class="top">
    <div class="brand">
      <strong>${name}</strong>
      <span>Mockingbird admin</span>
    </div>
    <div class="controls">
      <label class="field">Namespace
        <select id="namespace" aria-label="Namespace"></select>
      </label>
      <label class="field">Admin key
        <input id="admin-key" type="password" autocomplete="off" spellcheck="false" aria-label="Admin key">
      </label>
      <button class="icon-btn" id="theme" type="button" aria-label="Toggle color theme">Theme</button>
      <button class="btn" id="refresh" type="button">Refresh</button>
    </div>
  </header>
  <div class="layout">
    <nav class="side" id="nav" aria-label="Admin sections">
      <button type="button" data-view="overview" aria-current="true">Overview</button>
      <button type="button" data-view="state">State</button>
      <button type="button" data-view="clock">Clock</button>
      <button type="button" data-view="faults">Faults</button>
      <button type="button" data-view="journal">Journal</button>
      <button type="button" data-view="routes">Routes</button>
    </nav>
    <main id="views">
      <p class="banner" id="banner" role="alert"></p>
      <section class="view" id="view-overview">
        <h2>Overview</h2>
        <p class="lede">Health, clock, and the collections this namespace is holding.</p>
        <div class="grid" id="overview-cards"></div>
        <h3>Recent requests</h3>
        <div id="overview-requests"></div>
      </section>
      <section class="view" id="view-state" hidden>
        <h2>State</h2>
        <p class="lede">Every collection in this namespace. Declared fields stay visible before any row exists; stored rows add whatever else they contain.</p>
        <div class="split">
          <div id="collections"></div>
          <div>
            <div id="schema"></div>
            <div class="row-actions">
              <button class="btn-primary" id="new-record" type="button">New record</button>
            </div>
            <div id="records"></div>
          </div>
        </div>
      </section>
      <section class="view" id="view-clock" hidden>
        <h2>Clock</h2>
        <p class="lede">The clock every timestamp in this mock reads.</p>
        <div class="card" id="clock-readout"></div>
        <div class="row-actions">
          <button class="btn" type="button" data-advance="60000">+1m</button>
          <button class="btn" type="button" data-advance="900000">+15m</button>
          <button class="btn" type="button" data-advance="3600000">+1h</button>
          <button class="btn" type="button" data-advance="86400000">+1d</button>
          <button class="btn" type="button" data-advance="-3600000">−1h</button>
          <button class="btn" id="freeze" type="button">Freeze</button>
          <button class="btn-quiet" id="clock-reset" type="button">Reset</button>
        </div>
        <form id="clock-set" class="row-actions">
          <label class="field">Set instant
            <input id="clock-instant" type="text" placeholder="2026-01-01T00:00:00Z or epoch ms" size="32">
          </label>
          <button class="btn-primary" type="submit">Set</button>
        </form>
      </section>
      <section class="view" id="view-faults" hidden>
        <h2>Faults</h2>
        <p class="lede">Inject a response, a delay, or a named preset. Rules apply to this namespace.</p>
        <form id="fault-form" class="card stack">
          <label class="field">Preset
            <select id="fault-preset"><option value="">Custom rule</option></select>
          </label>
          <label class="field">Status
            <input id="fault-status" inputmode="numeric" placeholder="503">
          </label>
          <label class="field">Path prefix
            <input id="fault-path" placeholder="/v1">
          </label>
          <label class="field">Method
            <input id="fault-method" placeholder="GET">
          </label>
          <div class="dialog-actions">
            <button class="btn-primary" type="submit">Add fault</button>
            <button class="btn-danger" id="fault-clear" type="button">Clear all</button>
          </div>
        </form>
        <div id="fault-list"></div>
      </section>
      <section class="view" id="view-journal" hidden>
        <h2>Journal</h2>
        <p class="lede">Requests this namespace has seen. Bodies are not stored.</p>
        <div class="row-actions">
          <button class="btn-danger" id="journal-clear" type="button">Clear journal</button>
        </div>
        <div id="journal"></div>
      </section>
      <section class="view" id="view-routes" hidden>
        <h2>Routes</h2>
        <p class="lede">Shared controls, plus any routes this mock adds. Extra routes are how a bespoke workflow shows up beside the default UI.</p>
        <div id="route-list"></div>
        <form id="route-form" class="card stack">
          <strong id="route-title">Select a route</strong>
          <label class="field">JSON body
            <textarea id="route-body" placeholder="{ }"></textarea>
          </label>
          <div class="dialog-actions">
            <button class="btn-primary" type="submit">Send</button>
          </div>
          <pre id="route-result">Response will show here.</pre>
        </form>
      </section>
    </main>
  </div>
</div>
<dialog id="editor">
  <form method="dialog" id="editor-form">
    <strong id="editor-title">Record</strong>
    <label class="field">Id
      <input id="editor-id" required>
    </label>
    <label class="field">JSON value
      <textarea id="editor-value"></textarea>
    </label>
    <div class="dialog-actions">
      <button class="btn-danger" id="editor-delete" type="button" value="delete">Delete</button>
      <button class="btn-quiet" type="submit" value="cancel">Cancel</button>
      <button class="btn-primary" type="submit" value="save">Save</button>
    </div>
  </form>
</dialog>
<script>
(() => {
  const STANDARD = new Set(${standard})
  const state = {
    namespace: "default",
    key: sessionStorage.getItem("mockingbird-admin-key") || "",
    view: "overview",
    collection: "",
    shape: null,
    route: null,
    editing: null
  }
  const $ = (id) => document.getElementById(id)
  const banner = $("banner")
  const keyInput = $("admin-key")
  keyInput.value = state.key
  const params = new URLSearchParams(location.search)
  if (params.get("key")) {
    state.key = params.get("key")
    keyInput.value = state.key
    sessionStorage.setItem("mockingbird-admin-key", state.key)
    params.delete("key")
    const next = params.toString()
    history.replaceState(null, "", location.pathname + (next ? "?" + next : ""))
  }
  if (params.get("namespace")) state.namespace = params.get("namespace")

  const showError = (error) => {
    banner.textContent = error instanceof Error ? error.message : String(error)
    banner.classList.add("show")
  }
  const clearError = () => banner.classList.remove("show")

  async function originGet(path) {
    const response = await fetch(path, { headers: { accept: "application/json" } })
    if (!response.ok) throw new Error(response.status + " " + path)
    return response.json()
  }
  async function api(method, path, body) {
    const headers = { accept: "application/json" }
    if (state.key) headers["${ADMIN_KEY_HEADER}"] = state.key
    if (state.namespace) headers["x-mockingbird-namespace"] = state.namespace
    if (body !== undefined) headers["content-type"] = "application/json"
    const response = await fetch("${ADMIN_PREFIX}" + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body)
    })
    const text = await response.text()
    let data = null
    if (text) {
      try { data = JSON.parse(text) } catch { data = { raw: text } }
    }
    if (response.status === 401) {
      keyInput.focus()
      throw new Error((data && data.error && data.error.message) || "Admin key required")
    }
    if (!response.ok) {
      throw new Error((data && data.error && data.error.message) || (response.status + " " + method + " " + path))
    }
    return data
  }
  const panelApi = {
    get: (path) => api("GET", path),
    send: (method, path, body) => api(method, path, body),
    namespace: () => state.namespace
  }

  function setTheme(theme) {
    if (theme) document.documentElement.dataset.theme = theme
    else delete document.documentElement.dataset.theme
  }
  const storedTheme = localStorage.getItem("mockingbird-admin-theme")
  if (storedTheme) setTheme(storedTheme)
  $("theme").addEventListener("click", () => {
    const current = document.documentElement.dataset.theme
    const dark = current ? current === "dark" : matchMedia("(prefers-color-scheme: dark)").matches
    const next = dark ? "light" : "dark"
    localStorage.setItem("mockingbird-admin-theme", next)
    setTheme(next)
  })

  function show(view) {
    state.view = view
    for (const button of document.querySelectorAll("#nav button")) {
      button.setAttribute("aria-current", button.dataset.view === view ? "true" : "false")
    }
    for (const section of document.querySelectorAll("main .view")) {
      section.hidden = section.id !== "view-" + view
    }
  }
  document.getElementById("nav").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-view]")
    if (!button) return
    show(button.dataset.view)
    refresh().catch(showError)
  })

  function cards(items) {
    return '<div class="grid">' + items.map((item) =>
      '<article class="card"><div class="k">' + item.k + '</div><div class="v">' + item.v + '</div></article>'
    ).join("") + "</div>"
  }
  function table(columns, rows) {
    if (rows.length === 0) return '<p class="empty">Nothing here yet.</p>'
    const head = "<tr>" + columns.map((column) => "<th>" + column.label + "</th>").join("") + "</tr>"
    const body = rows.map((row) => "<tr" + (row.attrs || "") + ">" + columns.map((column) =>
      '<td data-label="' + column.label + '">' + column.cell(row) + "</td>"
    ).join("") + "</tr>").join("")
    return "<table><thead>" + head + "</thead><tbody>" + body + "</tbody></table>"
  }
  const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[char]))
  const preview = (value) => {
    const text = JSON.stringify(value)
    return esc(text.length > 180 ? text.slice(0, 180) + "…" : text)
  }
  const when = (epoch) => {
    const date = new Date(epoch)
    return Number.isNaN(date.getTime()) ? String(epoch) : date.toISOString()
  }
  const clockCard = (epoch) => {
    const date = new Date(epoch)
    if (Number.isNaN(date.getTime())) return esc(String(epoch))
    const iso = date.toISOString()
    return esc(iso.slice(0, 10)) + '<span class="clock-time">' + esc(iso.slice(11, 19)) + " UTC</span>"
  }

  async function loadNamespaces() {
    const data = await api("GET", "/namespaces")
    const select = $("namespace")
    const names = data.namespaces && data.namespaces.length ? data.namespaces : [data.default || "default"]
    if (!names.includes(state.namespace)) names.unshift(state.namespace)
    select.innerHTML = names.map((name) =>
      '<option value="' + esc(name) + '">' + esc(name) + "</option>"
    ).join("")
    select.value = state.namespace
  }

  async function renderOverview() {
    const [health, shape, clock, journal] = await Promise.all([
      originGet("/health"),
      api("GET", "/state"),
      api("GET", "/clock"),
      api("GET", "/requests?limit=8")
    ])
    state.shape = shape
    $("overview-cards").innerHTML = cards([
      { k: "Service", v: esc(health.service || "${name}") },
      { k: "Status", v: esc(health.status || "ok") },
      { k: "Namespace", v: esc(state.namespace) },
      { k: "Collections", v: String(shape.collections.length) },
      { k: "Records", v: String(shape.collections.reduce((sum, item) => sum + item.count, 0)) },
      { k: "Clock", v: clockCard(clock.now) }
    ])
    const requests = (journal && journal.requests) || []
    $("overview-requests").innerHTML = table(
      [
        { label: "Method", cell: (row) => esc(row.method) },
        { label: "Path", cell: (row) => esc(row.path) },
        { label: "Status", cell: (row) => '<span class="status-' + String(row.status).charAt(0) + '">' + esc(row.status) + "</span>" },
        { label: "Operation", cell: (row) => esc(row.operationId || "") }
      ],
      requests
    )
  }

  function schemaChips(collection) {
    if (!collection || collection.fields.length === 0) {
      return '<p class="empty">No fields yet. Add a record or declare the collection on the service.</p>'
    }
    return '<div class="chips">' + collection.fields.map((field) =>
      '<span class="chip">' + esc(field.name) + ' <i>' + esc(field.kind) + (field.optional ? "?" : "") + "</i></span>"
    ).join("") + "</div>"
  }

  async function renderState() {
    const shape = await api("GET", "/state")
    state.shape = shape
    const host = $("collections")
    if (shape.collections.length === 0) {
      host.innerHTML = '<p class="empty">This namespace has no collections yet.</p>'
      $("schema").innerHTML = ""
      $("records").innerHTML = ""
      return
    }
    if (!shape.collections.some((item) => item.name === state.collection)) {
      state.collection = shape.collections[0].name
    }
    host.innerHTML = shape.collections.map((item) =>
      '<button type="button" class="collection" data-collection="' + esc(item.name) + '" aria-current="' +
      (item.name === state.collection ? "true" : "false") + '"><strong>' + esc(item.label) +
      '</strong><small>' + esc(item.count) + " · " + esc(item.source) + "</small></button>"
    ).join("")
    const selected = shape.collections.find((item) => item.name === state.collection)
    $("schema").innerHTML = "<h3>" + esc(selected.label) + "</h3>" +
      (selected.description ? "<p class=" + '"lede">' + esc(selected.description) + "</p>" : "") +
      schemaChips(selected)
    const page = await api("GET", "/state/" + encodeURIComponent(state.collection) + "?limit=50")
    const rows = page.records.map((record) => ({
      ...record,
      attrs: ' class="clickable" data-id="' + esc(record.id) + '"'
    }))
    $("records").innerHTML = table(
      [
        { label: "Id", cell: (row) => "<code>" + esc(row.id) + "</code>" },
        { label: "Seq", cell: (row) => esc(row.seq) },
        { label: "Value", cell: (row) => preview(row.value) }
      ],
      rows
    )
  }

  async function renderClock() {
    const clock = await api("GET", "/clock")
    $("clock-readout").innerHTML = "<div class='k'>Now</div><div class='v'>" + esc(when(clock.now)) +
      "</div><p>" + esc(clock.now) + " ms · offset " + esc(clock.offsetMs) + " ms " +
      (clock.frozen ? "<span class='badge warn'>frozen</span>" : "<span class='badge ok'>live</span>") + "</p>"
    $("freeze").textContent = clock.frozen ? "Unfreeze" : "Freeze"
    $("freeze").dataset.frozen = clock.frozen ? "1" : "0"
  }

  async function renderFaults() {
    const [faults, presets] = await Promise.all([
      api("GET", "/faults"),
      api("GET", "/faults/presets").catch(() => ({ presets: [] }))
    ])
    const select = $("fault-preset")
    const current = select.value
    const list = presets.presets || []
    select.innerHTML = '<option value="">Custom rule</option>' + list.map((preset) =>
      '<option value="' + esc(preset.name) + '">' + esc(preset.name) + "</option>"
    ).join("")
    select.value = current
    const rules = faults.faults || []
    $("fault-list").innerHTML = table(
      [
        { label: "Id", cell: (row) => esc(row.id) },
        { label: "Match", cell: (row) => esc([row.method, row.pathPrefix, row.operationId].filter(Boolean).join(" ") || "all") },
        { label: "Effect", cell: (row) => esc(row.status ?? row.effect ?? (row.drop ? "drop" : row.latencyMs || "")) }
      ],
      rules
    )
  }

  async function renderJournal() {
    const journal = await api("GET", "/requests?limit=100")
    $("journal").innerHTML = table(
      [
        { label: "When", cell: (row) => esc(row.at || "") },
        { label: "Method", cell: (row) => esc(row.method) },
        { label: "Path", cell: (row) => esc(row.path) },
        { label: "Status", cell: (row) => esc(row.status) },
        { label: "ms", cell: (row) => esc(row.durationMs) }
      ],
      journal.requests || []
    )
  }

  async function renderRoutes() {
    const data = await api("GET", "/")
    const routes = data.routes || []
    $("route-list").innerHTML = routes.map((route) => {
      const extra = STANDARD.has(route) ? "" : " <span class='badge'>extension</span>"
      return '<div class="route"><span class="method">' + esc(route.split(" ")[0]) +
        '</span><span>' + esc(route.split(" ").slice(1).join(" ")) + extra +
        '</span><button class="btn" type="button" data-route="' + esc(route) + '">Use</button></div>'
    }).join("")
  }

  const renderers = {
    overview: renderOverview,
    state: renderState,
    clock: renderClock,
    faults: renderFaults,
    journal: renderJournal,
    routes: renderRoutes
  }

  async function refresh() {
    clearError()
    if (state.view in renderers) await renderers[state.view]()
  }

  $("namespace").addEventListener("change", () => {
    state.namespace = $("namespace").value
    refresh().catch(showError)
  })
  keyInput.addEventListener("change", () => {
    state.key = keyInput.value.trim()
    sessionStorage.setItem("mockingbird-admin-key", state.key)
    refresh().catch(showError)
  })
  $("refresh").addEventListener("click", () => refresh().catch(showError))

  $("collections").addEventListener("click", (event) => {
    const button = event.target.closest("[data-collection]")
    if (!button) return
    state.collection = button.dataset.collection
    renderState().catch(showError)
  })
  $("records").addEventListener("click", (event) => {
    const row = event.target.closest("[data-id]")
    if (!row) return
    openEditor(row.dataset.id).catch(showError)
  })

  const editor = $("editor")
  async function openEditor(id) {
    state.editing = id || null
    $("editor-title").textContent = id ? "Edit record" : "New record"
    $("editor-id").value = id || ""
    $("editor-id").readOnly = Boolean(id)
    $("editor-delete").hidden = !id
    if (id) {
      const record = await api("GET", "/state/" + encodeURIComponent(state.collection) + "/" + encodeURIComponent(id))
      $("editor-value").value = JSON.stringify(record.value, null, 2)
    } else {
      $("editor-value").value = "{\\n  \\n}"
    }
    editor.showModal()
  }
  $("new-record").addEventListener("click", () => openEditor(null).catch(showError))
  $("editor-form").addEventListener("submit", (event) => {
    const submitter = event.submitter
    if (!submitter || submitter.value !== "save") return
    event.preventDefault()
    let value
    try { value = JSON.parse($("editor-value").value) }
    catch { showError(new Error("Value is not JSON")); return }
    const id = $("editor-id").value.trim()
    const path = "/state/" + encodeURIComponent(state.collection)
    const request = state.editing
      ? api("PUT", path + "/" + encodeURIComponent(id), { value })
      : api("POST", path, { id: id || undefined, value })
    request.then(() => { editor.close(); return renderState() }).catch(showError)
  })
  $("editor-delete").addEventListener("click", () => {
    const id = state.editing
    if (!id) return
    api("DELETE", "/state/" + encodeURIComponent(state.collection) + "/" + encodeURIComponent(id))
      .then(() => { editor.close(); return renderState() })
      .catch(showError)
  })

  document.querySelectorAll("[data-advance]").forEach((button) => {
    button.addEventListener("click", () => {
      api("POST", "/clock", { advance: Number(button.dataset.advance) }).then(renderClock).catch(showError)
    })
  })
  $("freeze").addEventListener("click", () => {
    const frozen = $("freeze").dataset.frozen === "1"
    api("POST", "/clock", { freeze: !frozen }).then(renderClock).catch(showError)
  })
  $("clock-reset").addEventListener("click", () => {
    api("POST", "/clock", { reset: true }).then(renderClock).catch(showError)
  })
  $("clock-set").addEventListener("submit", (event) => {
    event.preventDefault()
    const raw = $("clock-instant").value.trim()
    const set = /^-?\\d+$/.test(raw) ? Number(raw) : raw
    api("POST", "/clock", { set }).then(renderClock).catch(showError)
  })

  $("fault-form").addEventListener("submit", (event) => {
    event.preventDefault()
    const preset = $("fault-preset").value
    const body = preset
      ? { preset }
      : {
          status: Number($("fault-status").value),
          ...($("fault-path").value ? { pathPrefix: $("fault-path").value } : {}),
          ...($("fault-method").value ? { method: $("fault-method").value } : {})
        }
    if (!preset && !Number.isFinite(body.status)) {
      showError(new Error("Status must be a number, or choose a preset"))
      return
    }
    api("POST", "/faults", body).then(renderFaults).catch(showError)
  })
  $("fault-clear").addEventListener("click", () => api("DELETE", "/faults").then(renderFaults).catch(showError))
  $("journal-clear").addEventListener("click", () => api("DELETE", "/requests").then(renderJournal).catch(showError))

  $("route-list").addEventListener("click", (event) => {
    const button = event.target.closest("[data-route]")
    if (!button) return
    state.route = button.dataset.route
    $("route-title").textContent = state.route
    const method = state.route.split(" ")[0]
    $("route-body").disabled = method === "GET" || method === "DELETE"
  })
  $("route-form").addEventListener("submit", async (event) => {
    event.preventDefault()
    if (!state.route) return showError(new Error("Choose a route first"))
    const [method, path] = [state.route.split(" ")[0], state.route.split(" ").slice(1).join(" ")]
    const concrete = path.replace(/:([A-Za-z0-9_]+)/g, (_, key) => prompt("Value for " + key) || "")
    let body
    if (method !== "GET" && method !== "DELETE" && $("route-body").value.trim()) {
      try { body = JSON.parse($("route-body").value) }
      catch { return showError(new Error("Body is not JSON")) }
    }
    try {
      const data = await api(method, concrete, body)
      $("route-result").textContent = JSON.stringify(data, null, 2)
    } catch (error) {
      showError(error)
    }
  })

  function mountPanels(panels) {
    const nav = $("nav")
    const views = $("views")
    for (const panel of panels) {
      const button = document.createElement("button")
      button.type = "button"
      button.dataset.view = panel.id
      button.textContent = panel.title
      nav.append(button)
      const section = document.createElement("section")
      section.className = "view"
      section.id = "view-" + panel.id
      section.hidden = true
      const title = document.createElement("h2")
      title.textContent = panel.title
      const lede = document.createElement("p")
      lede.className = "lede"
      lede.textContent = panel.description || ""
      const body = document.createElement("div")
      body.className = "panel-body"
      body.id = "panel-" + panel.id
      body.innerHTML = panel.html || ""
      section.append(title, lede, body)
      views.append(section)
      if (panel.script) {
        try {
          const run = new Function("root", "api", panel.script)
          run(body, panelApi)
        } catch (error) {
          const note = document.createElement("p")
          note.className = "banner show"
          note.textContent = error instanceof Error ? error.message : String(error)
          body.append(note)
        }
      }
    }
  }

  loadNamespaces()
    .then(() => api("GET", "/ui/manifest"))
    .then((manifest) => { mountPanels((manifest && manifest.panels) || []); return refresh() })
    .catch(showError)
})()
</script>
</body>
</html>`
}

const htmlResponse = (body: string): Response =>
  new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  })

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8" },
  })

/** `GET /__admin/ui` plus the manifest a bespoke panel list is read from. */
export const adminUiRoutes = (service: string, ui: AdminUi | undefined): AdminRoutes => {
  const shell = () => renderAdminDocument(service)
  const document = () => (ui?.render ? ui.render({ service, defaultHtml: shell }) : shell())
  return {
    "GET /ui": () => htmlResponse(document()),
    "GET /ui/": () => htmlResponse(document()),
    "GET /ui/manifest": () =>
      json({
        service,
        panels: (ui?.panels ?? []).map((panel) => ({
          id: panel.id,
          title: panel.title,
          ...(panel.description !== undefined ? { description: panel.description } : {}),
          html: panel.html,
          ...(panel.script !== undefined ? { script: panel.script } : {}),
        })),
      }),
  }
}
