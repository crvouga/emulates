import { useEffect, useRef } from "preact/hooks"

const focusable = (root: ParentNode): HTMLElement[] => {
  const targets: HTMLElement[] = []
  for (const element of root.querySelectorAll<HTMLElement>("*")) {
    if (
      element.matches(
        "button, a[href], input:not([type=hidden]), select, textarea, [tabindex]:not([tabindex='-1'])",
      ) &&
      !element.hasAttribute("disabled") &&
      element.getClientRects().length
    )
      targets.push(element)
    if (element.shadowRoot) targets.push(...focusable(element.shadowRoot))
  }
  return targets
}

/** Claims Escape for this overlay and traps keyboard focus, including hosted shadow pages. */
export const useEscapeKey = (onEscape: () => void): void => {
  const latest = useRef(onEscape)
  latest.current = onEscape
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const modal = document.querySelector<HTMLElement>(".cove-modal[role=dialog]")
    modal?.querySelector<HTMLElement>("button")?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return
      if (event.key === "Escape") {
        event.preventDefault()
        latest.current()
        return
      }
      if (event.key !== "Tab" || !modal) return
      const targets = focusable(modal)
      let active = document.activeElement
      while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement
      const index = targets.indexOf(active as HTMLElement)
      if (
        index === -1 ||
        (!event.shiftKey && index === targets.length - 1) ||
        (event.shiftKey && index === 0)
      ) {
        event.preventDefault()
        targets[event.shiftKey ? targets.length - 1 : 0]?.focus()
      }
    }
    document.addEventListener("keydown", onKeyDown)
    return () => {
      document.removeEventListener("keydown", onKeyDown)
      if (opener?.isConnected) opener.focus()
    }
  }, [])
}
