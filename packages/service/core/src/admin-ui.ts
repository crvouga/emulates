import { CSS_RESET } from "@crvouga/mockingbird-ui"
import { adminClientSource } from "./admin-client.js"
import type { AdminRoutes } from "./control.js"
import { ADMIN_KEY_HEADER, ADMIN_PREFIX } from "./control.js"
import type { AdminExtension, AdminUi } from "./surface.js"
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
export const renderAdminDocument = (service: string, adminPrefix = ADMIN_PREFIX): string => {
  const name = escapeHtml(service)
  const script = adminClientSource({
    standardRoutes: STANDARD_ADMIN_ROUTES,
    adminPrefix,
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
    --bg: #f7f8fb;
    --bg-elev: #ffffff;
    --bg-muted: #f1f3f7;
    --bg-inset: #f8f9fc;
    --line: #e4e7ec;
    --line-strong: #cfd4dc;
    --ink: #101828;
    --muted: #475467;
    --faint: #667085;
    --accent: #6941c6;
    --accent-hover: #5933b4;
    --accent-ink: #ffffff;
    --accent-soft: #f4f0ff;
    --ok: #067647;
    --ok-soft: #ecfdf3;
    --warn: #b54708;
    --warn-soft: #fffaeb;
    --err: #b42318;
    --err-soft: #fef3f2;
    --code-key: #6941c6;
    --code-string: #067647;
    --code-number: #175cd3;
    --code-boolean: #c11574;
    --code-null: #667085;
    --shadow-xs: 0 1px 2px rgb(16 24 40 / 0.05);
    --shadow-sm: 0 1px 3px rgb(16 24 40 / 0.08), 0 1px 2px rgb(16 24 40 / 0.04);
    --shadow-lg: 0 18px 48px rgb(16 24 40 / 0.16), 0 4px 12px rgb(16 24 40 / 0.08);
    --sans: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    --mono: ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, monospace;
    --radius: 12px;
    --header: 72px;
    --nav: 224px;
  }
  :root[data-theme="dark"] {
    color-scheme: dark;
    --bg: #0c0e14;
    --bg-elev: #151821;
    --bg-muted: #20232e;
    --bg-inset: #11141c;
    --line: #2b303d;
    --line-strong: #414858;
    --ink: #f5f7fa;
    --muted: #b6bdc9;
    --faint: #8d96a7;
    --accent: #9e77ed;
    --accent-hover: #b692f6;
    --accent-ink: #ffffff;
    --accent-soft: #2b2142;
    --ok: #75e0a7;
    --ok-soft: #102a20;
    --warn: #fec84b;
    --warn-soft: #302611;
    --err: #fda29b;
    --err-soft: #321817;
    --code-key: #c3a6ff;
    --code-string: #75e0a7;
    --code-number: #84adff;
    --code-boolean: #f9a8d4;
    --code-null: #98a2b3;
    --shadow-xs: 0 1px 2px rgb(0 0 0 / 0.24);
    --shadow-sm: 0 4px 12px rgb(0 0 0 / 0.2);
    --shadow-lg: 0 20px 56px rgb(0 0 0 / 0.45);
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      color-scheme: dark;
      --bg: #0c0e14;
      --bg-elev: #151821;
      --bg-muted: #20232e;
      --bg-inset: #11141c;
      --line: #2b303d;
      --line-strong: #414858;
      --ink: #f5f7fa;
      --muted: #b6bdc9;
      --faint: #8d96a7;
      --accent: #9e77ed;
      --accent-hover: #b692f6;
      --accent-ink: #ffffff;
      --accent-soft: #2b2142;
      --ok: #75e0a7;
      --ok-soft: #102a20;
      --warn: #fec84b;
      --warn-soft: #302611;
      --err: #fda29b;
      --err-soft: #321817;
      --code-key: #c3a6ff;
      --code-string: #75e0a7;
      --code-number: #84adff;
      --code-boolean: #f9a8d4;
      --code-null: #98a2b3;
      --shadow-xs: 0 1px 2px rgb(0 0 0 / 0.24);
      --shadow-sm: 0 4px 12px rgb(0 0 0 / 0.2);
      --shadow-lg: 0 20px 56px rgb(0 0 0 / 0.45);
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
  ::selection { background: color-mix(in srgb, var(--accent) 28%, transparent); }
  :focus-visible { outline: 3px solid color-mix(in srgb, var(--accent) 45%, transparent); outline-offset: 2px; }
  button, input, select, textarea { transition: border-color 140ms ease, box-shadow 140ms ease, background 140ms ease, color 140ms ease, transform 100ms ease; }
  button:disabled, input:disabled, select:disabled, textarea:disabled { cursor: not-allowed; opacity: 0.55; }
  .app { flex: 1 0 auto; display: flex; flex-direction: column; min-width: 0; width: 100%; }
  header.top {
    position: sticky; top: 0; z-index: 20;
    display: flex; align-items: center; gap: 12px;
    min-height: var(--header); padding: 12px 20px;
    background: color-mix(in srgb, var(--bg-elev) 92%, transparent);
    backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px);
    border-bottom: 1px solid var(--line);
    min-width: 0; max-width: 100%;
  }
  .brand {
    display: flex; flex-flow: row wrap; align-items: center; gap: 14px;
    min-width: 0; max-width: 100%; margin-right: auto;
  }
  .brand-lockup { display: flex; align-items: center; gap: 10px; min-width: 0; }
  .brand-mark {
    width: 38px; height: 38px; display: grid; place-items: center; flex: none;
    border-radius: 11px; color: #fff;
    background: linear-gradient(145deg, #7f56d9 0%, #53389e 100%);
    box-shadow: 0 6px 16px rgb(105 65 198 / 0.24), inset 0 1px 0 rgb(255 255 255 / 0.25);
  }
  .brand-mark svg { width: 22px; height: 22px; }
  .brand-id { display: flex; flex-direction: column; min-width: 0; flex: none; line-height: 1.25; }
  .brand-id strong { font-size: 15px; letter-spacing: -0.015em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .brand-id span { color: var(--faint); font-size: 12px; }
  .vendor {
    display: flex; flex-wrap: wrap; align-items: center; gap: 6px;
    min-width: 0; max-width: 100%; font-size: 12px; color: var(--muted);
    padding: 5px 8px; border: 1px solid var(--line); border-radius: 999px; background: var(--bg-inset);
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
  .controls { display: flex; flex-wrap: wrap; gap: 8px; align-items: flex-end; }
  .sync-status { align-self: center; display: flex; align-items: center; gap: 6px; color: var(--faint); font-size: 12px; white-space: nowrap; }
  .sync-status::before { content: ""; width: 7px; height: 7px; border-radius: 50%; background: var(--ok); box-shadow: 0 0 0 3px var(--ok-soft); }
  .sync-status.busy::before { background: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); animation: pulse 1.2s ease-in-out infinite; }
  label.field { display: flex; flex-direction: column; gap: 4px; font-size: 11px; font-weight: 600; color: var(--faint); }
  label.field input, label.field select, .controls input[type="password"] {
    background-color: var(--bg-elev); border: 1px solid var(--line-strong); border-radius: 9px;
    padding: 8px 10px; min-height: 38px; line-height: 1.2; box-shadow: var(--shadow-xs);
  }
  label.field input:hover, label.field select:hover, textarea:hover { border-color: color-mix(in srgb, var(--accent) 38%, var(--line-strong)); }
  label.field input:focus, label.field select:focus, textarea:focus { border-color: var(--accent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 15%, transparent); outline: none; }
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
  .icon-btn, .btn, .btn-primary, .btn-quiet, .btn-danger, nav.side button { cursor: pointer; }
  .icon-btn, .btn, .btn-primary, .btn-quiet, .btn-danger {
    display: inline-flex; align-items: center; justify-content: center; gap: 7px;
    border-radius: 9px; min-height: 38px; padding: 0 13px; border: 1px solid var(--line-strong);
    background: var(--bg-elev); color: var(--ink); font-size: 13px; font-weight: 600; line-height: 1;
    box-shadow: var(--shadow-xs);
  }
  .icon-btn { width: 38px; padding: 0; }
  .icon-btn svg, .btn svg, .btn-primary svg { width: 16px; height: 16px; }
  .icon-btn:hover, .btn:hover { background: var(--bg-muted); border-color: var(--line-strong); }
  .btn-primary { background: var(--accent); color: var(--accent-ink); border-color: var(--accent); box-shadow: 0 1px 2px rgb(16 24 40 / 0.08), 0 0 0 1px rgb(255 255 255 / 0.08) inset; }
  .btn-primary:hover { background: var(--accent-hover); border-color: var(--accent-hover); }
  .btn-quiet { background: transparent; border-color: transparent; box-shadow: none; }
  .btn-quiet:hover { background: var(--bg-muted); }
  .btn-danger { color: var(--err); border-color: color-mix(in srgb, var(--err) 25%, var(--line)); }
  .btn-danger:hover, .btn-danger.confirming { background: var(--err-soft); border-color: color-mix(in srgb, var(--err) 45%, var(--line)); }
  /* Held after mouseup. Clearing an empty journal changes nothing on screen,
     so the press itself has to stay visible. */
  .icon-btn:active, .btn:active, .btn-quiet:active, .btn-danger:active, nav.side button:active,
  .icon-btn.pressed, .btn.pressed, .btn-quiet.pressed, .btn-danger.pressed, nav.side button.pressed {
    background: var(--bg-inset); border-color: var(--line-strong); color: var(--ink);
  }
  .btn-danger:active, .btn-danger.pressed { background: var(--err-soft); color: var(--err); }
  .btn-primary:active, .btn-primary.pressed { filter: brightness(0.88); color: var(--accent-ink); }
  /* minmax(0, 1fr): a 1fr column will not shrink below its content, so a long
     record or the full nav row would widen the page past the viewport. */
  .layout {
    display: grid; grid-template-columns: var(--nav) minmax(0, 1fr);
    flex: 1 0 auto; min-width: 0;
  }
  nav.side {
    position: sticky; top: var(--header); align-self: start; height: calc(100vh - var(--header));
    border-right: 1px solid var(--line); padding: 18px 12px;
    display: flex; flex-direction: column; gap: 4px;
    background: var(--bg-elev); overflow-y: auto;
  }
  .nav-label { padding: 0 10px 8px; color: var(--faint); font-size: 10px; font-weight: 700; letter-spacing: 0.09em; text-transform: uppercase; }
  nav.side button {
    position: relative; display: flex; align-items: center; gap: 10px; width: 100%;
    text-align: left; border: 0; background: transparent; border-radius: 9px;
    padding: 9px 10px; min-height: 42px; color: var(--muted); font-size: 13px; font-weight: 550;
  }
  nav.side button:hover { background: var(--bg-muted); color: var(--ink); }
  nav.side button[aria-current="true"] { background: var(--accent-soft); color: var(--accent); font-weight: 650; }
  nav.side button[aria-current="true"]::before { content: ""; position: absolute; left: -12px; width: 3px; height: 22px; border-radius: 0 4px 4px 0; background: var(--accent); }
  .nav-icon { width: 18px; height: 18px; display: grid; place-items: center; flex: none; }
  .nav-icon svg { width: 18px; height: 18px; }
  main { padding: 32px clamp(20px, 4vw, 48px) 64px; max-width: 1320px; width: 100%; min-width: 0; }
  main[aria-busy="true"] .view { opacity: 0.62; }
  .view { animation: view-in 180ms ease-out; }
  .view[hidden] { display: none; }
  .view-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; margin-bottom: 22px; }
  .view h2 { margin: 0 0 5px; font-size: clamp(24px, 3vw, 30px); line-height: 1.2; letter-spacing: -0.035em; }
  .view h3 { margin: 24px 0 10px; font-size: 15px; letter-spacing: -0.01em; }
  .lede { margin: 0; color: var(--muted); max-width: 72ch; font-size: 14px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 175px), 1fr)); gap: 14px; }
  .card {
    background: var(--bg-elev); border: 1px solid var(--line); border-radius: var(--radius);
    padding: 18px; box-shadow: var(--shadow-sm);
  }
  .stat-card { position: relative; overflow: hidden; }
  .stat-card::after { content: ""; position: absolute; inset: 0 0 auto; height: 2px; background: linear-gradient(90deg, var(--accent), transparent 78%); opacity: 0.7; }
  .card .k { color: var(--faint); font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.07em; }
  .card .v { display: flex; flex-direction: column; gap: 2px; font-size: 24px; font-weight: 650; margin-top: 7px; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; letter-spacing: -0.025em; }
  .card .v .clock-time { font-size: 14px; color: var(--muted); }
  .section-card { background: var(--bg-elev); border: 1px solid var(--line); border-radius: var(--radius); box-shadow: var(--shadow-xs); overflow: hidden; }
  .section-title { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 16px 18px; border-bottom: 1px solid var(--line); }
  .section-title h3 { margin: 0; }
  .split { display: grid; grid-template-columns: minmax(0, 250px) minmax(0, 1fr); gap: 18px; align-items: start; }
  #collections { padding: 6px; border: 1px solid var(--line); border-radius: var(--radius); background: var(--bg-elev); box-shadow: var(--shadow-xs); }
  .collection {
    width: 100%; text-align: left; border: 1px solid transparent; background: transparent;
    border-radius: 9px; padding: 10px 11px; min-height: 48px; color: var(--ink); cursor: pointer;
  }
  .collection:hover { background: var(--bg-muted); }
  .collection[aria-current="true"] { background: var(--accent-soft); border-color: color-mix(in srgb, var(--accent) 18%, var(--line)); color: var(--accent); }
  .collection small { display: block; color: var(--faint); }
  .chips { display: flex; flex-wrap: wrap; gap: 6px; margin: 8px 0 14px; }
  .chip { font-family: var(--mono); font-size: 11px; background: var(--bg-muted); border: 1px solid var(--line); border-radius: 999px; padding: 4px 8px; }
  .chip i { color: var(--faint); font-style: normal; }
  .sql-layout {
    display: grid; grid-template-columns: minmax(10rem, 16rem) minmax(0, 1fr); gap: 16px;
  }
  .sql-tables { display: flex; flex-direction: column; gap: 4px; max-height: 28rem; overflow: auto; padding: 6px; border: 1px solid var(--line); border-radius: var(--radius); background: var(--bg-elev); }
  .sql-tables button { text-align: left; border: 0; border-radius: 8px; padding: 9px 10px; background: transparent; color: var(--muted); cursor: pointer; }
  .sql-tables button:hover, .sql-tables button[aria-current="true"] { background: var(--accent-soft); color: var(--accent); }
  .sql-input { font-family: var(--mono); min-height: 7rem; width: 100%; }
  .table-shell { width: 100%; overflow-x: auto; border: 1px solid var(--line); border-radius: var(--radius); background: var(--bg-elev); box-shadow: var(--shadow-xs); }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 11px 13px; border-bottom: 1px solid var(--line); vertical-align: top; }
  th { color: var(--faint); background: var(--bg-inset); font-weight: 650; font-size: 11px; text-transform: uppercase; letter-spacing: 0.045em; }
  tbody tr:last-child td { border-bottom: 0; }
  tr.clickable { cursor: pointer; }
  tr.clickable:hover { background: var(--accent-soft); }
  pre, code, .mono { font-family: var(--mono); overflow-wrap: anywhere; }
  pre {
    margin: 0; white-space: pre-wrap; word-break: break-word;
    background: var(--bg-inset); border: 1px solid var(--line); border-radius: 10px; padding: 14px; font-size: 12px; line-height: 1.65;
  }
  .json-key { color: var(--code-key); }
  .json-string { color: var(--code-string); }
  .json-number { color: var(--code-number); }
  .json-boolean { color: var(--code-boolean); }
  .json-null { color: var(--code-null); font-style: italic; }
  .json-inline { display: block; max-width: 44rem; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .json-view { position: relative; max-height: 26rem; overflow: auto; }
  .json-editor { position: relative; min-height: 190px; border: 1px solid var(--line-strong); border-radius: 10px; background: var(--bg-inset); overflow: hidden; }
  .json-editor:focus-within { border-color: var(--accent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 15%, transparent); }
  .json-editor.invalid { border-color: var(--err); }
  .json-editor pre, .json-editor textarea { margin: 0; padding: 12px; border: 0; border-radius: 0; min-height: 190px; width: 100%; font: 12px/1.65 var(--mono); tab-size: 2; white-space: pre; overflow: auto; }
  .json-editor pre { position: absolute; inset: 0; pointer-events: none; background: transparent; }
  .json-editor textarea { position: relative; z-index: 1; resize: vertical; background: transparent; color: transparent; caret-color: var(--ink); -webkit-text-fill-color: transparent; }
  .json-editor textarea::selection { background: color-mix(in srgb, var(--accent) 32%, transparent); }
  .editor-meta { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-top: 7px; }
  .json-status { display: inline-flex; align-items: center; gap: 6px; color: var(--ok); font-size: 11px; }
  .json-status::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
  .json-status.invalid { color: var(--err); }
  .format-json { border: 0; padding: 3px 5px; background: transparent; color: var(--accent); font-size: 11px; font-weight: 650; cursor: pointer; }
  .row-actions { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 8px; margin: 14px 0; }
  .banner {
    display: none; position: sticky; top: calc(var(--header) + 12px); z-index: 15;
    align-items: center; gap: 10px; margin: 0 0 16px; padding: 11px 12px 11px 14px;
    border: 1px solid color-mix(in srgb, var(--err) 30%, var(--line)); border-radius: 10px;
    background: var(--err-soft); color: var(--err); box-shadow: var(--shadow-sm); font-size: 13px;
  }
  .banner.show { display: flex; }
  .banner span { flex: 1; }
  .banner button { width: 28px; height: 28px; display: grid; place-items: center; border: 0; border-radius: 7px; background: transparent; color: currentColor; cursor: pointer; }
  .banner button:hover { background: color-mix(in srgb, var(--err) 10%, transparent); }
  .empty { color: var(--muted); padding: 34px 18px; text-align: center; border: 1px dashed var(--line-strong); border-radius: var(--radius); background: color-mix(in srgb, var(--bg-elev) 55%, transparent); }
  dialog {
    border: 1px solid var(--line); border-radius: 16px; padding: 0; background: var(--bg-elev);
    color: var(--ink); width: min(720px, calc(100% - 24px)); max-width: calc(100vw - 24px); box-shadow: var(--shadow-lg);
  }
  dialog[open] { animation: dialog-in 160ms ease-out; }
  dialog::backdrop { background: rgb(12 14 20 / 0.58); backdrop-filter: blur(3px); }
  dialog form, .dialog-body { padding: 22px; display: flex; flex-direction: column; gap: 14px; }
  .dialog-heading { display: flex; justify-content: space-between; gap: 16px; padding-bottom: 12px; border-bottom: 1px solid var(--line); }
  .dialog-heading strong { font-size: 18px; letter-spacing: -0.02em; }
  .dialog-heading span { color: var(--muted); font-size: 12px; }
  textarea {
    width: 100%; min-height: 180px; resize: vertical; border-radius: 10px;
    border: 1px solid var(--line); background: var(--bg-inset); padding: 10px;
    font-family: var(--mono); font-size: 12px;
  }
  .dialog-actions { display: flex; justify-content: flex-end; align-items: center; gap: 8px; padding-top: 4px; }
  .dialog-actions .btn-danger { margin-right: auto; }
  .badge { display: inline-flex; align-items: center; font-size: 10px; font-weight: 700; letter-spacing: 0.03em; border: 1px solid var(--line); border-radius: 999px; padding: 3px 7px; background: var(--bg-muted); color: var(--muted); }
  .badge.ok { background: var(--ok-soft); color: var(--ok); }
  .badge.warn { background: var(--warn-soft); color: var(--warn); }
  .status-2 { color: var(--ok); }
  .status-4, .status-5, .status-0 { color: var(--err); }
  .stack { display: flex; flex-direction: column; gap: 12px; }
  .form-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
  .form-grid .wide { grid-column: span 2; }
  .route {
    display: grid; grid-template-columns: 84px minmax(0, 1fr) auto; gap: 10px; align-items: center;
    padding: 10px 12px; border-bottom: 1px solid var(--line); background: var(--bg-elev);
  }
  .route:first-child { border-radius: var(--radius) var(--radius) 0 0; }
  .route:last-child { border-bottom: 0; border-radius: 0 0 var(--radius) var(--radius); }
  #route-list { border: 1px solid var(--line); border-radius: var(--radius); overflow: hidden; box-shadow: var(--shadow-xs); }
  .method { width: fit-content; font-family: var(--mono); font-size: 11px; font-weight: 750; color: var(--accent); background: var(--accent-soft); border-radius: 6px; padding: 4px 6px; }
  @keyframes view-in { from { transform: translateY(3px); } to { transform: translateY(0); } }
  @keyframes dialog-in { from { transform: translateY(8px) scale(0.99); } to { transform: translateY(0) scale(1); } }
  @keyframes pulse { 50% { opacity: 0.45; } }
  @media (prefers-reduced-motion: reduce) { *, *::before, *::after { scroll-behavior: auto !important; animation-duration: 0.01ms !important; transition-duration: 0.01ms !important; } }
  @media (forced-colors: active) { .json-editor pre { display: none; } .json-editor textarea { color: CanvasText; -webkit-text-fill-color: CanvasText; } }
  @media (max-width: 800px) {
    :root { --header: 0px; }
    header.top {
      position: relative; align-items: stretch; flex-direction: column;
      padding: max(12px, env(safe-area-inset-top)) 14px 12px;
    }
    input, select, textarea { font-size: 16px; }
    .brand, .vendor, .controls { width: 100%; }
    .brand { gap: 10px; }
    .vendor { order: 2; border-radius: 9px; }
    label.field, label.field select, label.field input { flex: 1; min-width: 0; }
    .sync-status { display: none; }
    /* The layout fills the screen. A single-column grid stretches every auto
       row, so the tab bar grew with the leftover height and the buttons floated
       in the middle of it. The bar stays one row; the page below takes the rest. */
    .layout {
      grid-template-columns: minmax(0, 1fr);
      grid-template-rows: auto minmax(0, 1fr);
      align-content: start;
    }
    nav.side {
      position: sticky; top: 0; z-index: 12; align-self: start; height: auto;
      flex-direction: row; align-items: center; overflow-x: auto; min-width: 0;
      border-right: 0; border-bottom: 1px solid var(--line);
      padding: 8px; box-shadow: var(--shadow-xs);
    }
    .nav-label { display: none; }
    nav.side button { width: auto; white-space: nowrap; flex: none; }
    nav.side button[aria-current="true"]::before { inset: auto 9px -8px; width: auto; height: 3px; border-radius: 3px 3px 0 0; }
    .split, .sql-layout { grid-template-columns: minmax(0, 1fr); }
    .form-grid { grid-template-columns: minmax(0, 1fr); }
    .form-grid .wide { grid-column: auto; }
    main { padding: 22px 14px 48px; }
    .view-head { margin-bottom: 18px; }
    .grid { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
    .card { padding: 14px; }
    .card .v { font-size: 20px; }
    .table-shell { border: 0; background: transparent; box-shadow: none; overflow: visible; }
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
  @media (max-width: 460px) {
    .controls label.field { min-width: calc(50% - 4px); }
    .controls .icon-btn, .controls .btn { flex: 1; }
    .grid { grid-template-columns: minmax(0, 1fr); }
    .dialog-actions { flex-wrap: wrap; }
    .dialog-actions button { flex: 1; }
    .dialog-actions .btn-danger { flex-basis: 100%; margin-right: 0; }
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
            <div class="json-editor" id="route-editor" hidden>
              <pre aria-hidden="true"><code id="route-highlight"></code></pre>
              <textarea id="route-body" placeholder="{ }" spellcheck="false" aria-describedby="route-json-status" disabled></textarea>
            </div>
            <span class="editor-meta" hidden><span class="json-status" id="route-json-status">Valid JSON</span><button class="format-json" type="button" data-format="route-body">Format JSON</button></span>
          </label>
          <div class="dialog-actions">
            <button class="btn-primary" id="route-send" type="submit" disabled>Send request</button>
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

const describeExtension = (extension: AdminExtension): Record<string, unknown> => {
  if (extension.kind === "sql") {
    return {
      kind: "sql",
      id: extension.id ?? "sql",
      title: extension.title ?? "SQL",
      ...(extension.description !== undefined ? { description: extension.description } : {}),
    }
  }
  return {
    kind: "panel",
    id: extension.id,
    title: extension.title,
    ...(extension.description !== undefined ? { description: extension.description } : {}),
    html: extension.html,
    ...(extension.script !== undefined ? { script: extension.script } : {}),
  }
}

/** `GET /__admin/ui` plus the manifest a bespoke panel list is read from. */
export const adminUiRoutes = (
  service: string,
  ui: AdminUi | undefined,
  adminPrefix = ADMIN_PREFIX,
): AdminRoutes => {
  const shell = () => renderAdminDocument(service, adminPrefix)
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
        extensions: (ui?.extensions ?? []).map(describeExtension),
      }),
  }
}
