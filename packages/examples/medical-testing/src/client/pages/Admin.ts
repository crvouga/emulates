import { membersClientSource } from "@emulators/admin-ui"
import { html } from "htm/preact"
import { useEffect, useRef } from "preact/hooks"
import { PERMISSIONS, ROLES } from "../../app/model.js"
import { fetchApp, type User } from "../api.js"
import { pasteHtml } from "../pasteHtml.js"

/** The application admin uses the same prebuilt tables, forms, and dialogs as service admins. */
export const Admin = ({ user }: { user: User }) => {
  const host = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const panel = host.current
    if (!panel) return
    let dispose: (() => void) | undefined
    const render = () => {
      dispose?.()
      const mode = document.documentElement.getAttribute("data-theme")
      const dark =
        mode === "dark" || (mode !== "light" && matchMedia("(prefers-color-scheme: dark)").matches)
      const script = membersClientSource({
        currentUserId: user.id,
        roles: ROLES,
        permissions: PERMISSIONS,
        apiPrefix: "/api",
        dark,
      })
      dispose = pasteHtml(panel, `<main id="admin-root"></main>${script}`, {
        fetch: (input, init) => {
          const raw =
            typeof input === "string" ? input : input instanceof URL ? input.href : input.url
          const url = new URL(raw, "https://app.local")
          return fetchApp(`${url.pathname}${url.search}`, init)
        },
      })
    }
    render()
    const observer = new MutationObserver(render)
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    })
    return () => {
      observer.disconnect()
      dispose?.()
    }
  }, [user.id])
  return html`<div class="cove-page" ref=${host}></div>`
}
