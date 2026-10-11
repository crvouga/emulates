import { expect, test } from "bun:test"
import { createRuntime } from "./src/runtime.js"

test("consent reaches an application through a cross-origin callback relay", async () => {
  const clientRequests: string[] = []
  const client = Bun.serve({
    port: 0,
    fetch(request) {
      clientRequests.push(request.url)
      return new Response("<h1>Client callback</h1>", {
        headers: { "content-type": "text/html" },
      })
    },
  })
  const apiRequests: string[] = []
  const api = Bun.serve({
    port: 0,
    fetch(request) {
      apiRequests.push(request.url)
      return Response.redirect(`${client.url}sso-callback?code=one-time-code`, 302)
    },
  })
  const callback = `${api.url}auth/callback/google`
  const runtime = createRuntime({
    provider: "google",
    accounts: [{ id: "alice", name: "Alice Example", email: "alice@example.com" }],
    clients: [{ id: "client", name: "Example App", secret: "fixture", redirectUris: [callback] }],
  })
  const provider = Bun.serve({ port: 0, fetch: (request) => runtime.fetch(request) })
  const view = new Bun.WebView({
    width: 1280,
    height: 1000,
    backend: { type: "chrome", url: false },
  })
  try {
    const authorize = new URL("o/oauth2/v2/auth", provider.url)
    authorize.search = new URLSearchParams({
      client_id: "client",
      redirect_uri: callback,
      response_type: "code",
      scope: "openid email profile",
      state: "example",
    }).toString()
    await view.navigate(authorize.href)
    const consentLoaded = new Promise<void>((resolve) => {
      view.onNavigated = () => resolve()
    })
    await view
      .click('[data-testid="oauth-mock-account-alice"]', { timeout: 3000 })
      .catch((error) => {
        if (!String(error).includes("navigated")) throw error
      })
    await consentLoaded
    await view.click('[data-testid="oauth-mock-allow"]', { timeout: 3000 }).catch((error) => {
      if (!String(error).includes("navigated")) throw error
    })
    for (let attempt = 0; attempt < 40 && clientRequests.length === 0; attempt++)
      await Bun.sleep(50)

    expect(apiRequests).toHaveLength(1)
    const apiCallback = new URL(apiRequests[0] ?? "http://invalid")
    expect(apiCallback.pathname).toBe("/auth/callback/google")
    expect(apiCallback.searchParams.get("code")).not.toBeNull()
    expect(apiCallback.searchParams.get("state")).toBe("example")
    expect(clientRequests.map((url) => new URL(url).pathname)).toContain("/sso-callback")
    expect(String(await view.evaluate("location.origin"))).toBe(client.url.origin)
  } finally {
    await view.close()
    provider.stop(true)
    api.stop(true)
    client.stop(true)
  }
}, 30_000)

