import { expect, test } from "bun:test"
import { createClock } from "@emulates/service"
import { createLocalJWKSet, decodeJwt, exportJWK, generateKeyPair, jwtVerify } from "jose"
import { createRuntime, OAuthAPI, type OAuthAPIOptions } from "./src/index.js"

// Sign in with Apple server-to-server notifications:
// https://developer.apple.com/documentation/signinwithapplerestapi/processing-changes-for-sign-in-with-apple-accounts
const origin = "https://identity.test"
const callback = "https://app.test/callback"
const keys = await generateKeyPair("ES256", { extractable: true })
const publicKey = await exportJWK(keys.publicKey)
const appleClient = (id: string, notificationUrl?: string) => ({
  id,
  name: id,
  redirectUris: [callback],
  apple: {
    teamId: `TEAM-${id}`,
    keyId: `KEY-${id}`,
    publicKey,
    ...(notificationUrl ? { notificationUrl } : {}),
  },
})
const ada = { id: "ada", name: "Ada Lovelace", email: "ada@example.test" }
const grace = { id: "grace", name: "Grace Hopper", email: "grace@example.test" }
const field = (html: string, name: string) =>
  new RegExp(`name="${name}" value="([^"]*)"`).exec(html)?.[1] ?? ""
const post = (path: string, body: Record<string, string>) =>
  new Request(origin + path, { method: "POST", body: new URLSearchParams(body) })

type Delivery = { url: string; payload: string; contentType: string | null }
const collector = (status = 200) => {
  const seen: Delivery[] = []
  return {
    seen,
    fetch: async (request: Request) => {
      seen.push({
        url: request.url,
        payload: ((await request.json()) as { payload: string }).payload,
        contentType: request.headers.get("content-type"),
      })
      return new Response(null, { status })
    },
  }
}
const events = (delivery: Delivery) =>
  JSON.parse(decodeJwt(delivery.payload).events as string) as Record<string, unknown>

/** Signs an account in to a client through the real pages; returns the ID token's subject. */
async function signIn(api: OAuthAPI, clientId: string, accountId = "ada", choice?: string) {
  const query = new URLSearchParams({
    client_id: clientId,
    redirect_uri: callback,
    response_type: "code id_token",
    nonce: "n",
    scope: "openid email",
    response_mode: "form_post",
  })
  const start = await api.fetch(new Request(`${origin}/auth/authorize?${query}`))
  const transaction = field(await start.text(), "transaction")
  await api.fetch(post("/interaction", { transaction, action: "select", account: accountId }))
  const result = await api.fetch(
    post("/interaction", {
      transaction,
      action: "allow",
      ...(choice ? { email_choice: choice } : {}),
    }),
  )
  expect(result.status).toBe(200)
  const idToken = field(await result.text(), "id_token")
  expect(idToken).not.toBe("")
  return {
    cookie: result.headers.get("set-cookie")?.split(";")[0] ?? "",
    ...(decodeJwt(idToken) as { sub: string; email: string }),
  }
}
const make = (options: OAuthAPIOptions = {}) => {
  const hooks = collector()
  const api = new OAuthAPI({
    provider: "apple",
    issuer: origin,
    accounts: [ada, grace],
    clients: [appleClient("app", "https://app.test/apple-events")],
    webhooks: { fetch: hooks.fetch },
    ...options,
  })
  return { api, hooks }
}

test("a client's notificationUrl must be an HTTP(S) URL", () => {
  for (const bad of ["not a url", "ftp://app.test/x", "https://app.test/x#frag", "javascript:1"])
    expect(() => make({ clients: [appleClient("app", bad)] })).toThrow("notificationUrl")
  expect(() => make({ clients: [appleClient("app", "http://localhost:3000/hook")] })).not.toThrow()
})

