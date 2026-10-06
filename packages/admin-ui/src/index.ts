import { ADMIN_BROWSER_BUNDLE } from "./bundle.js"
import type { AdminApiConfig, AdminConfig, MembersConfig } from "./model.js"

export type { AdminApiConfig, AdminConfig } from "./model.js"

/** Embed the prebuilt browser client without a CDN or framework runtime dependency. */
export const adminClientSource = (config: AdminConfig): string => {
  const payload = JSON.stringify(config).replace(/</g, "\\u003c")
  return `<script>\n${ADMIN_BROWSER_BUNDLE}\nEmulatorsAdmin.mount(document.getElementById("admin-root"), ${payload});\n</script>`
}

export const membersClientSource = (config: MembersConfig): string => {
  const payload = JSON.stringify(config).replace(/</g, "\\u003c")
  return `<script>\n${ADMIN_BROWSER_BUNDLE}\nEmulatorsAdmin.mountMembers(document.getElementById("admin-root"), ${payload});\n</script>`
}

export type ComposableAdminApi = AdminApiConfig & {
  fetch(request: Request): Promise<Response>
}

const escapeHtml = (value: string): string =>
  value.replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char,
  )

/**
 * Compose independent admin APIs behind one fetch handler and one UI. The shell is only a
 * facade: every data/control request is forwarded unchanged to the selected API.
 */
export const composeAdminApis = (
  apis: readonly ComposableAdminApi[],
  options: { brandsUrl: string; prefix?: string; title?: string },
): { fetch(request: Request): Promise<Response> } => {
  if (apis.length === 0) throw new RangeError("composeAdminApis needs at least one admin API")
  const ids = new Set<string>()
  for (const api of apis) {
    if (!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(api.id))
      throw new RangeError(`invalid admin API id ${JSON.stringify(api.id)}`)
    if (ids.has(api.id)) throw new RangeError(`duplicate admin API id ${api.id}`)
    ids.add(api.id)
  }
  const prefix = `/${(options.prefix ?? "/__admin").replace(/^\/+|\/+$/g, "")}`
  const first = apis[0] as ComposableAdminApi
  const config: AdminConfig = {
    service: first.service,
    adminPrefix: `${prefix}/apis/${first.id}`,
    adminKeyHeader: first.adminKeyHeader,
    standardRoutes: first.standardRoutes,
    brandsUrl: options.brandsUrl,
    apis: apis.map(({ fetch: _fetch, ...api }) => ({
      ...api,
      adminPrefix: `${prefix}/apis/${api.id}`,
    })),
  }
  const title = escapeHtml(options.title ?? "Emulators")
  const document = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>${title} admin</title><style>html,body{margin:0;min-height:100%}#admin-root{min-height:100%}</style></head><body><main id="admin-root" data-emulators-admin data-admin-ui-library="antd" data-service="${title}"><noscript>Enable JavaScript to use administration.</noscript></main>${adminClientSource(config)}</body></html>`
  return {
    async fetch(request) {
      const url = new URL(request.url)
      if (
        request.method === "GET" &&
        (url.pathname === `${prefix}/ui` || url.pathname === `${prefix}/ui/`)
      )
        return new Response(document, {
          headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
        })
      const root = `${prefix}/apis/`
      if (!url.pathname.startsWith(root)) return new Response("Not found", { status: 404 })
      const rest = url.pathname.slice(root.length)
      const slash = rest.indexOf("/")
      const id = slash < 0 ? rest : rest.slice(0, slash)
      const api = apis.find((candidate) => candidate.id === id)
      if (!api) return new Response("Not found", { status: 404 })
      url.pathname = `${api.adminPrefix.replace(/\/$/, "")}${slash < 0 ? "" : rest.slice(slash)}`
      return api.fetch(new Request(url, request))
    },
  }
}