// Sign in with Apple across three origins: the provider (A) hands the response to the relying
// party's callback (B) with a form POST, and B answers 302 to the application (C).
async function appleFormPost(scripts: boolean, run: (flow: AppleFormPostFlow) => Promise<void>) {
  const clientRequests: string[] = []
  const client = Bun.serve({
    port: 0,
    fetch(request) {
      clientRequests.push(request.url)
      return new Response("<h1>Client callback</h1>", {
        headers: { "content-type": "text/html" },
      })
    },
  })
  const posts: URLSearchParams[] = []
  const consumed = new Set<string>()
  const api = Bun.serve({
    port: 0,
    async fetch(request) {
      if (request.method !== "POST") return new Response(null, { status: 405 })
      const body = new URLSearchParams(await request.text())
      posts.push(body)
      const code = body.get("code") ?? ""
      // A one-time response: replaying it is the relying party's "invalid_state".
      if (!code || consumed.has(code))
        return Response.json({ error: "invalid_state" }, { status: 400 })
      consumed.add(code)
      return Response.redirect(`${client.url}sso-callback?code=one-time-code`, 302)
    },
  })
  const callback = `${api.url}auth/callback/apple`
  const runtime = createRuntime({
    provider: "apple",
    accounts: [{ id: "alice", name: "Alice Example", email: "alice@example.com" }],
    clients: [{ id: "client", name: "Example App", secret: "fixture", redirectUris: [callback] }],
  })
  const provider = Bun.serve({ port: 0, fetch: (request) => runtime.fetch(request) })
  const view = new Bun.WebView({
    width: 1280,
    height: 1000,
    backend: { type: "chrome", url: false },
  })
  const click = async (selector: string) => {
    if (scripts) return view.click(selector, { timeout: 3000 })
    // click(selector) waits on page script, so without it find the element and click its centre.
    const locate = `(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return "";e.scrollIntoView({block:"center",behavior:"instant"});return JSON.stringify(e.getBoundingClientRect())})()`
    let found = ""
    for (let attempt = 0; attempt < 60 && !found; attempt++) {
      found = String(await view.evaluate(locate))
      if (!found) await Bun.sleep(50)
    }
    if (!found) throw new Error(`No element matches ${selector}`)
    const box = JSON.parse(found) as { x: number; y: number; width: number; height: number }
    await view.click(box.x + box.width / 2, box.y + box.height / 2)
  }
  const step = async (selector: string) => {
    const navigated = new Promise<void>((resolve) => {
      view.onNavigated = () => resolve()
    })
    await click(selector).catch((error) => {
      if (!String(error).includes("navigated")) throw error
    })
    // A navigation the browser refuses never reports; the assertions below then name the failure.
    await Promise.race([navigated, Bun.sleep(3000)])
  }
  try {
    const authorize = new URL("auth/authorize", provider.url)
    authorize.search = new URLSearchParams({
      client_id: "client",
      redirect_uri: callback,
      response_type: "code",
      response_mode: "form_post",
      scope: "name email",
      state: "example",
    }).toString()
    await view.navigate(authorize.href)
    if (!scripts) await view.cdp("Emulation.setScriptExecutionDisabled", { value: true })
    await run({
      view,
      click,
      step,
      posts,
      providerOrigin: provider.url.origin,
      // Long enough for a second submission to land, so "exactly one" is not a race.
      async arrive() {
        for (let attempt = 0; attempt < 40 && clientRequests.length === 0; attempt++)
          await Bun.sleep(50)
        await Bun.sleep(200)
      },
    })

    expect(posts).toHaveLength(1)
    expect(posts[0]?.get("code")).toBeTruthy()
    expect(posts[0]?.get("state")).toBe("example")
    const arrivals = clientRequests.filter((url) => new URL(url).pathname === "/sso-callback")
    expect(arrivals).toHaveLength(1)
    expect(String(await view.evaluate("location.origin"))).toBe(client.url.origin)
  } finally {
    await view.close()
    provider.stop(true)
    api.stop(true)
    client.stop(true)
  }
}
type AppleFormPostFlow = {
  view: Bun.WebView
  click: (selector: string) => Promise<void>
  step: (selector: string) => Promise<void>
  posts: URLSearchParams[]
  providerOrigin: string
  arrive: () => Promise<void>
}

test("Apple form_post reaches an application through a cross-origin callback relay", async () => {
  await appleFormPost(true, async ({ click, step, arrive }) => {
    await step('[data-testid="oauth-mock-account-alice"]')
    await click('[data-testid="oauth-mock-share-email"]')
    await step('[data-testid="oauth-mock-allow"]')
    await arrive()
  })
}, 30_000)

test("Apple form_post Continue reaches the application with JavaScript disabled", async () => {
  await appleFormPost(false, async ({ view, step, posts, providerOrigin, arrive }) => {
    await step('[data-testid="oauth-mock-account-alice"]')
    await step('[data-testid="oauth-mock-allow"]')
    // Without scripts the hand-off page waits on the provider for the Continue button.
    await Bun.sleep(200)
    expect(posts).toHaveLength(0)
    expect(String(await view.evaluate("location.origin"))).toBe(providerOrigin)
    await step('[data-testid="oauth-mock-form-post-continue"]')
    await arrive()
  })
}, 30_000)
