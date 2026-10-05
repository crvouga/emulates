import { exportJWK, generateKeyPair, SignJWT } from "jose"
import type { ApiKey } from "../src/index.js"
export const credentials = async (role: ApiKey["role"] = "ADMIN") => {
  const pair = await generateKeyPair("ES256", { extractable: true })
  const key: ApiKey = {
    id: "mock-key",
    issuer: "mock-issuer",
    publicKey: await exportJWK(pair.publicKey),
    role,
  }
  const token = (now: number, claims: Record<string, unknown> = {}) =>
    new SignJWT({
      iss: key.issuer,
      aud: "appstoreconnect-v1",
      iat: Math.floor(now / 1000),
      exp: Math.floor(now / 1000) + 600,
      ...claims,
    })
      .setProtectedHeader({ alg: "ES256", kid: key.id, typ: "JWT" })
      .sign(pair.privateKey)
  return { key, token }
}
export const call = (
  send: (request: Request) => Promise<Response>,
  origin: string,
  token: string,
  path: string,
  body?: unknown,
  method = body === undefined ? "GET" : "POST",
) =>
  send(
    new Request(`${origin}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  )
export const enumerate = async (
  send: (request: Request) => Promise<Response>,
  origin: string,
  token: string,
  path: string,
) => {
  const rows: Record<string, unknown>[] = []
  const visited = new Set<string>()
  let url: string | null = `${origin}${path}`
  while (url) {
    if (visited.has(url)) throw new Error("Pagination loop")
    visited.add(url)
    const response = await send(new Request(url, { headers: { authorization: `Bearer ${token}` } }))
    if (!response.ok) throw new Error(`Apple list failed (${response.status})`)
    const body = (await response.json()) as {
      data: Record<string, unknown>[]
      links: { next?: string | null }
    }
    rows.push(...body.data)
    url = body.links.next ?? null
  }
  return rows
}
