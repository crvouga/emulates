import { html } from "htm/preact"

type Tab = { value: string; label: string }
/** Shared keyboard-accessible tabs for the workspace's detail views. */
export const Tabs = ({
  tabs,
  value,
  onSelect,
  prefix,
  panel,
  label,
}: {
  tabs: Tab[]
  value: string
  onSelect: (value: string) => void
  prefix: string
  panel: string
  label: string
}) => {
  const keyDown = (event: KeyboardEvent) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return
    event.preventDefault()
    const current = tabs.findIndex((tab) => tab.value === value)
    const index =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? tabs.length - 1
          : (current + (event.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length
    const next = tabs[index]
    if (!next) return
    onSelect(next.value)
    ;(event.currentTarget as HTMLElement)
      .querySelectorAll<HTMLButtonElement>("button")
      [index]?.focus()
  }
  return html`<div class="cove-tabs" role="tablist" aria-label=${label} onKeyDown=${keyDown}>${tabs.map((tab) => html`<button key=${tab.value} id=${`${prefix}-${tab.value}`} role="tab" aria-selected=${value === tab.value} aria-controls=${panel} tabindex=${value === tab.value ? 0 : -1} onClick=${() => onSelect(tab.value)}>${tab.label}</button>`)}</div>`
}
