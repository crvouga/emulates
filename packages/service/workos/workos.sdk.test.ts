import { expect, test } from "bun:test"
import { WorkOS } from "@workos-inc/node"
import { NextRequest } from "next/server.js"
import { createServer } from "./src/server.js"

test("WorkOS 9.3.1 and AuthKit Next.js 4.1.0 verify and refresh a real signed session", async () => {
  const server = await createServer({ accessTtlMs: 1000 })
  const url = new URL(server.url)
  const cookiePassword = "mock-only-cookie-password-not-for-production"
  const env = {
    WORKOS_API_HOSTNAME: url.hostname,
    WORKOS_API_PORT: url.port,
    WORKOS_API_HTTPS: "false",
    WORKOS_API_KEY: "mock_workos_key",
    WORKOS_CLIENT_ID: "client_mock",
    WORKOS_COOKIE_PASSWORD: cookiePassword,
    NEXT_PUBLIC_WORKOS_REDIRECT_URI: "http://localhost:3000/callback",
  }
  const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]))
  Object.assign(process.env, env)
  try {
    const workos = new WorkOS("mock_workos_key", {
      apiHostname: url.hostname,
      port: Number(url.port),
      https: false,
      clientId: "client_mock",
    })
    const pkce = await workos.pkce.generate()
    const authorizationUrl = workos.userManagement.getAuthorizationUrl({
      clientId: "client_mock",
      provider: "authkit",
      redirectUri: env.NEXT_PUBLIC_WORKOS_REDIRECT_URI,
      state: "sdk-state",
      codeChallenge: pkce.codeChallenge,
      codeChallengeMethod: "S256",
    })
    const redirect = await fetch(authorizationUrl, { redirect: "manual" })
    const location = redirect.headers.get("location")
    if (!location) throw new Error("Missing redirect")
    const callback = new URL(location)
    expect(callback.searchParams.get("state")).toBe("sdk-state")
    const code = callback.searchParams.get("code")
    if (!code) throw new Error("Missing authorization code")
    await expect(
      workos.userManagement.authenticateWithCode({ code, codeVerifier: "incorrect" }),
    ).rejects.toThrow()
    const auth = await workos.userManagement.authenticateWithCode({
      code,
      codeVerifier: pkce.codeVerifier,
      session: { sealSession: true, cookiePassword },
    })
    expect(auth.user.firstName).toBe("Synthetic")
    const { authkit } = await import("@workos-inc/authkit-nextjs")
    const request = () =>
      new NextRequest("http://localhost:3000/protected", {
        headers: { cookie: `wos-session=${auth.sealedSession}` },
      })
    const valid = await authkit(request())
    expect(valid.session.user?.id).toBe("user_mock")
    expect(valid.session.accessToken).toBe(auth.accessToken)
    // Mint an already-expired signed JWT using the mock clock; AuthKit must refresh it.
    server.runtime.clock.set(Date.now() - 10_000)
    server.runtime.clock.freeze()
    const renewed = await workos.userManagement.authenticateWithRefreshToken({
      refreshToken: auth.refreshToken,
      session: { sealSession: true, cookiePassword },
    })
    server.runtime.clock.set(Date.now())
    server.runtime.clock.unfreeze()
    const refreshed = await authkit(
      new NextRequest("http://localhost:3000/protected", {
        headers: { cookie: `wos-session=${renewed.sealedSession}` },
      }),
    )
    expect(refreshed.session.user?.id).toBe("user_mock")
    expect(refreshed.session.accessToken).not.toBe(renewed.accessToken)
    expect(refreshed.headers.get("set-cookie")).toContain("wos-session=")
    const users = await workos.userManagement.listUsers({ limit: 1 })
    expect(users.data[0]?.metadata).toEqual({ fixture: "true" })
    await expect(
      workos.userManagement.authenticateWithRefreshToken({ refreshToken: "mock-invalid" }),
    ).rejects.toThrow()
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await server.close()
  }
})
