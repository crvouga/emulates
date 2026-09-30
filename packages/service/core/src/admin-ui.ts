import { CSS_RESET } from "@crvouga/mockingbird-ui"
import { adminClientSource } from "./admin-client.js"
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
 * Docs-site record of each service's logo, website, vendor API reference, and guide.
 * This address is the only brand data in the bundle. The payload is fetched when the
 * page opens, so a docs deploy updates every already-published admin.
 * `?brands=` may name a localhost or same-origin copy of that JSON.
 */
export const ADMIN_BRANDS_URL = "https://mockingbird.chrisvouga.dev/brands.json"

/**
 * The default admin document. It talks only to `/__admin/*`, so every mock can serve it.
 * Bespoke panels arrive later from `GET /ui/manifest`, which stays behind the admin key.
 * The header chip is filled from {@link ADMIN_BRANDS_URL}; nothing about a vendor is inlined.
 */
export const renderAdminDocument = (service: string): string => {
  const name = escapeHtml(service)
  const script = adminClientSource({
    standardRoutes: STANDARD_ADMIN_ROUTES,
    adminPrefix: ADMIN_PREFIX,
    adminKeyHeader: ADMIN_KEY_HEADER,
    brandsUrl: ADMIN_BRANDS_URL,
    service,
  })
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Crect width='16' height='16' rx='2' fill='%2327272a'/%3E%3C/svg%3E">
<title>${name} admin</title>
<style>
  ${CSS_RESET}
  :root {
    color-scheme: light;
    --bg: #fafafa;
    --bg-elev: #ffffff;
    --bg-muted: #f4f4f5;
    --bg-inset: #f4f4f5;
    --line: #dedee3;
    --line-strong: #c4c4cc;
    --ink: #18181b;
    --muted: #62626b;
    --faint: #71717a;
    --accent: #27272a;
    --accent-ink: #ffffff;
    --accent-soft: #f4f4f5;
    --ok: #166534;
    --ok-soft: #f0fdf4;
    --warn: #a16207;
    --warn-soft: #fefce8;
    --err: #a82d32;
    --err-soft: #fef2f2;
    --shadow: none;
    --sans: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    --mono: ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, monospace;
    --radius: 10px;
    --header: 56px;
    --nav: 200px;
  }
  :root[data-theme="dark"] {
    color-scheme: dark;
    --bg: #111113;
    --bg-elev: #19191c;
    --bg-muted: #242428;
    --bg-inset: #111113;
    --line: #36363c;
    --line-strong: #52525b;
    --ink: #f4f4f5;
    --muted: #a9a9b2;
    --faint: #71717a;
    --accent: #e4e4e7;
    --accent-ink: #18181b;
    --accent-soft: #242428;
    --ok: #86efac;
    --ok-soft: #14241b;
    --warn: #fde68a;
    --warn-soft: #2a2410;
    --err: #ffaaaa;
    --err-soft: #2c1516;
    --shadow: none;
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      color-scheme: dark;
      --bg: #111113;
      --bg-elev: #19191c;
      --bg-muted: #242428;
      --bg-inset: #111113;
      --line: #36363c;
      --line-strong: #52525b;
      --ink: #f4f4f5;
      --muted: #a9a9b2;
      --faint: #71717a;
      --accent: #e4e4e7;
      --accent-ink: #18181b;
      --accent-soft: #242428;
      --ok: #86efac;
      --ok-soft: #14241b;
      --warn: #fde68a;
      --warn-soft: #2a2410;
      --err: #ffaaaa;
      --err-soft: #2c1516;
      --shadow: none;
    }
  }
  /* Fill the viewport, then grow with the content so the background covers the scroll. */
  html { height: 100%; }
  body {
    margin: 0;
    min-height: 100%;
    display: flex;
    flex-direction: column;
    font-family: var(--sans);
    background: var(--bg);
    color: var(--ink);
    line-height: 1.45;
    padding-left: env(safe-area-inset-left);
    padding-right: env(safe-area-inset-right);
    -webkit-text-size-adjust: 100%;
  }
  :focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .app { flex: 1 0 auto; display: flex; flex-direction: column; min-width: 0; width: 100%; }
  header.top {
    position: sticky; top: 0; z-index: 5;
    display: flex; align-items: center; gap: 12px;
    min-height: var(--header); padding: 10px 16px;
    background: var(--bg-elev);
    border-bottom: 1px solid var(--line);
    min-width: 0; max-width: 100%;
  }
  .brand {
    display: flex; flex-flow: row wrap; align-items: center; gap: 14px;
    min-width: 0; max-width: 100%; margin-right: auto;
  }
  .brand-id { display: flex; flex-direction: column; min-width: 0; flex: none; }
  .brand-id strong { font-size: 15px; letter-spacing: -0.01em; }
  .brand-id span { color: var(--faint); font-size: 12px; }
  .vendor {
    display: flex; flex-wrap: wrap; align-items: center; gap: 6px;
    min-width: 0; max-width: 100%; font-size: 12px; color: var(--muted);
  }
  .vendor[hidden] { display: none; }
  /* Logos are drawn for a light tile, same as the docs site, so the plate stays white. */
  .vendor img {
    width: 16px; height: 16px; padding: 2px; box-sizing: content-box;
    border-radius: 4px; border: 1px solid var(--line); background: #fff; object-fit: contain;
  }
  .vendor-name { color: var(--ink); font-weight: 600; }
  .vendor-sep { color: var(--faint); }
  .vendor-link { color: inherit; text-decoration: none; }
  .vendor-link:hover { color: var(--ink); text-decoration: underline; }
  .controls { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
  label.field { display: flex; flex-direction: column; gap: 2px; font-size: 11px; color: var(--faint); }
  label.field input, label.field select, .controls input[type="password"] {
    background-color: var(--bg-inset); border: 1px solid var(--line); border-radius: 8px;
    padding: 7px 8px; min-height: 36px; line-height: 1.2;
  }
  /* A native menu ignores min-height, so Preset rendered about half as tall as
     the text fields in the same form. Paint it like those fields. */
  label.field select {
    -webkit-appearance: none; appearance: none;
    padding-right: 28px;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath fill='none' stroke='%2371717a' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round' d='M2.5 4.5 6 8l3.5-3.5'/%3E%3C/svg%3E");
    background-repeat: no-repeat; background-position: right 10px center; background-size: 12px 12px;
  }
  .stack > .field > input,
  .stack > .field > select,
  .stack > .field > textarea,
  dialog .field > input,
  dialog .field > select,
  dialog .field > textarea { width: 100%; }
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
    flex: 1 0 auto; min-width: 0;
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
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 180px), 1fr)); gap: 12px; }
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
    border: 1px solid var(--line); border-radius: var(--radius); padding: 0; background: var(--bg-elev);
    color: var(--ink); width: min(640px, calc(100% - 24px)); max-width: calc(100vw - 24px); box-shadow: none;
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
    .brand, .vendor, .controls { width: 100%; }
    label.field, label.field select, label.field input { flex: 1; min-width: 0; }
    /* The layout fills the screen. A single-column grid stretches every auto
       row, so the tab bar grew with the leftover height and the buttons floated
       in the middle of it. The bar stays one row; the page below takes the rest. */
    .layout {
      grid-template-columns: minmax(0, 1fr);
      grid-template-rows: auto minmax(0, 1fr);
      align-content: start;
    }
    nav.side {
      align-self: start; height: auto;
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
      <div class="brand-id">
        <strong>${name}</strong>
        <span>Admin</span>
      </div>
      <div class="vendor" id="vendor" hidden></div>
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
${script}
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
