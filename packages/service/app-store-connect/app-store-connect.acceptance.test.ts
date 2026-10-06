import { expect, test } from "bun:test"
import {
  APP_STORE_CONNECT_PRESETS,
  createRuntime,
  DEFAULT_RESOURCES,
  type Resource,
} from "./src/index.js"
import { createServer } from "./src/server.js"
import { call, credentials, enumerate } from "./test/consumer.js"

const origin = "http://apple.mock"
test("seeded resource relationships initialize durable membership edges", async () => {
  const auth = await credentials()
  const runtime = createRuntime({
    keys: [auth.key],
    resources: [
      ...DEFAULT_RESOURCES,
      { type: "betaTesters", id: "tester_seed", attributes: { email: "seed@example.test" } },
      {
        type: "betaGroups",
        id: "group_seed",
        attributes: { name: "Seed group" },
        relationships: {
          app: { data: { type: "apps", id: "app_mock" } },
          betaTesters: { data: [{ type: "betaTesters", id: "tester_seed" }] },
        },
      },
      {
        type: "users",
        id: "user_seed",
        attributes: { username: "seed@example.test" },
        relationships: { visibleApps: { data: [{ type: "apps", id: "app_mock" }] } },
      },
    ],
  })
  const token = await auth.token(runtime.clock.now())
  expect(
    (
      await enumerate(
        runtime.fetch.bind(runtime),
        origin,
        token,
        "/v1/betaGroups/group_seed/betaTesters",
      )
    )[0]?.id,
  ).toBe("tester_seed")
  expect(runtime.instance().visibleApps.count()).toBe(1)
  await runtime.reset()
  expect(runtime.instance().memberships.count()).toBe(1)
})
const appLink = { app: { data: { type: "apps", id: "app_mock" } } }
const invitationBody = {
  data: {
    type: "userInvitations",
    attributes: {
      email: "synthetic@example.test",
      firstName: "Synthetic",
      lastName: "Tester",
      roles: ["DEVELOPER"],
    },
  },
}
test("JSON:API apps/testers pagination uses local origin, sparse fields and namespaces", async () => {
  const auth = await credentials()
  const resources: Resource[] = [
    ...DEFAULT_RESOURCES,
    {
      type: "apps",
      id: "app_second",
      attributes: { name: "Second", bundleId: "test.example.second" },
    },
    { type: "betaTesters", id: "tester_a", attributes: { email: "a@example.test" } },
    { type: "betaTesters", id: "tester_b", attributes: { email: "b@example.test" } },
  ]
  const runtime = createRuntime({ keys: [auth.key], resources, adminPrefix: "/_control" })
  const token = await auth.token(runtime.clock.now()),
    send = runtime.fetch.bind(runtime)
  expect((await enumerate(send, origin, token, "/v1/apps?limit=1")).map((row) => row.id)).toEqual([
    "app_mock",
    "app_second",
  ])
  expect((await enumerate(send, origin, token, "/v1/betaTesters?limit=1")).length).toBe(2)
  runtime.instance("isolated").resources.delete("betaTesters:tester_a")
  expect(
    (await enumerate(send, origin, token, "/_control/ns/isolated/v1/betaTesters?limit=1")).map(
      (row) => row.id,
    ),
  ).toEqual(["tester_b"])
  expect(
    (await enumerate(send, origin, token, "/v1/apps?fields[apps]=name"))[0]?.attributes,
  ).toEqual({ name: "Synthetic App" })
})
test("create groups/testers and add/remove only membership edges with atomic validation", async () => {
  const auth = await credentials(),
    runtime = createRuntime({ keys: [auth.key] })
  const token = await auth.token(runtime.clock.now()),
    send = runtime.fetch.bind(runtime)
  const group = await (
    await call(send, origin, token, "/v1/betaGroups", {
      data: { type: "betaGroups", attributes: { name: "Synthetic Group" }, relationships: appLink },
    })
  ).json()
  const tester = await (
    await call(send, origin, token, "/v1/betaTesters", {
      data: {
        type: "betaTesters",
        attributes: { email: "tester@example.test", firstName: "Synthetic" },
      },
    })
  ).json()
  const path = `/v1/betaGroups/${group.data.id}/relationships/betaTesters`
  const linkage = { data: [{ type: "betaTesters", id: tester.data.id }] }
  expect(
    (
      await call(send, origin, token, path, {
        data: [...linkage.data, { type: "betaTesters", id: "missing" }],
      })
    ).status,
  ).toBe(409)
  expect(runtime.instance().memberships.count()).toBe(0)
  expect((await call(send, origin, token, path, linkage)).status).toBe(204)
  expect(
    (await enumerate(send, origin, token, `/v1/betaGroups/${group.data.id}/betaTesters`))[0]?.id,
  ).toBe(tester.data.id)
  expect(
    (await enumerate(send, origin, token, "/v1/betaTesters?filter[app]=app_mock")).length,
  ).toBe(1)
  expect((await call(send, origin, token, path, linkage, "DELETE")).status).toBe(204)
  expect(
    await enumerate(send, origin, token, `/v1/betaGroups/${group.data.id}/betaTesters`),
  ).toEqual([])
  expect((await enumerate(send, origin, token, "/v1/betaTesters")).length).toBe(1)
  expect((await enumerate(send, origin, token, "/v1/betaGroups")).length).toBe(1)
})
test("invitation deletion and user visibleApps affect only requested resources", async () => {
  const auth = await credentials(),
    runtime = createRuntime({
      keys: [auth.key],
      resources: [
        ...DEFAULT_RESOURCES,
        {
          type: "users",
          id: "user_mock",
          attributes: {
            username: "user@example.test",
            firstName: "Synthetic",
            lastName: "User",
            roles: ["DEVELOPER"],
          },
        },
      ],
    })
  const token = await auth.token(runtime.clock.now()),
    send = runtime.fetch.bind(runtime)
  const created = await call(send, origin, token, "/v1/userInvitations", invitationBody)
  expect(created.status).toBe(201)
  const invitation = await created.json()
  expect((await call(send, origin, token, "/v1/userInvitations", invitationBody)).status).toBe(409)
  expect(
    (
      await call(
        send,
        origin,
        token,
        `/v1/userInvitations/${invitation.data.id}`,
        undefined,
        "DELETE",
      )
    ).status,
  ).toBe(204)
  expect(await enumerate(send, origin, token, "/v1/userInvitations")).toEqual([])
  expect(
    (
      await call(send, origin, token, "/v1/users/user_mock/relationships/visibleApps", {
        data: [{ type: "apps", id: "app_mock" }],
      })
    ).status,
  ).toBe(204)
  expect(runtime.instance().visibleApps.count()).toBe(1)
  expect((await call(send, origin, token, "/v1/users/user_mock", undefined, "DELETE")).status).toBe(
    204,
  )
  expect(runtime.instance().visibleApps.count()).toBe(0)
  expect((await enumerate(send, origin, token, "/v1/apps")).length).toBe(1)
})
test("verified JWT expiry, issuer, audience, signatures, key revocation and scope guard mutations", async () => {
  const auth = await credentials(),
    other = await credentials(),
    runtime = createRuntime({ keys: [auth.key] })
  runtime.clock.freeze()
  const now = runtime.clock.now(),
    send = runtime.fetch.bind(runtime)
  for (const token of [
    await auth.token(now, { exp: Math.floor(now / 1000) - 1 }),
    await auth.token(now, { aud: "wrong" }),
    await auth.token(now, { iss: "wrong" }),
    await auth.token(now, { exp: Math.floor(now / 1000) + 1201 }),
    await other.token(now),
    "malformed",
  ]) {
    const response = await call(send, origin, token, "/v1/userInvitations", invitationBody)
    expect(response.status).toBe(401)
    expect((await response.json()).errors[0].code).toBe("NOT_AUTHORIZED")
  }
  expect(runtime.instance().resources.count()).toBe(1)
  const scoped = await auth.token(now, { scope: ["GET /v1/apps"] })
  expect((await call(send, origin, scoped, "/v1/apps?limit=1")).status).toBe(200)
  expect((await call(send, origin, scoped, "/v1/userInvitations", invitationBody)).status).toBe(403)
  runtime.instance().keys.update(auth.key.id, { ...auth.key, enabled: false })
  expect((await call(send, origin, await auth.token(now), "/v1/apps")).status).toBe(401)
})
test("role-denied writes preserve state and namespace revocation does not leak", async () => {
  const auth = await credentials("FINANCE"),
    runtime = createRuntime({ keys: [auth.key] })
  const token = await auth.token(runtime.clock.now()),
    send = runtime.fetch.bind(runtime)
  expect((await call(send, origin, token, "/v1/userInvitations", invitationBody)).status).toBe(403)
  expect(runtime.instance().resources.count()).toBe(1)
  runtime.instance("one").keys.delete(auth.key.id)
  expect((await call(send, origin, token, "/__admin/ns/one/v1/apps")).status).toBe(401)
  expect((await call(send, origin, token, "/__admin/ns/two/v1/apps")).status).toBe(200)
})
test("served HTTP, credential mapping, reset, presets and metadata-only journal", async () => {
  const auth = await credentials(),
    server = await createServer({ keys: [auth.key] })
  try {
    const token = await auth.token(server.runtime.clock.now()),
      send = (request: Request) => fetch(request)
    expect((await call(send, server.url, token, "/v1/apps")).status).toBe(200)
    const admin = (path: string, body: unknown, method = "POST") =>
      fetch(`${server.url}/__admin${path}`, {
        method,
        headers: { "content-type": "application/json", "x-emulates-namespace": "mapped" },
        body: JSON.stringify(body),
      })
    await admin("/credentials", { credentials: { [token]: "mapped" } }, "PUT")
    expect(
      (await call(send, server.url, token, "/v1/userInvitations", invitationBody)).status,
    ).toBe(201)
    expect(server.runtime.instance("mapped").resources.count()).toBe(2)
    for (const preset of Object.keys(APP_STORE_CONNECT_PRESETS)) {
      await admin("/faults", { preset, count: 1 })
      const req = () => call(send, server.url, token, "/v1/userInvitations", invitationBody)
      if (preset === "connection_drop") await expect(req()).rejects.toThrow()
      else
        expect((await req()).status).toBe(
          (
            {
              unauthorized: 401,
              forbidden: 403,
              duplicate: 409,
              rate_limited: 429,
              server_error: 500,
            } as Record<string, number>
          )[preset] ?? 0,
        )
    }
    const journal = await (
      await fetch(`${server.url}/__admin/requests`, {
        headers: { "x-emulates-namespace": "mapped" },
      })
    ).text()
    expect(journal).not.toContain(token)
    expect(journal).not.toContain("synthetic@example.test")
    await admin("/reset", {})
    expect(server.runtime.instance("mapped").resources.count()).toBe(1)
  } finally {
    await server.close()
  }
})
