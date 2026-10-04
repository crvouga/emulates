import { html } from "htm/preact"
import { render } from "preact"
import { useEffect, useState } from "preact/hooks"
import { can } from "../app/model.js"
import { api, onUnauthorized, type User } from "./api.js"
import { ErrorState, Loading, message } from "./components/States.js"
import { Account } from "./pages/Account.js"
import { Admin } from "./pages/Admin.js"
import { Checkout } from "./pages/Checkout.js"
import { Dashboard } from "./pages/Dashboard.js"
import { Landing } from "./pages/Landing.js"
import { Orders } from "./pages/Orders.js"
import { Shop } from "./pages/Shop.js"
import { configureRouter, navigate, type Route, useRoute } from "./router.js"

const LINKS: { route: Route; label: string; symbol: string }[] = [
  { route: "dashboard", label: "Overview", symbol: "▦" },
  { route: "shop", label: "Test catalog", symbol: "+" },
  { route: "orders", label: "Orders", symbol: "□" },
  { route: "results", label: "Results", symbol: "≡" },
]
const App = () => {
  const route = useRoute()
  const [user, setUser] = useState<User | null | undefined>(undefined)
  const [error, setError] = useState<string | null>(null)
  const [checkoutId, setCheckoutId] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [signingOut, setSigningOut] = useState(false)
  const load = async () => {
    setError(null)
    try { setUser((await api.me()).user) } catch (error) { setError(message(error)) }
  }
  useEffect(() => { void load() }, [])
  useEffect(() => onUnauthorized(() => { setUser(null); setCheckoutId(null); setNotice(null) }), [])
  if (error && user === undefined) return html`<main class="cove-main"><${ErrorState} error=${error} retry=${load}/></main>`
  if (user === undefined) return html`<${Loading}/>`
  if (!user) return html`<main class="cove-main"><${Landing} onSignedIn=${(user: User) => { setUser(user); setNotice(null); navigate("dashboard") }}/></main>`
  const signOut = async () => {
    setSigningOut(true); setError(null)
    try { await api.signOut(); setUser(null); setCheckoutId(null); setNotice(null); navigate("dashboard") }
    catch (error) { setError(message(error)) }
    finally { setSigningOut(false) }
  }
  const startCheckout = (id: string) => { setCheckoutId(id); setNotice(null); navigate("checkout") }
  return html`
    <div class="cove-shell">
      <aside class="cove-sidebar">
        <button class="cove-wordmark" onClick=${() => navigate("dashboard")}><span class="cove-logo-box" aria-hidden="true">+</span>Lab testing</button>
        <div class="cove-workspace-label">Personal workspace</div>
        <nav class="cove-nav-links" aria-label="Main navigation">
          ${LINKS.map((link) => html`<button key=${link.route} class="cove-nav-link ${route === link.route ? "is-active" : ""}" aria-current=${route === link.route ? "page" : undefined} onClick=${() => navigate(link.route)}><span aria-hidden="true">${link.symbol}</span>${link.label}</button>`)}
          ${can(user.role, "users.manage") && html`<button class="cove-nav-link ${route === "admin" ? "is-active" : ""}" aria-current=${route === "admin" ? "page" : undefined} onClick=${() => navigate("admin")}><span aria-hidden="true">⚙</span>Administration</button>`}
        </nav>
        <div class="cove-sidebar-bottom"><p class="cove-muted">Your orders, reports, and care history in one place.</p><button class="cove-nav-user" onClick=${() => navigate("account")}><span class="cove-avatar">${(user.name?.[0] ?? "?").toUpperCase()}</span><span><strong>${user.name ?? "Account"}</strong><small>${user.role}</small></span><span aria-hidden="true">›</span></button></div>
      </aside>
      <div class="cove-workspace">
        <header class="cove-topbar"><span>${route === "account" ? "Account settings" : route === "checkout" ? "Secure checkout" : route === "admin" ? "Administration" : LINKS.find((link) => link.route === route)?.label}</span><span class="cove-topbar-right"><span class="cove-role">${user.role}</span><button class="cove-btn cove-btn-ghost cove-btn-sm" onClick=${() => navigate("account")}>Account</button></span></header>
        <main class="cove-main" id="cove-content"><div class="cove-container">
          ${notice && html`<div class="cove-alert cove-alert-success cove-toolbar" role="status"><span>${notice}</span><button class="cove-btn cove-btn-ghost cove-btn-sm" aria-label="Dismiss notification" onClick=${() => setNotice(null)}>Dismiss</button></div>`}
          ${error && html`<${ErrorState} error=${error} retry=${() => setError(null)}/>`}
          ${route === "dashboard" && html`<${Dashboard} user=${user}/>`}
          ${route === "shop" && html`<${Shop} onCheckout=${startCheckout}/>`}
          ${route === "checkout" && html`<${Checkout} checkoutSessionId=${checkoutId} onPaid=${() => { setCheckoutId(null); setNotice("Payment successful. Your order is being prepared."); navigate("orders") }}/>`}
          ${(route === "orders" || route === "results") && html`<${Orders} key=${route} user=${user} resultsOnly=${route === "results"} onCheckout=${startCheckout}/>`}
          ${route === "account" && html`<${Account} user=${user} onUpdated=${setUser} onSignOut=${signOut} signingOut=${signingOut}/>`}
          ${route === "admin" && (can(user.role, "users.manage") ? html`<${Admin} user=${user}/>` : html`<div class="cove-card"><h1>Access restricted</h1><p>Administration requires an administrator role.</p><button class="cove-btn cove-btn-primary" onClick=${() => navigate("dashboard")}>Back to overview</button></div>`)}
        </div></main>
        <footer class="cove-footer">Demonstration workspace · Fictional data · No real charges or medical advice</footer>
      </div>
    </div>`
}
export const mountApp = (root: HTMLElement, embedded = false): (() => void) => {
  configureRouter(embedded)
  root.classList.add("cove-app")
  render(html`<${App}/>`, root)
  return () => render(null, root)
}
if (typeof document !== "undefined") {
  const root = document.getElementById("app")
  if (root) mountApp(root)
}
