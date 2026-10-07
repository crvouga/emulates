import { describe, expect, test } from "bun:test"
import { createClock } from "@crvouga/mockingbird-service"
import { createLocalJWKSet, decodeProtectedHeader, jwtVerify } from "jose"
import { createRuntime, OAuthAPI, type OAuthAPIOptions, type SigningKey } from "./src/index.js"

const issuer = "https://identity.test"
const callback = "https://app.test/callback"
const now = 1_700_000_000_000
const base: OAuthAPIOptions = {
  now: () => now,
  accounts: [{ id: "ada", name: "Ada Lovelace", email: "ada@example.test" }],
  clients: [{ id: "app", name: "App", redirectUris: [callback], secret: "fixture-client-secret" }],
}
const post = (path: string, body: Record<string, string>) =>
  new Request(issuer + path, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
  })
type Fetcher = { fetch(r: Request): Promise<Response> }

/** Drive every minting path once and return the raw wire transcript. */
async function run(api: Fetcher, mode: "query" | "form_post" = "query") {
  const out: string[] = []
  const record = async (r: Response) => {
    const text = await r.text()
    out.push(`${r.status} ${[...r.headers].map(([k, v]) => `${k}: ${v}`).join("; ")}\n${text}`)
    return { r, text }
  }
  const authorize = new URLSearchParams({
    client_id: "app",
    redirect_uri: callback,
    response_type: "code",
    scope: "openid email profile offline_access",
    state: "s",
    nonce: "n",
    response_mode: mode,
  })
  const login = await record(await api.fetch(new Request(`${issuer}/authorize?${authorize}`)))
  const tx = /name="transaction" value="([^"]+)"/.exec(login.text)?.[1] ?? ""
  await record(
    await api.fetch(post("/interaction", { transaction: tx, action: "select", account: "ada" })),
  )
  const allowed = await record(
    await api.fetch(post("/interaction", { transaction: tx, action: "allow" })),
  )
  const code =
    mode === "form_post"
      ? (/name="code" value="([^"]+)"/.exec(allowed.text)?.[1] ?? "")
      : (new URL(allowed.r.headers.get("location") ?? issuer).searchParams.get("code") ?? "")
  const token = await record(
    await api.fetch(
      post("/token", {
        grant_type: "authorization_code",
        code,
        client_id: "app",
        client_secret: "fixture-client-secret",
        redirect_uri: callback,
      }),
    ),
  )
  await record(await api.fetch(new Request(`${issuer}/jwks`)))
  return { transcript: out.join("\n\n"), code, tx, tokens: JSON.parse(token.text) }
}

