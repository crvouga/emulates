import { expect, test } from "bun:test"
import { createLocalJWKSet, jwtVerify } from "jose"
import { digest } from "./src/crypto.js"
import { createRuntime, DEFAULT_USERS, WORKOS_PRESETS } from "./src/index.js"
import { createServer } from "./src/server.js"
import { authenticate, authorize, userMirror } from "./test/consumer.js"

const origin = "http://mock.workos.local"
test("concurrent PKCE exchanges consume a code exactly once", async () => {
  const runtime = createRuntime()
  const verifier = "synthetic-pkce-verifier-for-concurrent-exchange"
  const challenge = await digest(verifier)
  const url = new URL(`${origin}/user_management/authorize`)
  url.search = new URLSearchParams({
    client_id: "client_mock",
    redirect_uri: "http://localhost:3000/callback",
    response_type: "code",
    provider: "authkit",
    code_challenge: challenge,
    code_challenge_method: "S256",
  }).toString()
  const redirect = await runtime.fetch(new Request(url))
  const location = redirect.headers.get("location")
  if (!location) throw new Error("Expected callback")
  const code = new URL(location).searchParams.get("code")
  const responses = await Promise.all(
    Array.from({ length: 4 }, () =>
      authenticate(runtime.fetch.bind(runtime), origin, {
        grant_type: "authorization_code",
        code,
        code_verifier: verifier,
      }),
    ),
  )
  expect(responses.map((response) => response.status).sort()).toEqual([200, 400, 400, 400])
  expect(runtime.instance().sessions.count()).toBe(1)
})
test("single-use authorization, state, shared metadata and isolated user pagination", async () => {
  const runtime = createRuntime({
    users: [
      ...DEFAULT_USERS,
      {
        first_name: "Second",
        last_name: "Synthetic",
        id: "user_second",
        email: "second@example.test",
        metadata: { number: "2" },
      },
    ],
  })
  const send = runtime.fetch.bind(runtime)
  const callback = await authorize(send, origin, "one")
  expect(callback.searchParams.get("state")).toBe("synthetic-state")
  const code = callback.searchParams.get("code")
  expect(
    (await authenticate(send, origin, { grant_type: "authorization_code", code }, "two")).status,
  ).toBe(400)
  const auth = await authenticate(send, origin, { grant_type: "authorization_code", code }, "one")
  expect(auth.status).toBe(200)
  const body = await auth.json()
  expect(body.user.metadata).toEqual({ fixture: "true" })
  expect(
    (await authenticate(send, origin, { grant_type: "authorization_code", code }, "one")).status,
  ).toBe(400)
  expect((await userMirror(send, origin, "one")).map((row) => row.id)).toEqual([
    "user_mock",
    "user_second",
  ])
  runtime.instance("one").users.delete("user_second")
  expect((await userMirror(send, origin, "one")).length).toBe(1)
  expect((await userMirror(send, origin, "two")).length).toBe(2)
})
test("signed access tokens expire; refresh rotates; revoked sessions cannot refresh", async () => {
  let time = 1_800_000_000_000
  const runtime = createRuntime({ accessTtlMs: 1000 })
  runtime.clock.set(time)
  runtime.clock.freeze()
  const send = runtime.fetch.bind(runtime)
  const code = (await authorize(send, origin)).searchParams.get("code")
  const body = await (
    await authenticate(send, origin, { grant_type: "authorization_code", code })
  ).json()
  const keys = createLocalJWKSet(
    await (await send(new Request(`${origin}/sso/jwks/client_mock`))).json(),
  )
  const verified = await jwtVerify(body.access_token, keys, { currentDate: new Date(time) })
  expect(verified.payload.sub).toBe("user_mock")
  time += 2000
  runtime.clock.set(time)
  await expect(
    jwtVerify(body.access_token, keys, { currentDate: new Date(time) }),
  ).rejects.toThrow()
  const refreshed = await (
    await authenticate(send, origin, {
      grant_type: "refresh_token",
      refresh_token: body.refresh_token,
    })
  ).json()
  expect(
    (await jwtVerify(refreshed.access_token, keys, { currentDate: new Date(time) })).payload.sub,
  ).toBe("user_mock")
  expect(
    (
      await authenticate(send, origin, {
        grant_type: "refresh_token",
        refresh_token: body.refresh_token,
      })
    ).status,
  ).toBe(400)
  const session = runtime.instance().sessions.list()[0]
  if (!session) throw new Error("Expected persisted session")
  runtime.instance().sessions.update(session.id, { ...session.value, revoked: true })
  expect(
    (
      await authenticate(send, origin, {
        grant_type: "refresh_token",
        refresh_token: refreshed.refresh_token,
      })
    ).status,
  ).toBe(400)
})
test("expired codes and unregistered redirects cannot authenticate", async () => {
  let time = 1_800_000_000_000
  const runtime = createRuntime({ codeTtlMs: 1 })
  runtime.clock.set(time)
  runtime.clock.freeze()
  const send = runtime.fetch.bind(runtime)
  const code = (await authorize(send, origin)).searchParams.get("code")
  time += 2
  runtime.clock.set(time)
  expect(
    (await authenticate(send, origin, { grant_type: "authorization_code", code })).status,
  ).toBe(400)
  expect(
    (
      await send(
        new Request(
          `${origin}/user_management/authorize?client_id=client_mock&redirect_uri=https://unregistered.example.test`,
        ),
      )
    ).status,
  ).toBe(400)
  expect(runtime.instance().sessions.count()).toBe(0)
})
test("served HTTP, reset, credential/path namespaces, presets and metadata-only journal", async () => {
  const server = await createServer()
  try {
    const send = (r: Request) => fetch(r)
    expect((await userMirror(send, server.url)).length).toBe(1)
    const admin = (path: string, body?: unknown, method = "POST") =>
      fetch(`${server.url}/__admin${path}`, {
        method,
        headers: { "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
    await admin("/credentials", { credentials: { mock_workos_key: "mapped" } }, "PUT")
    expect((await userMirror(send, server.url)).length).toBe(1)
    expect(server.runtime.namespaces()).toContain("mapped")
    expect(
      (
        await fetch(`${server.url}/__admin/ns/path/user_management/users`, {
          headers: { authorization: "Bearer mock_workos_key" },
        })
      ).status,
    ).toBe(200)
    for (const preset of Object.keys(WORKOS_PRESETS)) {
      await admin("/faults", { preset, count: 1 })
      const request = new Request(`${server.url}/user_management/authenticate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      })
      if (preset === "connection_drop") await expect(send(request)).rejects.toThrow()
      else
        expect((await send(request)).status).toBe(
          ({ auth_failure: 401, rate_limited: 429, server_error: 500 } as Record<string, number>)[
            preset
          ] ?? 0,
        )
    }
    await authorize(server.runtime.fetch.bind(server.runtime), server.url)
    expect(server.runtime.instance().codes.count()).toBe(1)
    await admin("/reset", {})
    expect(server.runtime.instance().codes.count()).toBe(0)
    const journal = await (await fetch(`${server.url}/__admin/requests`)).text()
    expect(journal).not.toContain("mock_workos_key")
    expect(journal).not.toContain("client_secret")
  } finally {
    await server.close()
  }
})