test("revokeConsent POSTs a JWS-signed consent-revoked event to the client that held the consent", async () => {
  const clock = createClock(() => 1_700_000_000_000)
  const { api, hooks } = make({ now: clock.now })
  const identity = await signIn(api, "app")
  expect(await api.revokeConsent("app", "ada")).toEqual([
    { clientId: "app", type: "consent-revoked", delivered: true, status: 200 },
  ])
  expect(hooks.seen).toHaveLength(1)
  const [delivery] = hooks.seen
  if (!delivery) throw new Error("no delivery")
  expect(delivery.url).toBe("https://app.test/apple-events")
  expect(delivery.contentType).toBe("application/json")
  const jwks = createLocalJWKSet(await (await api.fetch(new Request(`${origin}/auth/keys`))).json())
  const { payload } = await jwtVerify(delivery.payload, jwks, { issuer: origin, audience: "app" })
  expect(payload.iat).toBe(1_700_000_000)
  expect(payload.jti).toBeString()
  expect(events(delivery)).toEqual({
    type: "consent-revoked",
    sub: identity.sub as string,
    event_time: 1_700_000_000_000,
  })
  // The consent is gone, so a second revoke has nobody to tell; nor does a client without a URL.
  expect(await api.revokeConsent("app", "ada")).toEqual([])
  expect(hooks.seen).toHaveLength(1)
})

test("each notification carries its own random jti and is signed by the current key", async () => {
  const { api, hooks } = make()
  await signIn(api, "app")
  await api.revokeConsent("app", "ada")
  await signIn(api, "app")
  api.rotateSigningKey(false)
  await api.revokeConsent("app", "ada")
  const [first, second] = hooks.seen
  if (!first || !second) throw new Error("expected two deliveries")
  expect(decodeJwt(first.payload).jti).not.toBe(decodeJwt(second.payload).jti)
  const jwks = createLocalJWKSet(await (await api.fetch(new Request(`${origin}/auth/keys`))).json())
  await jwtVerify(second.payload, jwks, { issuer: origin, audience: "app" })
  await expect(jwtVerify(first.payload, jwks)).rejects.toThrow()
})

test("a client without notificationUrl, or a failing endpoint, never blocks revocation", async () => {
  const quiet = make({ clients: [appleClient("app")] })
  await signIn(quiet.api, "app")
  expect(await quiet.api.revokeConsent("app", "ada")).toEqual([])
  expect(quiet.hooks.seen).toEqual([])
  const rejected = collector(500)
  const down = make({ webhooks: { fetch: rejected.fetch } })
  await signIn(down.api, "app")
  expect(await down.api.revokeConsent("app", "ada")).toEqual([
    { clientId: "app", type: "consent-revoked", delivered: false, status: 500 },
  ])
  const broken = make({
    webhooks: {
      fetch: async () => {
        throw new Error("connection refused")
      },
    },
  })
  await signIn(broken.api, "app")
  const [result] = await broken.api.revokeConsent("app", "ada")
  expect(result).toMatchObject({ delivered: false, error: "Error: connection refused" })
})

test("deleteAccount sends account-delete to every client holding a consent, then erases the account", async () => {
  const { api, hooks } = make({
    clients: [
      appleClient("app", "https://app.test/apple-events"),
      appleClient("second", "https://second.test/events"),
      appleClient("bystander", "https://bystander.test/events"),
    ],
  })
  const first = await signIn(api, "app")
  const second = await signIn(api, "second")
  await signIn(api, "bystander", "grace")
  const notifications = await api.deleteAccount("ada")
  expect(notifications.map((n) => [n.clientId, n.type, n.delivered])).toEqual([
    ["app", "account-delete", true],
    ["second", "account-delete", true],
  ])
  expect(hooks.seen.map((d) => d.url)).toEqual([
    "https://app.test/apple-events",
    "https://second.test/events",
  ])
  const [toFirst, toSecond] = hooks.seen
  if (!toFirst || !toSecond) throw new Error("expected two deliveries")
  expect(decodeJwt(toFirst.payload).aud).toBe("app")
  expect(events(toFirst)).toMatchObject({ type: "account-delete", sub: first.sub })
  expect(decodeJwt(toSecond.payload).aud).toBe("second")
  expect(events(toSecond)).toMatchObject({ type: "account-delete", sub: second.sub })
  expect(api.accounts.get("ada")).toBeUndefined()
  expect(api.accounts.get("grace")).toBeDefined()
  // The browser session is gone with the account, so the next sign-in has to choose again.
  const query = new URLSearchParams({
    client_id: "app",
    redirect_uri: callback,
    response_type: "code",
    scope: "openid",
  })
  const again = await api.fetch(
    new Request(`${origin}/auth/authorize?${query}`, { headers: { cookie: first.cookie } }),
  )
  expect(again.status).toBe(200)
  expect(await again.text()).not.toContain("Ada Lovelace")
  await expect(api.deleteAccount("ada")).rejects.toThrow("Unknown account")
})

