import { expect, test } from "bun:test"
import { createClock } from "@crvouga/mockingbird-service"
import { importJWK, type JWK, jwtVerify } from "jose"
import { createServer as appleServer } from "../../../service/apple/src/server.js"
import { createServer as clerkServer } from "../../../service/clerk/src/server.js"
import { createServer as googleServer } from "../../../service/google/src/server.js"
import { createServer as microsoftServer } from "../../../service/microsoft/src/server.js"
import { createServer as oktaServer } from "../../../service/okta/src/server.js"

for (const [name, create] of Object.entries({
  google: googleServer,
  apple: appleServer,
  microsoft: microsoftServer,
  okta: oktaServer,
  clerk: clerkServer,
})) {
  test(`${name}: OIDC discovery uses the bound listener and namespace carrier`, async () => {
    const server = await create({ port: 0 })
    try {
      for (const prefix of ["", "/__admin/ns/oauth-fixture"]) {
        const response = await fetch(`${server.url}${prefix}/.well-known/openid-configuration`)
        expect(response.status).toBe(200)
        const config = (await response.json()) as {
          authorization_endpoint: string
          token_endpoint: string
          jwks_uri: string
        }
        for (const endpoint of [
          config.authorization_endpoint,
          config.token_endpoint,
          config.jwks_uri,
        ])
          expect(endpoint).toStartWith(`${server.url}${prefix}/`)
        const jwks = await fetch(config.jwks_uri)
        expect(jwks.status).toBe(200)
        expect(((await jwks.json()) as { keys: unknown[] }).keys).toHaveLength(1)
      }
    } finally {
      await server.close()
    }
  })
}

test("Google: HTTP OAuth tokens use the native clock and verify against the advertised JWKS", async () => {
  const clock = createClock(() => 1700000000000)
  clock.freeze()
  const redirect = "http://localhost:3000/fixture-callback"
  const server = await googleServer({
    port: 0,
    clock,
    fixtures: {
      users: [{ email: "fixture@example.test", name: "Fixture" }],
      oauth_clients: [
        { client_id: "fixture-client", client_secret: "fixture-secret", redirect_uris: [redirect] },
      ],
    },
  })
  try {
    const prefix = "/__admin/ns/oauth-fixture"
    const config = (await fetch(`${server.url}${prefix}/.well-known/openid-configuration`).then(
      (response) => response.json(),
    )) as { issuer: string; token_endpoint: string; jwks_uri: string }
    const authorize = await fetch(`${server.url}${prefix}/o/oauth2/v2/auth/callback`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        email: "fixture@example.test",
        redirect_uri: redirect,
        scope: "openid email profile",
        client_id: "fixture-client",
      }),
    })
    expect(authorize.status).toBe(302)
    const code = new URL(authorize.headers.get("location") ?? "").searchParams.get("code")
    expect(code).toBeString()
    const response = await fetch(config.token_endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code: code ?? "",
        grant_type: "authorization_code",
        redirect_uri: redirect,
        client_id: "fixture-client",
        client_secret: "fixture-secret",
      }),
    })
    expect(response.status).toBe(200)
    const token = (await response.json()) as { id_token: string }
    const jwks = (await fetch(config.jwks_uri).then((response) => response.json())) as {
      keys: JWK[]
    }
    const key = jwks.keys[0]
    expect(key).toBeDefined()
    if (!key) throw new Error("Missing fixture signing key")
    const verified = await jwtVerify(token.id_token, await importJWK(key, "RS256"), {
      issuer: config.issuer,
      audience: "fixture-client",
      currentDate: new Date(clock.now()),
    })
    expect(verified.payload).toMatchObject({
      iat: 1700000000,
      exp: 1700003600,
      email: "fixture@example.test",
    })
  } finally {
    await server.close()
  }
})
