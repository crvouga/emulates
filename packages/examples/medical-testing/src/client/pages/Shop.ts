import { html } from "htm/preact"
import { useState } from "preact/hooks"
import { api } from "../api.js"
import { Empty, ErrorState, Loading, message, price, useResource } from "../components/States.js"

export const Shop = ({ onCheckout }: { onCheckout: (checkoutSessionId: string) => void }) => {
  const resource = useResource(api.tests)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [query, setQuery] = useState("")
  const [category, setCategory] = useState("All tests")
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [consent, setConsent] = useState(false)
  const tests = resource.data?.tests ?? []
  const categories = ["All tests", ...new Set(tests.map((test) => test.category))]
  const filtered = tests.filter(
    (test) =>
      (category === "All tests" || test.category === category) &&
      `${test.name} ${test.description}`.toLowerCase().includes(query.toLowerCase()),
  )
  const cart = tests.filter((test) => selected.has(test.id))
  const toggle = (id: string) => {
    const next = new Set(selected)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setSelected(next)
  }
  const checkout = async () => {
    if (pending || !consent || !selected.size) return
    setError(null)
    setPending(true)
    try {
      onCheckout((await api.checkout([...selected])).checkoutSessionId)
    } catch (error) {
      setError(message(error))
    } finally {
      setPending(false)
    }
  }
  return html`<div class="cove-page"><div class="cove-page-head"><div><p class="cove-eyebrow">Test catalog</p><h1>Find your next test</h1><p class="cove-lede">Choose individual tests or combine panels. Clear pricing, all in one order.</p></div><span class="cove-role">${tests.length} available tests</span></div>
    ${resource.error && html`<${ErrorState} error=${resource.error} retry=${resource.refresh}/>`}${error && html`<div class="cove-alert cove-alert-error" role="alert">${error}<button class="cove-btn cove-btn-ghost cove-btn-sm" disabled=${pending} onClick=${checkout}>Retry checkout</button></div>`}
    <div class="cove-shop-layout"><section><label class="cove-search">Search catalog<input class="cove-input" type="search" value=${query} placeholder="Search tests or biomarkers…" onInput=${(event: Event) => setQuery((event.target as HTMLInputElement).value)}/></label><div class="cove-segment cove-categories" aria-label="Test categories">${categories.map((item) => html`<button key=${item} aria-pressed=${category === item} onClick=${() => setCategory(item)}>${item}</button>`)}</div>
    ${
      !resource.data && resource.busy
        ? html`<${Loading} label="Loading the test catalog…"/>`
        : filtered.length
          ? html`<div class="cove-test-grid">${filtered.map((test) => html`<article class="cove-test-card ${selected.has(test.id) ? "is-selected" : ""}" key=${test.id}><span class="cove-eyebrow">${test.category}</span><h2 class="cove-test-name">${test.name}</h2><p class="cove-test-desc">${test.description}</p><div class="cove-test-meta"><span>At-home collection</span><span>Kit included</span></div><div class="cove-summary-row"><strong class="cove-test-price">${price(test.priceCents)}</strong><button class="cove-btn ${selected.has(test.id) ? "cove-btn-primary" : "cove-btn-ghost"} cove-btn-sm" disabled=${pending} aria-pressed=${selected.has(test.id)} onClick=${() => toggle(test.id)}>${selected.has(test.id) ? "✓ Added" : "+ Add test"}</button></div><details><summary>Collection details</summary><p class="cove-muted cove-text-sm">Your order includes a collection kit. Follow the instructions supplied with your kit. Track processing and access reports in your account.</p></details></article>`)}</div>`
          : !resource.error &&
            html`<${Empty} title="No tests found" detail="Try a different search or category." action=${() => {
              setQuery("")
              setCategory("All tests")
            }} label="Clear filters"/>`
    }</section>
    <aside class="cove-card cove-cart"><div class="cove-section-head"><h2>Your order</h2><span class="cove-role">${cart.length}</span></div>${cart.length ? html`<div>${cart.map((test) => html`<div class="cove-cart-item" key=${test.id}><div><strong>${test.name}</strong><p class="cove-muted cove-text-sm">${price(test.priceCents)}</p></div><button class="cove-btn cove-btn-ghost cove-btn-sm" disabled=${pending} aria-label=${`Remove ${test.name}`} onClick=${() => toggle(test.id)}>×</button></div>`)}</div><div class="cove-summary-row"><span>Collection kits</span><span>Included</span></div><div class="cove-summary-row"><strong>Total</strong><strong>${price(cart.reduce((sum, test) => sum + test.priceCents, 0))}</strong></div><label class="cove-checkbox"><input type="checkbox" checked=${consent} disabled=${pending} onChange=${(event: Event) => setConsent((event.target as HTMLInputElement).checked)}/><span>I understand this is a demonstration order with fictional results.</span></label><button class="cove-btn cove-btn-primary cove-btn-block" disabled=${pending || !consent} onClick=${checkout}>${pending ? "Preparing checkout…" : "Continue to checkout →"}</button><p class="cove-muted cove-text-sm">Review payment in the next step. No real charges.</p>` : html`<p class="cove-muted">Your order is empty. Add a test to see your total here.</p><div class="cove-cart-placeholder" aria-hidden="true">+</div>`}</aside></div>
  </div>`
}
