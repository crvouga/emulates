import { isRecord } from "./model.js"

export const httpUrl = (value: unknown): string | undefined => {
  if (typeof value !== "string" || value.length > 2000) return undefined
  try {
    const url = new URL(value)
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : undefined
  } catch {
    return undefined
  }
}
export const brandCatalogUrl = (fallback: string, href: string): string => {
  const page = new URL(href)
  const requested = page.searchParams.get("brands")
  if (!requested) return fallback
  try {
    const url = new URL(requested, page)
    const local =
      ["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname) ||
      url.origin === page.origin
    return local && httpUrl(url.href) ? url.href : fallback
  } catch {
    return fallback
  }
}
export const brandFor = (service: string, catalog: unknown) => {
  if (!isRecord(catalog) || !Object.hasOwn(catalog, service)) return null
  const item = catalog[service]
  if (!isRecord(item) || typeof item.vendor !== "string" || !item.vendor.trim()) return null
  return {
    vendor: item.vendor.slice(0, 80),
    website: httpUrl(item.website),
    docs: httpUrl(item.docs),
    guide: httpUrl(item.guide),
    logo: httpUrl(item.logo),
    description: typeof item.description === "string" ? item.description.slice(0, 280) : "",
  }
}