test("setRelayForwarding tells only clients whose identity is a private relay address", async () => {
  const { api, hooks } = make({
    clients: [
      appleClient("hidden", "https://hidden.test/events"),
      appleClient("shared", "https://shared.test/events"),
    ],
  })
  const relay = await signIn(api, "hidden", "ada", "hide")
  await signIn(api, "shared", "ada", "share")
  const disabled = await api.setRelayForwarding("ada", false)
  expect(disabled.map((n) => [n.clientId, n.type])).toEqual([["hidden", "email-disabled"]])
  const [off] = hooks.seen
  if (!off) throw new Error("no delivery")
  expect(events(off)).toEqual({
    type: "email-disabled",
    sub: relay.sub as string,
    email: relay.email,
    is_private_email: "true",
    event_time: expect.any(Number),
  })
  expect(relay.email).toEndWith("@privaterelay.appleid.com")
  await api.setRelayForwarding("ada", true)
  expect(hooks.seen.map((d) => events(d).type)).toEqual(["email-disabled", "email-enabled"])
  // Sharing the real address means there is no relay to switch.
  expect(await api.setRelayForwarding("grace", true)).toEqual([])
  await expect(api.setRelayForwarding("nobody", true)).rejects.toThrow("Unknown account")
})

test("admin routes trigger notifications, await delivery, and validate input", async () => {
  const hooks = collector()
  const runtime = createRuntime({
    provider: "apple",
    issuer: origin,
    accounts: [ada],
    clients: [appleClient("app", "https://app.test/apple-events")],
    webhooks: { fetch: hooks.fetch },
    adminKey: "k",
  })
  const admin = (path: string, body: unknown, key = "k") =>
    runtime.fetch(
      new Request(`${origin}/__admin${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-emulates-admin-key": key },
        body: JSON.stringify(body),
      }),
    )
  await signIn(runtime.instance(), "app", "ada", "hide")
  expect(
    (await admin("/relay-forwarding", { accountId: "ada", forwarding: false }, "no")).status,
  ).toBe(401)
  const off = await admin("/relay-forwarding", { accountId: "ada", forwarding: false })
  expect(off.status).toBe(200)
  expect(await off.json()).toEqual({
    forwarding: false,
    notifications: [{ clientId: "app", type: "email-disabled", delivered: true, status: 200 }],
  })
  expect(hooks.seen).toHaveLength(1)
  expect((await admin("/relay-forwarding", { accountId: "ada", forwarding: "no" })).status).toBe(
    400,
  )
  expect((await admin("/relay-forwarding", { accountId: "ghost", forwarding: true })).status).toBe(
    404,
  )
  const revoked = await admin("/consents/revoke", { clientId: "app", accountId: "ada" })
  expect(await revoked.json()).toMatchObject({
    revoked: true,
    notifications: [{ type: "consent-revoked", delivered: true }],
  })
  await signIn(runtime.instance(), "app")
  expect((await admin("/accounts/delete", {})).status).toBe(400)
  expect((await admin("/accounts/delete", { accountId: "ghost" })).status).toBe(404)
  const deleted = await admin("/accounts/delete", { accountId: "ada" })
  expect(await deleted.json()).toMatchObject({
    deleted: true,
    notifications: [{ type: "account-delete", delivered: true }],
  })
  expect(hooks.seen.map((d) => events(d).type)).toEqual([
    "email-disabled",
    "consent-revoked",
    "account-delete",
  ])
  expect(decodeJwt(hooks.seen[2]?.payload ?? "").iss).toBe(origin)
  expect(runtime.instance().accounts.get("ada")).toBeUndefined()
})
