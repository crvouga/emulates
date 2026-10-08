for (const root of document.querySelectorAll<HTMLElement>("[data-code-tabs]")) {
  const tabs = [...root.querySelectorAll<HTMLButtonElement>("[data-code-tab]")]
  const panels = [...root.querySelectorAll<HTMLElement>("[data-code-panel]")]
  const select = (tab: HTMLButtonElement) => {
    for (const item of tabs) {
      item.setAttribute("aria-selected", String(item === tab))
      item.tabIndex = item === tab ? 0 : -1
    }
    for (const panel of panels) panel.hidden = panel.dataset.codePanel !== tab.dataset.codeTab
  }
  for (const tab of tabs) {
    tab.addEventListener("click", () => select(tab))
    tab.addEventListener("keydown", (event) => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return
      event.preventDefault()
      const index =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? tabs.length - 1
            : (tabs.indexOf(tab) + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) %
              tabs.length
      const next = tabs[index]
      if (!next) return
      select(next)
      next.focus()
    })
  }
}
