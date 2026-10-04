import { ADMIN_BROWSER_BUNDLE } from "./bundle.js"
import type { AdminConfig, MembersConfig } from "./model.js"

export type { AdminConfig } from "./model.js"

/** Embed the prebuilt browser client without a CDN or framework runtime dependency. */
export const adminClientSource = (config: AdminConfig): string => {
  const payload = JSON.stringify(config).replace(/</g, "\\u003c")
  return `<script>\n${ADMIN_BROWSER_BUNDLE}\nMockingbirdAdmin.mount(document.getElementById("admin-root"), ${payload});\n</script>`
}

export const membersClientSource = (config: MembersConfig): string => {
  const payload = JSON.stringify(config).replace(/</g, "\\u003c")
  return `<script>\n${ADMIN_BROWSER_BUNDLE}\nMockingbirdAdmin.mountMembers(document.getElementById("admin-root"), ${payload});\n</script>`
}
