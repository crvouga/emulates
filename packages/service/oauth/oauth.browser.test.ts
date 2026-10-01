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
