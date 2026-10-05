export type ApiKey = {
  id: string
  issuer: string
  publicKey: JsonWebKey
  role: "ADMIN" | "ACCOUNT_HOLDER" | "APP_MANAGER" | "DEVELOPER" | "FINANCE"
  enabled?: boolean
}
const decode = (part: string) =>
  Uint8Array.from(atob(part.replace(/-/g, "+").replace(/_/g, "/")), (char) => char.charCodeAt(0))
const json = (part: string): Record<string, unknown> => {
  const value: unknown = JSON.parse(new TextDecoder().decode(decode(part)))
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid JWT")
  return value as Record<string, unknown>
}
export const verify = async (
  token: string,
  lookup: (id: string) => ApiKey | undefined,
  now: number,
): Promise<{ key: ApiKey; scope?: string[] } | undefined> => {
  try {
    const parts = token.split(".")
    if (parts.length !== 3) return undefined
    const [head, body, signature] = parts
    if (!head || !body || !signature) return undefined
    const header = json(head),
      payload = json(body)
    if (header.alg !== "ES256" || header.typ !== "JWT" || typeof header.kid !== "string")
      return undefined
    const key = lookup(header.kid)
    const epoch = Math.floor(now / 1000)
    if (
      !key ||
      key.enabled === false ||
      payload.iss !== key.issuer ||
      payload.aud !== "appstoreconnect-v1" ||
      typeof payload.iat !== "number" ||
      !Number.isFinite(payload.iat) ||
      typeof payload.exp !== "number" ||
      !Number.isFinite(payload.exp) ||
      payload.iat > epoch ||
      payload.exp <= epoch ||
      payload.exp <= payload.iat ||
      payload.exp - payload.iat > 1200
    )
      return undefined
    if (
      payload.scope !== undefined &&
      (!Array.isArray(payload.scope) || payload.scope.some((value) => typeof value !== "string"))
    )
      return undefined
    const publicKey = await crypto.subtle.importKey(
      "jwk",
      key.publicKey,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    )
    const valid = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      publicKey,
      decode(signature),
      new TextEncoder().encode(`${head}.${body}`),
    )
    // Key controls may be revoked while verification is awaiting WebCrypto.
    const current = lookup(key.id)
    if (
      !valid ||
      !current ||
      current.enabled === false ||
      JSON.stringify(current) !== JSON.stringify(key)
    )
      return undefined
    return { key, ...(payload.scope !== undefined ? { scope: payload.scope as string[] } : {}) }
  } catch {
    return undefined
  }
}
export const matchesScope = (scope: string[], request: Request) => {
  const target = new URL(request.url)
  const canonical = (url: URL) => {
    const params = new URLSearchParams(url.search)
    for (const name of ["limit", "cursor", "sort"]) params.delete(name)
    params.sort()
    return `${url.pathname}?${params}`
  }
  return (
    request.method === "GET" &&
    scope.some((value) => {
      const split = value.indexOf(" ")
      if (value.slice(0, split) !== "GET") return false
      try {
        return canonical(new URL(value.slice(split + 1), target.origin)) === canonical(target)
      } catch {
        return false
      }
    })
  )
}
