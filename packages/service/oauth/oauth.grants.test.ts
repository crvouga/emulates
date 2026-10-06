import { expect, test } from "bun:test"
import { createRuntime, type OAuthRuntime, type Provider } from "./src/index.js"

const origin = "https://identity.test"
const callback = "https://app.test/callback"
const accounts = [
  { id: "ada", name: "Ada Lovelace", email: "ada@example.test" },
  { id: "grace", name: "Grace Hopper", email: "Grace@example.test" },
]
const client = { id: "app", name: "App", secret: "fixture", redirectUris: [callback] }
const make = (provider: Provider) => createRuntime({ provider, accounts, clients: [client] })
const field = (html: string, name: string) =>
  new RegExp(`name="${name}" value="([^"]*)"`).exec(html)?.[1] ?? ""
const form = (path: string, body: Record<string, string>, ns?: string) =>
  new Request(origin + path, {
    method: "POST",
    headers: ns ? { "x-emulates-namespace": ns } : {},
    body: new URLSearchParams(body),
  })
const AUTHORIZE: Record<string, string> = { apple: "/auth/authorize", google: "/o/oauth2/v2/auth" }

/** Authorize an account for `app` through the real interactive flow. */
async function authorize(
  runtime: OAuthRuntime,
  options: {
    account?: string
    scope?: string
    extra?: Record<string, string>
    choice?: string
    ns?: string
  } = {},
) {
  const provider = runtime.instance(options.ns).provider
  const query = new URLSearchParams({
    client_id: "app",
    redirect_uri: callback,
    response_type: "code",
    scope: options.scope ?? (provider === "apple" ? "openid name email" : "openid email profile"),
    ...(provider === "apple" ? { response_mode: "form_post" } : {}),
    ...options.extra,
  })
  const start = await runtime.fetch(
    new Request(`${origin}${AUTHORIZE[provider] ?? "/authorize"}?${query}`, {
      headers: options.ns ? { "x-emulates-namespace": options.ns } : {},
    }),
  )
  const tx = field(await start.text(), "transaction")
  expect(tx).not.toBe("")
  const pick = { transaction: tx, action: "select", account: options.account ?? "ada" }
  await runtime.fetch(form("/interaction", pick, options.ns))
  const allow = {
    transaction: tx,
    action: "allow",
    ...(options.choice ? { email_choice: options.choice } : {}),
  }
  const done = await runtime.fetch(form("/interaction", allow, options.ns))
  expect(done.status).toBeLessThan(400)
}
const admin = async (runtime: OAuthRuntime, path: string, init?: RequestInit) => {
  const response = await runtime.fetch(new Request(`${origin}/__admin${path}`, init))
  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown> & { grants: unknown[] },
  }
}

test("1. an Apple account that never authorized a client reports its would-be subject and its real address", async () => {
  const runtime = make("apple")
  const view = await runtime.instance().grant("app", "ada")
  expect(view).toEqual({
    subject: expect.any(String),
    granted: false,
    scopes: [],
    emailChoice: null,
    email: "ada@example.test",
    isPrivateEmail: false,
    userDisclosed: false,
  })
  // The subject it would receive is the one the first authorization then issues.
  await authorize(runtime, { choice: "share" })
  expect((await runtime.instance().grant("app", "ada"))?.subject).toBe(view?.subject)
  expect((await runtime.instance().grant("app", "grace"))?.subject).not.toBe(view?.subject)
})

test("2. Hide My Email is reported with the relay address, private flag and first-use disclosure", async () => {
  const runtime = make("apple")
  await authorize(runtime, { choice: "hide" })
  const view = await runtime.instance().grant("app", "ada")
  expect(view).toMatchObject({
    granted: true,
    scopes: ["openid", "name", "email"],
    emailChoice: "hide",
    isPrivateEmail: true,
    userDisclosed: true,
  })
  expect(view?.email).toMatch(/^[a-z0-9]+@privaterelay\.appleid\.com$/)
  const shared = make("apple")
  await authorize(shared, { choice: "share" })
  expect(await shared.instance().grant("app", "ada")).toMatchObject({
    granted: true,
    emailChoice: "share",
    email: "ada@example.test",
    isPrivateEmail: false,
  })
})

