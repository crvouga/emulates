import { adminClientSource } from "./admin-client.js"
import type { AdminRoutes } from "./control.js"
import { ADMIN_KEY_HEADER, ADMIN_PREFIX } from "./control.js"
import type { AdminExtension, AdminUi } from "./surface.js"
import { STANDARD_ADMIN_ROUTES } from "./surface.js"

const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;"
      case "<":
        return "&lt;"
      case ">":
        return "&gt;"
      case '"':
        return "&quot;"
      default:
        return "&#39;"
    }
  })

/**
 * Docs-site record of each service's logo, website, vendor API reference, and guide.
 * This address is the only brand data in the bundle. The payload is fetched when the
 * page opens, so a docs deploy updates every already-published admin.
 * `?brands=` may name a localhost or same-origin copy of that JSON.
 */
export const ADMIN_BRANDS_URL = "https://mockingbird.chrisvouga.dev/brands.json"

/**
 * The default admin document. It talks only to `/__admin/*`, so every mock can serve it.
 * Bespoke panels arrive later from `GET /ui/manifest`, which stays behind the admin key.
 * The header chip is filled from {@link ADMIN_BRANDS_URL}; nothing about a vendor is inlined.
 */
export const renderAdminDocument = (service: string, adminPrefix = ADMIN_PREFIX): string => {
  const name = escapeHtml(service)
  const script = adminClientSource({
    standardRoutes: STANDARD_ADMIN_ROUTES,
    adminPrefix,
    adminKeyHeader: ADMIN_KEY_HEADER,
    brandsUrl: ADMIN_BRANDS_URL,
    service,
  })
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${name} admin</title>
<style>html,body{margin:0;min-height:100%}#admin-root{min-height:100%}</style>
</head>
<body>
<main id="admin-root" data-mockingbird-admin data-admin-ui-library="antd" data-service="${name}">
<noscript>Enable JavaScript to use administration.</noscript>
</main>
${script}
</body>
</html>`
}

const htmlResponse = (body: string): Response =>
  new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  })

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8" },
  })

const describeExtension = (extension: AdminExtension): Record<string, unknown> => {
  if (extension.kind === "sql") {
    return {
      kind: "sql",
      id: extension.id ?? "sql",
      title: extension.title ?? "SQL",
      ...(extension.description !== undefined ? { description: extension.description } : {}),
    }
  }
  return {
    kind: "panel",
    id: extension.id,
    title: extension.title,
    ...(extension.description !== undefined ? { description: extension.description } : {}),
    html: extension.html,
    ...(extension.script !== undefined ? { script: extension.script } : {}),
  }
}

/** `GET /__admin/ui` plus the manifest a bespoke panel list is read from. */
export const adminUiRoutes = (
  service: string,
  ui: AdminUi | undefined,
  adminPrefix = ADMIN_PREFIX,
): AdminRoutes => {
  const shell = () => renderAdminDocument(service, adminPrefix)
  const document = () => (ui?.render ? ui.render({ service, defaultHtml: shell }) : shell())
  return {
    "GET /ui": () => htmlResponse(document()),
    "GET /ui/": () => htmlResponse(document()),
    "GET /ui/manifest": () =>
      json({
        service,
        panels: (ui?.panels ?? []).map((panel) => ({
          id: panel.id,
          title: panel.title,
          ...(panel.description !== undefined ? { description: panel.description } : {}),
          html: panel.html,
          ...(panel.script !== undefined ? { script: panel.script } : {}),
        })),
        extensions: (ui?.extensions ?? []).map(describeExtension),
      }),
  }
}
