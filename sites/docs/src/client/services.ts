import { score, terms } from "../lib/search.ts"
import { KEYS, store } from "./storage.ts"

// The URL owns shareable state (query, category, filters, sort); localStorage owns the view preference.
const grid = document.querySelector<HTMLElement>("[data-grid]")
const q = document.querySelector<HTMLInputElement>("[data-q]")
const sort = document.querySelector<HTMLSelectElement>("[data-sort]")
const count = document.querySelector<HTMLElement>("[data-count]")
const empty = document.querySelector<HTMLElement>("[data-empty]")
const featuredFilter = document.querySelector<HTMLButtonElement>("[data-featured-filter]")
const chips = [...document.querySelectorAll<HTMLButtonElement>("[data-cat]")]
const views = [...document.querySelectorAll<HTMLButtonElement>("[data-view]")].filter(
  (b) => b.tagName === "BUTTON",
)

if (grid && q && sort && count && empty) {
  const cards = [...grid.querySelectorAll<HTMLElement>("[data-service]")].map((el) => ({
    el,
    name: el.dataset.service ?? "",
    displayName: el.dataset.display ?? "",
    category: el.dataset.category ?? "",
    ops: Number(el.dataset.ops ?? 0),
    featured: el.dataset.featured === "1",
    text: el.dataset.search ?? "",
  }))
  const total = cards.length
  const params = new URLSearchParams(location.search)
  let category = params.get("category") ?? ""
  let featured = params.get("featured") === "1"
  q.value = params.get("q") ?? ""
  const sortParam = params.get("sort")
  if (sortParam && [...sort.options].some((o) => o.value === sortParam)) sort.value = sortParam

  const setCategory = (slug: string) => {
    category = chips.some((c) => c.dataset.cat === slug) ? slug : ""
    for (const chip of chips)
      chip.setAttribute("aria-checked", String(chip.dataset.cat === category))
  }

  const setView = (view: string) => {
    grid.dataset.view = view === "list" ? "list" : "grid"
    for (const b of views)
      b.setAttribute("aria-pressed", String(b.dataset.view === grid.dataset.view))
  }

  let urlTimer: ReturnType<typeof setTimeout> | undefined
  const syncUrl = () => {
    clearTimeout(urlTimer)
    urlTimer = setTimeout(() => {
      const next = new URLSearchParams()
      if (q.value.trim()) next.set("q", q.value.trim())
      if (category) next.set("category", category)
      if (featured) next.set("featured", "1")
      if (sort.value !== "relevance") next.set("sort", sort.value)
      const qs = next.toString()
      if (location.search !== (qs ? `?${qs}` : "")) {
        history.replaceState(null, "", qs ? `?${qs}` : location.pathname)
      }
    }, 150)
  }

  const apply = () => {
    const query = terms(q.value)
    const visible = cards
      .map((card) => ({ card, rank: score(query, card) }))
      .filter(
        (r): r is { card: (typeof cards)[number]; rank: number } =>
          r.rank !== null &&
          (!category || r.card.category === category) &&
          (!featured || r.card.featured),
      )
    const by = sort.value
    visible.sort((a, b) => {
      if (by === "relevance" && a.rank !== b.rank) return a.rank - b.rank
      if (by === "relevance" && a.card.featured !== b.card.featured)
        return Number(b.card.featured) - Number(a.card.featured)
      if (by === "ops" && a.card.ops !== b.card.ops) return b.card.ops - a.card.ops
      if (by === "category" && a.card.category !== b.card.category)
        return a.card.category.localeCompare(b.card.category)
      return a.card.displayName.localeCompare(b.card.displayName)
    })
    const shown = new Set(visible.map((v) => v.card))
    for (const card of cards) card.el.hidden = !shown.has(card)
    grid.append(
      ...visible.map((v) => v.card.el),
      ...cards.filter((c) => !shown.has(c)).map((c) => c.el),
    )
    count.textContent =
      shown.size === total ? `${total} emulators` : `${shown.size} of ${total} emulators`
    empty.hidden = shown.size > 0
    featuredFilter?.setAttribute("aria-pressed", String(featured))
    grid.hidden = shown.size === 0
    syncUrl()
  }

  setCategory(category)
  setView(store.get(KEYS.servicesView) ?? "grid")
  apply()

  q.addEventListener("input", apply)
  sort.addEventListener("change", apply)
  featuredFilter?.addEventListener("click", () => {
    featured = !featured
    apply()
  })
  for (const chip of chips) {
    chip.addEventListener("click", () => {
      setCategory(chip.dataset.cat ?? "")
      apply()
    })
  }
  for (const b of views) {
    b.addEventListener("click", () => {
      setView(b.dataset.view ?? "grid")
      store.set(KEYS.servicesView, grid.dataset.view ?? "grid")
    })
  }
  document.querySelector("[data-clear]")?.addEventListener("click", () => {
    q.value = ""
    sort.value = "relevance"
    featured = false
    setCategory("")
    apply()
    q.focus()
  })

  document.addEventListener("keydown", (event) => {
    const t = event.target as HTMLElement
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)
    if (event.key === "/" && !typing) {
      event.preventDefault()
      q.focus()
      q.select()
    } else if (event.key === "Escape" && t === q) {
      q.value = ""
      apply()
    } else if (event.key === "Enter" && t === q) {
      const first = grid.querySelector<HTMLAnchorElement>("[data-service]:not([hidden])")
      if (first) location.href = first.href
    }
  })
}