describe("opt-in seeded credentials", () => {
  test("a seeded run replays byte-for-byte across fresh runtimes, form_post included", async () => {
    for (const mode of ["query", "form_post"] as const) {
      const options = { ...base, seed: "s1", deterministicCredentials: true }
      const first = await run(new OAuthAPI(options), mode)
      const second = await run(new OAuthAPI(options), mode)
      expect(second.transcript).toBe(first.transcript)
      expect(first.transcript).toContain(first.code)
      expect(first.transcript).toContain(first.tokens.access_token)
      expect(first.transcript).toContain(first.tx)
      expect(first.transcript).toContain("nonce-")
    }
  })

  test("the runtime factory accepts the same options", async () => {
    const make = () =>
      createRuntime({
        ...base,
        seed: 7,
        deterministicCredentials: true,
        clock: createClock(() => now),
      })
    const first = await run(make())
    expect((await run(make())).transcript).toBe(first.transcript)
  })

  test("a different seed mints different values; values within a run stay distinct", async () => {
    const a = await run(new OAuthAPI({ ...base, seed: "a", deterministicCredentials: true }))
    const b = await run(new OAuthAPI({ ...base, seed: "b", deterministicCredentials: true }))
    expect(b.code).not.toBe(a.code)
    expect(b.transcript).not.toBe(a.transcript)
    expect(new Set([a.code, a.tx, a.tokens.access_token, a.tokens.refresh_token]).size).toBe(4)
  })

  test("seeded signing keys publish a stable kid and JWKS that verify the ID token", async () => {
    const options = { ...base, seed: "keys", deterministicCredentials: true }
    const jwks = async (api: OAuthAPI) => (await api.fetch(new Request(`${issuer}/jwks`))).json()
    const first = new OAuthAPI(options)
    const set = await jwks(first)
    expect(await jwks(new OAuthAPI(options))).toEqual(set)
    const { tokens } = await run(first)
    expect(decodeProtectedHeader(tokens.id_token).kid).toBe(set.keys[0].kid)
    await jwtVerify(tokens.id_token, createLocalJWKSet(set), {
      issuer,
      audience: "app",
      currentDate: new Date(now),
    })
  })

  test("rotation and reset replay the same key sequence", async () => {
    const options = { ...base, seed: "rot", deterministicCredentials: true }
    const kids = (api: OAuthAPI) => [api.rotateSigningKey().kid, api.rotateSigningKey().kid]
    const api = new OAuthAPI(options)
    const first = kids(api)
    expect(kids(new OAuthAPI(options))).toEqual(first)
    expect(new Set(first).size).toBe(2)
    await api.reset()
    expect(kids(api)).toEqual(first)
    const fresh = await run(new OAuthAPI(options))
    await api.reset()
    expect((await run(api)).transcript).toBe(fresh.transcript)
  })

  test("injected randomBytes feeds every minted value", async () => {
    const source = () => {
      let n = 0
      return (length: number) => new Uint8Array(length).fill(++n)
    }
    const first = await run(new OAuthAPI({ ...base, randomBytes: source() }))
    const second = await run(new OAuthAPI({ ...base, randomBytes: source() }))
    expect(first.code).toBe(second.code)
    expect(first.tokens.access_token).toBe(second.tokens.access_token)
    expect(first.tx).toBe(second.tx)
  })

  test("injected signingKeys are published, sign, and rotate in order", async () => {
    const generate = async (kid: string): Promise<SigningKey> => {
      const pair = await crypto.subtle.generateKey(
        {
          name: "RSASSA-PKCS1-v1_5",
          modulusLength: 2048,
          publicExponent: new Uint8Array([1, 0, 1]),
          hash: "SHA-256",
        },
        true,
        ["sign", "verify"],
      )
      return {
        kid,
        privateJwk: await crypto.subtle.exportKey("jwk", pair.privateKey),
        publicJwk: await crypto.subtle.exportKey("jwk", pair.publicKey),
      }
    }
    const keys = [await generate("k1"), await generate("k2")]
    const api = new OAuthAPI({ ...base, signingKeys: keys })
    const jwks = async () => (await api.fetch(new Request(`${issuer}/jwks`))).json()
    expect((await jwks()).keys.map((k: { kid: string }) => k.kid)).toEqual(["k1"])
    const { tokens } = await run(api)
    expect(decodeProtectedHeader(tokens.id_token).kid).toBe("k1")
    await jwtVerify(tokens.id_token, createLocalJWKSet(await jwks()), {
      issuer,
      audience: "app",
      currentDate: new Date(now),
    })
    expect(api.rotateSigningKey().kid).toBe("k2")
    expect((await jwks()).keys.map((k: { kid: string }) => k.kid)).toEqual(["k2", "k1"])
    expect((await jwks()).keys[1].n).toBe(keys[0]?.publicJwk.n)
  })

  test("ID-token faults sign deterministically under a seed, including the unpublished key", async () => {
    const options: OAuthAPIOptions = {
      ...base,
      seed: "faults",
      deterministicCredentials: true,
      behavior: { tokens: { idTokenSigningKey: "unpublished", idTokenClockSkewSeconds: 600 } },
    }
    const first = await run(new OAuthAPI(options))
    const second = await run(new OAuthAPI(options))
    expect(second.transcript).toBe(first.transcript)
    const set = await (await new OAuthAPI(options).fetch(new Request(`${issuer}/jwks`))).json()
    const { kid } = decodeProtectedHeader(first.tokens.id_token)
    expect(set.keys.map((k: { kid: string }) => k.kid)).not.toContain(kid)
    const api = new OAuthAPI(options)
    await run(api)
    await api.reset()
    expect((await run(api)).transcript).toBe(first.transcript)
  })

  test("without the option credentials stay cryptographically random", async () => {
    const first = await run(new OAuthAPI({ ...base, seed: "s1" }))
    const second = await run(new OAuthAPI({ ...base, seed: "s1" }))
    expect(second.code).not.toBe(first.code)
    expect(second.tx).not.toBe(first.tx)
    expect(second.tokens.access_token).not.toBe(first.tokens.access_token)
    expect(first.tokens.access_token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    const kid = async () =>
      (await (await new OAuthAPI(base).fetch(new Request(`${issuer}/jwks`))).json()).keys[0].kid
    expect(await kid()).not.toBe(await kid())
  })
})