test("3. revoking a consent clears the grant and the email choice but keeps the subject", async () => {
  const runtime = make("apple")
  await authorize(runtime, { choice: "hide" })
  const before = await runtime.instance().grant("app", "ada")
  const revoke = await admin(runtime, "/consents/revoke", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ clientId: "app", accountId: "ada" }),
  })
  expect(revoke.status).toBe(200)
  const after = await runtime.instance().grant("app", "ada")
  expect(after).toMatchObject({
    granted: false,
    scopes: [],
    emailChoice: null,
    email: "ada@example.test",
    isPrivateEmail: false,
    userDisclosed: false,
  })
  expect(after?.subject).toBe(before?.subject)
})

test("4. Google subject is the account id and scopes follow include_granted_scopes merges", async () => {
  const runtime = make("google")
  expect((await runtime.instance().grant("app", "ada"))?.granted).toBe(false)
  await authorize(runtime, { scope: "openid email" })
  expect(await runtime.instance().grant("app", "ada")).toEqual({
    subject: "ada",
    granted: true,
    scopes: ["openid", "email"],
    emailChoice: null,
    email: "ada@example.test",
    isPrivateEmail: false,
    userDisclosed: false,
  })
  await authorize(runtime, {
    scope: "openid profile",
    extra: { include_granted_scopes: "true", prompt: "consent" },
  })
  expect((await runtime.instance().grant("app", "ada"))?.scopes).toEqual([
    "openid",
    "email",
    "profile",
  ])
})

test("5. the admin route answers per account, per email and per client, and respects namespaces", async () => {
  const runtime = make("apple")
  await authorize(runtime, { choice: "hide", ns: "a" })
  const byId = await admin(runtime, "/grants?clientId=app&accountId=ada&namespace=a")
  expect(byId.status).toBe(200)
  expect(byId.body as unknown).toEqual(await runtime.instance("a").grant("app", "ada"))
  expect(byId.body).toMatchObject({ granted: true, emailChoice: "hide" })
  const byEmail = await admin(runtime, "/grants?clientId=app&email=ADA@example.test&namespace=a")
  expect(byEmail.body).toEqual(byId.body)
  const list = await admin(runtime, "/grants?clientId=app", {
    headers: { "x-emulates-namespace": "a" },
  })
  expect(list.body.grants).toEqual([{ accountId: "ada", ...byId.body }])
  // Another namespace has not seen the authorization.
  const other = await admin(runtime, "/grants?clientId=app&accountId=ada&namespace=b")
  expect(other.body).toMatchObject({ granted: false, emailChoice: null })
  expect((await admin(runtime, "/grants?clientId=app&namespace=b")).body.grants).toEqual([])
})

test("the admin route rejects incomplete queries and unknown ids, and the API returns null", async () => {
  const runtime = make("oidc")
  expect(await runtime.instance().grant("nope", "ada")).toBeNull()
  expect(await runtime.instance().grant("app", "nope")).toBeNull()
  expect((await admin(runtime, "/grants")).status).toBe(400)
  expect((await admin(runtime, "/grants?accountId=ada")).status).toBe(400)
  const both = "/grants?clientId=app&accountId=ada&email=ada@example.test"
  expect((await admin(runtime, both)).status).toBe(400)
  expect((await admin(runtime, "/grants?clientId=nope")).status).toBe(404)
  expect((await admin(runtime, "/grants?clientId=nope&accountId=ada")).status).toBe(404)
  expect((await admin(runtime, "/grants?clientId=app&accountId=nope")).status).toBe(404)
  expect((await admin(runtime, "/grants?clientId=app&email=nobody@example.test")).status).toBe(404)
})
