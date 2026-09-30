/**
 * Plain CSS for the example app. Inlined by both run modes: the standalone
 * dev server embeds it in its HTML shell, and `src/browser.ts` injects it
 * as a `<style>` element scoped under `.cove-app` when mounted on the docs
 * site, so it never leaks into the docs site's own `global.css`.
 *
 * System fonts only. A web-font request would be a real network call.
 */
import { scopeReset } from "@crvouga/mockingbird-ui"

export const STYLES = `
${scopeReset(".cove-app")}
.cove-app {
  --cove-ink: light-dark(#18181b, #f4f4f5);
  --cove-brand: light-dark(#18181b, #f4f4f5);
  --cove-primary: light-dark(#27272a, #e4e4e7);
  --cove-primary-hover: light-dark(#3f3f46, #f4f4f5);
  --cove-on-brand: light-dark(#fff, #18181b);
  --cove-accent: light-dark(#27272a, #e4e4e7);
  --cove-accent-hover: light-dark(#3f3f46, #f4f4f5);
  --cove-bg: light-dark(#fafafa, #111113);
  --cove-panel: light-dark(#f4f4f5, #242428);
  --cove-surface: light-dark(#ffffff, #19191c);
  --cove-border: light-dark(#dedee3, #36363c);
  --cove-muted: light-dark(#62626b, #a9a9b2);
  --cove-danger: light-dark(#a82d32, #ffaaaa);
  --cove-danger-bg: light-dark(#fef2f2, #2c1516);
  --cove-success: light-dark(#166534, #86efac);
  --cove-success-bg: light-dark(#f0fdf4, #14241b);
  --cove-warn: light-dark(#a16207, #fde68a);
  --cove-warn-bg: light-dark(#fefce8, #2a2410);
  --cove-radius-sm: 8px;
  --cove-radius: 10px;
  --cove-radius-lg: 10px;
  --cove-shadow: none;
  --cove-font: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;

  all: initial;
  color-scheme: light dark;
  display: flex;
  flex-direction: column;
  font-family: var(--cove-font);
  color: var(--cove-ink);
  background: var(--cove-bg);
  height: 100%;
  overflow: hidden;
  line-height: 1.5;
  -webkit-font-smoothing: antialiased;
}

/* :where() keeps these resets from outranking a class. A plain
   ".cove-app button" would beat .cove-btn-primary and leave dark type on the dark fill. */
.cove-app :where(a) { color: inherit; }
.cove-app :where(button) { font-family: inherit; color: inherit; cursor: pointer; }
.cove-app :focus-visible { outline: 2px solid var(--cove-primary); outline-offset: 2px; }

.cove-shell { flex: 1; min-height: 0; display: flex; flex-direction: column; }

/* ---- Top nav ---- */
.cove-nav {
  display: flex;
  align-items: center;
  gap: 1.5rem;
  padding: 0.9rem 1.5rem;
  border-bottom: 1px solid var(--cove-border);
  background: var(--cove-surface);
  position: sticky;
  top: 0;
  z-index: 10;
}
.cove-nav-links { display: flex; align-items: center; gap: 0.25rem; }
.cove-nav-link {
  font-size: 0.92rem;
  font-weight: 600;
  color: var(--cove-muted);
  text-decoration: none;
  padding: 0.5rem 0.75rem;
  border-radius: var(--cove-radius-sm);
}
.cove-nav-link:hover { background: var(--cove-panel); color: var(--cove-ink); }
.cove-nav-link.is-active { color: var(--cove-brand); background: var(--cove-panel); }
.cove-spacer { flex: 1; }
.cove-nav-user {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  max-width: 16rem;
  background: none;
  border: 1px solid transparent;
  border-radius: 999px;
  padding: 0.25rem 0.75rem 0.25rem 0.25rem;
  appearance: none;
}
.cove-nav-user:hover { border-color: var(--cove-border); background: var(--cove-panel); }
.cove-nav-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 0.85rem;
  font-weight: 600;
  color: var(--cove-muted);
}
.cove-avatar {
  width: 30px;
  height: 30px;
  border-radius: 999px;
  background: var(--cove-primary);
  color: var(--cove-on-brand);
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 700;
  font-size: 0.8rem;
  overflow: hidden;
  flex-shrink: 0;
}
.cove-avatar img { width: 100%; height: 100%; object-fit: cover; }

/* ---- Logo ---- */
.cove-logo { display: inline-flex; align-items: center; gap: 0.5rem; text-decoration: none; color: var(--cove-brand); }
.cove-logo-word { font-size: 1.15rem; font-weight: 800; letter-spacing: -0.02em; }
.cove-logo-tagline { display: block; font-size: 0.72rem; font-weight: 500; color: var(--cove-muted); margin-top: -2px; }

/* ---- Layout ---- */
.cove-main { flex: 1; min-height: 0; overflow: auto; padding: 2.5rem 1.5rem 4rem; }
.cove-main.is-shop { overflow: hidden; display: flex; flex-direction: column; padding-bottom: 1.25rem; }
.cove-container { max-width: 760px; margin: 0 auto; }
.cove-container.is-shop {
  flex: 1;
  min-height: 0;
  width: min(760px, 100%);
  display: flex;
  flex-direction: column;
}
.cove-container-wide { max-width: 1040px; margin: 0 auto; }

/* ---- Cards / surfaces ---- */
.cove-card {
  background: var(--cove-surface);
  border: 1px solid var(--cove-border);
  border-radius: var(--cove-radius-lg);
  box-shadow: var(--cove-shadow);
  padding: 1.75rem;
}
.cove-panel { background: var(--cove-panel); border-radius: var(--cove-radius); padding: 1.25rem; }

/* ---- Typography ---- */
.cove-app :where(h1) { font-size: 1.7rem; font-weight: 800; letter-spacing: -0.01em; margin: 0 0 0.5rem; }
.cove-app :where(h2) { font-size: 1.2rem; font-weight: 700; margin: 0 0 0.5rem; }
.cove-app :where(p) { margin: 0 0 0.75rem; color: var(--cove-ink); }
.cove-muted { color: var(--cove-muted); }
.cove-lede { margin: 0 0 1.35rem; color: var(--cove-muted); max-width: 62ch; }
.cove-eyebrow { font-size: 0.75rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: var(--cove-primary); }
.cove-card-gap { margin-bottom: 1rem; }

/* ---- Buttons ---- */
.cove-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.5rem;
  padding: 0.7rem 1.1rem;
  border-radius: var(--cove-radius-sm);
  border: 1px solid transparent;
  font-weight: 700;
  font-size: 0.92rem;
  cursor: pointer;
  text-decoration: none;
  transition: transform 0.08s ease, box-shadow 0.08s ease;
}
.cove-btn:active { transform: translateY(1px); }
.cove-btn:disabled { opacity: 0.55; cursor: default; transform: none; }
.cove-btn-primary { background: var(--cove-primary); color: var(--cove-on-brand); }
.cove-btn-primary:hover:not(:disabled) { background: var(--cove-primary-hover); }
.cove-btn-accent { background: var(--cove-accent); color: var(--cove-on-brand); }
.cove-btn-accent:hover:not(:disabled) { background: var(--cove-accent-hover); }
.cove-btn-ghost { background: transparent; color: var(--cove-primary); border-color: var(--cove-border); }
.cove-btn-ghost:hover:not(:disabled) { background: var(--cove-panel); }
.cove-btn-link { background: none; border: none; color: var(--cove-primary); font-weight: 600; padding: 0; cursor: pointer; text-decoration: underline; }
.cove-btn-block { width: 100%; }

.cove-oauth-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  padding: 0.75rem 1rem;
  border-radius: var(--cove-radius-sm);
  font-weight: 600;
  font-size: 0.95rem;
  cursor: pointer;
  border: 1px solid var(--cove-border);
  background: var(--cove-surface);
  color: var(--cove-ink);
}
.cove-oauth-btn:hover:not(:disabled) { background: var(--cove-panel); }
.cove-oauth-btn:disabled { opacity: 0.6; cursor: default; }

/* ---- Forms ---- */
.cove-field { display: flex; flex-direction: column; gap: 0.35rem; font-size: 0.88rem; font-weight: 600; margin-bottom: 0.9rem; }
.cove-input {
  padding: 0.6rem 0.75rem;
  border-radius: var(--cove-radius-sm);
  border: 1px solid var(--cove-border);
  font-size: 0.95rem;
  font-family: inherit;
  background: var(--cove-surface);
  color: var(--cove-ink);
}
.cove-input:focus { outline: 2px solid var(--cove-primary); outline-offset: 1px; }

/* ---- Alerts ---- */
.cove-alert { border-radius: var(--cove-radius-sm); padding: 0.75rem 1rem; font-size: 0.88rem; margin: 0 0 1rem; }
.cove-alert-error { background: var(--cove-danger-bg); color: var(--cove-danger); }
.cove-alert-success { background: var(--cove-success-bg); color: var(--cove-success); }

/* ---- Landing ---- */
.cove-landing { display: flex; flex-direction: column; align-items: center; padding: 1.25rem 0 1rem; }
.cove-hero-badge { display: none; }
.cove-signin-card { width: min(100%, 380px); text-align: left; }
.cove-signin-card h1 { font-size: 1.55rem; margin: 0 0 0.35rem; }
.cove-landing-sub { color: var(--cove-muted); font-size: 0.95rem; margin: 0 0 1.1rem; }
.cove-value-props { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 0.75rem; width: 100%; max-width: 720px; margin: 1rem 0; text-align: left; }
.cove-value-prop { background: var(--cove-surface); border: 1px solid var(--cove-border); border-radius: var(--cove-radius); padding: 0.85rem 1rem; }
.cove-value-prop-icon { display: inline-flex; align-items: center; justify-content: center; width: 40px; height: 40px; border-radius: 12px; background: var(--cove-panel); color: var(--cove-primary); margin-bottom: 0.6rem; }
.cove-value-prop h3 { font-size: 0.95rem; margin: 0 0 0.25rem; }
.cove-value-prop p { font-size: 0.85rem; color: var(--cove-muted); margin: 0; }
.cove-signin-box { display: flex; flex-direction: column; gap: 0.6rem; }
.cove-disclaimer { font-size: 0.78rem; color: var(--cove-muted); max-width: 46ch; margin-top: 1.25rem; }
.cove-disclaimer a { color: var(--cove-primary); font-weight: 600; }

/* ---- Dashboard ---- */
.cove-greeting { display: flex; align-items: center; gap: 1rem; margin-bottom: 1.25rem; }
.cove-greeting h1 { margin: 0; }
.cove-greeting .cove-lede { margin: 0.15rem 0 0; }
.cove-greeting .cove-avatar { width: 48px; height: 48px; font-size: 1.05rem; }
.cove-stat-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 1rem; margin: 1.5rem 0; }
.cove-stat { background: var(--cove-panel); border-radius: var(--cove-radius); padding: 1rem 1.1rem; }
.cove-stat-icon { display: inline-flex; color: var(--cove-primary); opacity: 0.85; margin-bottom: 0.35rem; }
.cove-stat-value { font-size: 1.6rem; font-weight: 800; color: var(--cove-brand); }
.cove-stat-label { font-size: 0.8rem; color: var(--cove-muted); font-weight: 600; }

/* ---- Shop ---- */
.cove-shop { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.cove-shop-body { flex: 1; min-height: 0; overflow: auto; padding-bottom: 0.25rem; }
.cove-category { margin-bottom: 1.75rem; }
.cove-category-icon { display: inline-flex; color: var(--cove-muted); }
.cove-category h2 { display: flex; align-items: center; gap: 0.45rem; font-size: 1.02rem; margin: 0 0 0.7rem; }
.cove-test-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 0.75rem; align-items: stretch; }
.cove-test-card {
  appearance: none;
  width: 100%;
  height: 100%;
  margin: 0;
  padding: 0.95rem 1rem 0.85rem;
  border: 1px solid var(--cove-border);
  border-radius: 12px;
  background: var(--cove-surface);
  color: inherit;
  font: inherit;
  text-align: left;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 0.2rem;
  cursor: pointer;
}
.cove-test-card:hover { border-color: light-dark(#c4c4cc, #52525b); }
.cove-test-card.is-selected { border-color: var(--cove-primary); background: light-dark(#fafafa, #1c1c1f); }
.cove-test-card.is-selected:hover { border-color: var(--cove-primary); }
.cove-test-name { font-weight: 680; font-size: 0.98rem; letter-spacing: -0.015em; line-height: 1.3; text-wrap: balance; }
.cove-test-price { font-weight: 650; font-size: 0.92rem; font-variant-numeric: tabular-nums; color: var(--cove-ink); }
.cove-test-desc { flex: 1 1 auto; margin-top: 0.35rem; font-size: 0.84rem; font-weight: 450; line-height: 1.45; color: var(--cove-muted); text-wrap: pretty; }
.cove-test-add {
  align-self: flex-start;
  display: inline-flex;
  align-items: center;
  min-height: 28px;
  margin-top: 0.85rem;
  padding: 0 0.7rem;
  border-radius: 999px;
  border: 1px solid var(--cove-border);
  background: var(--cove-panel);
  color: var(--cove-ink);
  font-size: 0.78rem;
  font-weight: 700;
  letter-spacing: 0.01em;
}
.cove-test-card.is-selected .cove-test-add { background: var(--cove-primary); color: var(--cove-on-brand); border-color: transparent; }
.cove-cart-bar {
  flex: none;
  margin-top: 0.75rem;
  background: var(--cove-surface);
  color: var(--cove-ink);
  border: 1px solid var(--cove-border);
  border-radius: var(--cove-radius-lg);
  padding: 0.8rem 1rem;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.75rem 1rem;
}
.cove-cart-bar .cove-btn-accent { margin-left: auto; }
.cove-cart-summary { font-weight: 650; font-variant-numeric: tabular-nums; }

/* ---- Orders / timeline ---- */
.cove-order-list { display: flex; flex-direction: column; gap: 1rem; }
.cove-order-card { border: 1px solid var(--cove-border); border-radius: var(--cove-radius); padding: 1.25rem; background: var(--cove-surface); }
.cove-order-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.65rem; gap: 1rem; }
.cove-order-when { color: var(--cove-muted); font-size: 0.8rem; font-variant-numeric: tabular-nums; white-space: nowrap; }
.cove-badge { display: inline-block; font-size: 0.72rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; padding: 0.25rem 0.6rem; border-radius: 999px; }
.cove-badge-pending_payment { background: var(--cove-warn-bg); color: var(--cove-warn); }
.cove-badge-fulfilled { background: var(--cove-panel); color: var(--cove-primary); }
.cove-badge-results_ready { background: var(--cove-success-bg); color: var(--cove-success); }
.cove-timeline { display: flex; align-items: flex-start; margin: 0.85rem 0 0.35rem; }
.cove-timeline-step { flex: 1; min-width: 0; display: flex; flex-direction: column; align-items: center; gap: 0.4rem; position: relative; }
.cove-timeline-dot { width: 22px; height: 22px; border-radius: 999px; background: var(--cove-border); color: transparent; display: flex; align-items: center; justify-content: center; font-size: 0.7rem; font-weight: 800; z-index: 1; }
.cove-timeline-step.is-done .cove-timeline-dot { background: var(--cove-primary); color: var(--cove-on-brand); }
.cove-timeline-step.is-current .cove-timeline-dot { background: var(--cove-accent); color: var(--cove-on-brand); }
.cove-timeline-label { font-size: 0.72rem; font-weight: 600; line-height: 1.25; color: var(--cove-muted); text-align: center; text-wrap: balance; }
.cove-timeline-step.is-done .cove-timeline-label, .cove-timeline-step.is-current .cove-timeline-label { color: var(--cove-ink); }
.cove-timeline-step:not(:last-child)::after { content: ""; position: absolute; top: 11px; left: 50%; width: 100%; height: 2px; background: var(--cove-border); z-index: 0; }
.cove-timeline-step.is-done:not(:last-child)::after { background: var(--cove-primary); }
.cove-order-items { list-style: none; padding: 0; margin: 0 0 0.35rem; font-size: 0.9rem; }
.cove-order-item { display: flex; justify-content: space-between; align-items: baseline; gap: 1rem; padding: 0.35rem 0; }
.cove-order-item-price { font-variant-numeric: tabular-nums; font-weight: 650; white-space: nowrap; }
.cove-order-note { margin: 0.35rem 0 0; font-size: 0.82rem; color: var(--cove-muted); }
.cove-results-table { width: 100%; border-collapse: collapse; margin-top: 0.75rem; font-size: 0.9rem; }
.cove-results-table td, .cove-results-table th { padding: 0.4rem 0.5rem; text-align: left; border-bottom: 1px solid var(--cove-border); }
.cove-fastforward { border: 1px dashed var(--cove-border); border-radius: var(--cove-radius-sm); padding: 0.75rem; margin-top: 0.75rem; font-size: 0.85rem; }
.cove-fastforward-label { font-weight: 700; color: var(--cove-muted); text-transform: uppercase; font-size: 0.7rem; letter-spacing: 0.05em; display: block; margin-bottom: 0.4rem; }

/* ---- Checkout ---- */
.cove-checkout-summary { list-style: none; padding: 0; margin: 0 0 1rem; }
.cove-checkout-summary li { display: flex; justify-content: space-between; padding: 0.5rem 0; border-bottom: 1px solid var(--cove-border); font-size: 0.92rem; }
.cove-checkout-total { display: flex; justify-content: space-between; font-weight: 800; font-size: 1.05rem; padding: 0.75rem 0 0; }

/* ---- Account ---- */
.cove-account { max-width: 520px; }
.cove-account-row { display: grid; grid-template-columns: 9.5rem minmax(0, 1fr); align-items: center; gap: 0.75rem; padding: 0.85rem 0; border-bottom: 1px solid var(--cove-border); }
.cove-account-row:last-of-type { border-bottom: none; }
.cove-account-label { font-size: 0.75rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; color: var(--cove-muted); }
.cove-avatar-md { width: 40px; height: 40px; }
.cove-account-signout { margin-top: 1.15rem; }

/* ---- OAuth modal ---- */
/* Sized against the backdrop, not the viewport: embedded (the docs site mounts
   this app inside its own modal window, which is the containing block for
   position: fixed), the backdrop covers only the app, not the whole screen. */
.cove-modal-backdrop { position: fixed; inset: 0; background: rgb(0 0 0 / 0.45); display: flex; align-items: center; justify-content: center; padding: 1rem; z-index: 100; }
.cove-modal { background: var(--cove-surface); border: 1px solid var(--cove-border); border-radius: var(--cove-radius); box-shadow: none; width: 100%; max-width: 480px; height: min(760px, 100%); display: flex; flex-direction: column; overflow: hidden; }
.cove-modal-header { display: flex; align-items: center; gap: 0.6rem; padding: 0.9rem 1.1rem; border-bottom: 1px solid var(--cove-border); background: var(--cove-panel); flex-shrink: 0; }
.cove-modal-header-text { font-size: 0.82rem; font-weight: 700; color: var(--cove-brand); flex: 1; }
.cove-modal-close { background: none; border: none; cursor: pointer; color: var(--cove-muted); font-size: 1.1rem; line-height: 1; padding: 0.25rem; }
.cove-modal-body { flex: 1; overflow: hidden; position: relative; min-height: 0; }
.cove-modal-body .hosted-page { width: 100%; height: 100%; display: block; overflow: auto; }
.cove-modal-loading { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; color: var(--cove-muted); font-size: 0.9rem; }
.cove-modal-error { padding: 1.25rem; }

/* ---- Loading ---- */
.cove-loading { display: flex; align-items: center; justify-content: center; padding: 3rem; color: var(--cove-muted); }
.cove-empty { display: flex; flex-direction: column; align-items: flex-start; gap: 0.85rem; color: var(--cove-muted); padding: 0.5rem 0 1rem; }
.cove-empty p { margin: 0; }

@media (max-width: 640px) {
  .cove-nav { flex-wrap: wrap; padding: 0.7rem 1rem; gap: 0.35rem 0.75rem; }
  .cove-nav-links { order: 3; flex: 1 0 100%; gap: 0; }
  .cove-spacer { display: none; }
  .cove-nav-user { margin-left: auto; }
  .cove-nav-name { display: none; }
  .cove-main { padding: 1.5rem 1rem 3rem; }
  .cove-card { padding: 1.25rem; }
  .cove-test-grid { grid-template-columns: 1fr; }
  .cove-account-row { grid-template-columns: 1fr; gap: 0.2rem; }
  .cove-order-when { white-space: normal; }
  .cove-modal-backdrop { padding: 0; }
  .cove-modal { max-width: none; height: 100%; border-radius: 0; }
}
`
