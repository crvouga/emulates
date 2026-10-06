import { expect, test } from "bun:test"
import { createRuntime, createVaultKey, DEFAULT_TREE } from "./src/index.js"
import { createServer } from "./src/server.js"
import { InfisicalStore } from "./test/consumer.js"

type WireSecret = {
  id: string
  version: number
  secretKey: string
  secretValue: string
  secretComment: string
  secretPath: string
  environment: string
  tags: { slug: string }[]
  secretValueHidden: boolean
}
type Reply = {
  id: string
  secret: WireSecret
  secrets: WireSecret[]
  imports: { secrets: WireSecret[] }[]
  folders: { path: string }[]
  accessToken: string
  expiresIn: number
  message: unknown
  tokens: { id: string; machineId: string | null; revoked: boolean }[]
}
const body = async (r: Response) => (await r.json()) as Reply
const setup = () => {
  const runtime = createRuntime({ seed: 78 })
  return { runtime, client: new InfisicalStore((r) => runtime.fetch(r)) }
}

test("the reported store lists, creates and updates raw secrets while preserving version, tags and comments", async () => {
  const { runtime, client } = setup()
  try {
    const tree = structuredClone(DEFAULT_TREE)
    tree.environments[0]?.folders[0]?.secrets?.push({
      key: "TAGGED",
      value: "fixture-tag-value",
      comment: "fixture-comment",
      tags: [{ id: "fixture-tag", slug: "test", name: "Test" }],
      metadata: { fixture: "yes" },
    })
    expect((await client.admin("POST", "/project-tree", tree)).status).toBe(201)
    const listed = await body(await client.list("/", "&tagSlugs=test"))
    expect(listed.secrets.map((s) => s.secretKey)).toEqual(["TAGGED"])
    expect(listed).not.toHaveProperty("pagination")
    const created = await body(
      await client.write("POST", "CREATED", {
        secretValue: "  fixture-created  \n",
        secretComment: "  fixture-comment  ",
        tagIds: ["fixture-tag"],
        metadata: { test: "yes" },
      }),
    )
    expect(created.secret.secretValue).toBe("fixture-created\n")
    expect(created.secret.secretComment).toBe("fixture-comment")
    expect(created.secret.version).toBe(1)
    expect(created.secret.tags[0]?.slug).toBe("test")
    const updated = await body(
      await client.write("PATCH", "CREATED", {
        secretValue: "fixture-updated",
        secretComment: "fixture-next-comment",
      }),
    )
    expect(updated.secret.id).toBe(created.secret.id)
    expect(updated.secret.version).toBe(2)
    expect(updated.secret.secretPath).toBe("/")
    expect(updated.secret.environment).toBe("dev")
    expect(updated.secret.tags).toEqual(created.secret.tags)
    expect((await body(await client.get("CREATED", "/", 1))).secret.secretValue).toBe(
      "fixture-created\n",
    )
    expect((await body(await client.get("CREATED"))).secret.secretValue).toBe("fixture-updated")
    expect(
      (await client.write("POST", "CREATED", { secretValue: "fixture-duplicate" })).status,
    ).toBe(400)
    expect((await client.get("CREATED", "/", 999)).status).toBe(404)
    const hidden = await body(await client.list("/", "&viewSecretValue=false"))
    expect(hidden.secrets.every((s) => s.secretValue === "" && s.secretValueHidden)).toBe(true)
  } finally {
    runtime.stop?.()
  }
})

test("scoped machine tokens use the mock clock, renew within max TTL and can be revoked without exposing credentials", async () => {
  const { runtime, client } = setup()
  try {
    await client.admin("POST", "/clock", { set: "2024-01-02T00:00:00Z", freeze: true })
    const auth = await body(await client.login())
    expect(auth).toMatchObject({ expiresIn: 60, accessTokenMaxTTL: 3600, tokenType: "Bearer" })
    const machine = new InfisicalStore(
      (r) => runtime.fetch(r),
      client.base,
      undefined,
      auth.accessToken,
    )
    expect((await machine.get("APP_VALUE", "/app")).status).toBe(200)
    expect((await machine.list("/sibling")).status).toBe(403)
    expect((await machine.list("/")).status).toBe(403)
    expect((await machine.get("APP_VALUE", "/app/../sibling")).status).toBe(400)
    await client.admin("POST", "/clock", { advance: 30_000 })
    const renewed = await body(
      await client.request("POST", "/api/v1/auth/token/renew", { accessToken: auth.accessToken }),
    )
    expect(renewed.expiresIn).toBe(60)
    expect(renewed.accessToken).not.toBe(auth.accessToken)
    await client.admin("POST", "/clock", { advance: 30_000 })
    expect((await machine.list("/app")).status).toBe(403)
    const tokenMeta = await body(await client.admin("GET", "/tokens"))
    expect(JSON.stringify(tokenMeta)).not.toContain(auth.accessToken)
    const fresh = new InfisicalStore(
      (r) => runtime.fetch(r),
      client.base,
      undefined,
      renewed.accessToken,
    )
    expect((await fresh.list("/app")).status).toBe(200)
    expect((await client.admin("POST", "/machines/fixture-machine/revoke")).status).toBe(200)
    expect((await fresh.list("/app")).status).toBe(401)
    const nextAuth = await body(await client.login())
    const nextToken = (await body(await client.admin("GET", "/tokens"))).tokens.find(
      (t) => t.machineId === "fixture-machine" && !t.revoked,
    )
    expect(nextToken).toBeDefined()
    expect((await client.admin("POST", `/tokens/${nextToken?.id}/expire`)).status).toBe(200)
    const expired = new InfisicalStore(
      (r) => runtime.fetch(r),
      client.base,
      undefined,
      nextAuth.accessToken,
    )
    expect((await expired.list("/app")).status).toBe(403)
    expect((await client.admin("POST", `/tokens/${nextToken?.id}/revoke`)).status).toBe(200)
    expect((await expired.list("/app")).status).toBe(401)
    const bad = await client.request("POST", "/api/v1/auth/universal-auth/login", {
      clientId: "fixture-machine",
      clientSecret: "fixture-invalid",
    })
    expect(bad.status).toBe(401)
    expect(await body(bad)).toMatchObject({
      statusCode: 401,
      error: "UnauthorizedError",
      message: "Invalid credentials",
    })
  } finally {
    runtime.stop?.()
  }
})

test("admin key protection, encrypted state and Timeline snapshots keep values out of admin reads, journals, metrics and logs", async () => {
  const logs: unknown[] = []
  const runtime = createRuntime({ onLog: (e) => logs.push(e) })
  const client = new InfisicalStore((r) => runtime.fetch(r))
  try {
    const noKey = await runtime.fetch(new Request("http://infisical.fixture/__admin/state"))
    expect(noKey.status).toBe(401)
    expect(() => createRuntime({ adminKey: "" })).toThrow("must not be empty")
    await client.write("POST", "PRIVATE_FIXTURE", {
      secretValue: "fixture-private-regression-value",
      secretComment: "fixture-private-comment",
      metadata: { test: "fixture-private-metadata" },
    })
    const snapshot = await body(await client.admin("POST", "/snapshots"))
    await client.admin("POST", "/secrets/rotate", {
      projectId: "fixture-project",
      environment: "dev",
      secretName: "PRIVATE_FIXTURE",
      secretValue: "fixture-rotated-value",
    })
    expect((await body(await client.get("PRIVATE_FIXTURE"))).secret.version).toBe(2)
    const surfaces = [
      "/state",
      "/secrets",
      "/project-tree",
      "/requests",
      "/metrics",
      "/timeline",
      "/tokens",
    ]
    for (const path of surfaces) {
      const response = await client.admin("GET", path)
      expect(response.status).toBe(200)
      const text = await response.text()
      for (const secret of [
        "fixture-private-regression-value",
        "fixture-rotated-value",
        "fixture-client-secret",
        "fixture-private-comment",
        "fixture-private-metadata",
      ])
        expect(text).not.toContain(secret)
    }
    expect(JSON.stringify(runtime.state())).not.toContain("fixture-private-regression-value")
    expect(JSON.stringify(logs)).not.toContain("fixture-private-regression-value")
    expect((await client.admin("POST", `/snapshots/${snapshot.id}/restore`)).status).toBe(200)
    expect((await body(await client.get("PRIVATE_FIXTURE"))).secret.secretValue).toBe(
      "fixture-private-regression-value",
    )
    await client.admin("POST", "/reset")
    expect((await client.get("PRIVATE_FIXTURE")).status).toBe(404)
    expect((await body(await client.get("ROOT_VALUE"))).secret.version).toBe(1)
  } finally {
    runtime.stop?.()
  }
})

test("project trees normalize paths, import/export metadata, expand allowed references and reject invalid seeds atomically", async () => {
  const { runtime, client } = setup()
  try {
    const tree = structuredClone(DEFAULT_TREE)
    tree.environments[0]?.folders.push(
      { path: "/shared/", secrets: [{ key: "SHARED", value: "fixture-shared" }] },
      { path: "/app/nested", secrets: [{ key: "NESTED", value: "fixture-nested" }] },
    )
    const app = tree.environments[0]?.folders.find((f) => f.path === "/app")
    if (app) {
      app.imports = [{ environment: "dev", path: "/shared/" }]
      app.secrets?.push({ key: "REF", value: `\${dev.shared.SHARED}` })
    }
    expect((await client.admin("POST", "/project-tree", tree)).status).toBe(201)
    const listed = await body(
      await client.list(
        "/app/",
        "&recursive=true&include_imports=true&expandSecretReferences=true",
      ),
    )
    expect(listed.secrets.map((s) => s.secretKey)).toContain("NESTED")
    expect(listed.imports[0]).toMatchObject({ secretPath: "/shared", environment: "dev" })
    expect(listed.imports[0]?.secrets[0]?.secretValue).toBe("fixture-shared")
    expect(listed.secrets.find((s) => s.secretKey === "REF")?.secretValue).toBe("fixture-shared")
    const imported = await client.request(
      "GET",
      "/api/v3/secrets/raw/SHARED?workspaceId=fixture-project&environment=dev&secretPath=/app&include_imports=true",
    )
    expect((await body(imported)).secret.secretValue).toBe("fixture-shared")
    const machineAuth = await body(await client.login())
    const machine = new InfisicalStore(
      (r) => runtime.fetch(r),
      client.base,
      undefined,
      machineAuth.accessToken,
    )
    expect(
      (await machine.list("/app", "&include_imports=true&expandSecretReferences=true")).status,
    ).toBe(403)
    const machineList = await body(
      await machine.list("/app", "&include_imports=true&expandSecretReferences=false"),
    )
    expect(machineList.imports[0]?.secrets).toEqual([])
    expect(machineList.secrets.find((s) => s.secretKey === "REF")?.secretValue).toBe(
      `\${dev.shared.SHARED}`,
    )
    const before = JSON.stringify(runtime.state())
    const bad = structuredClone(tree)
    bad.project.id = "fixture-invalid-tree"
    bad.environments[0]?.folders.push({ path: "/../escape" })
    expect((await client.admin("POST", "/project-tree", bad)).status).toBe(400)
    expect(JSON.stringify(runtime.state())).toBe(before)
    const exported = await body(await client.admin("GET", "/project-tree"))
    expect(exported.folders.some((f) => f.path === "/shared")).toBe(true)
    expect(JSON.stringify(exported)).not.toContain("fixture-shared")
    expect(
      (
        await client.admin("POST", "/permissions/deny", {
          projectId: "fixture-project",
          environment: "dev",
          path: "/app",
        })
      ).status,
    ).toBe(201)
    expect((await machine.list("/app")).status).toBe(403)
  } finally {
    runtime.stop?.()
  }
})

test("legacy single-scope service tokens override caller location and expire on the mock clock", async () => {
  const tree = structuredClone(DEFAULT_TREE)
  tree.serviceTokens?.push({
    id: "fixture-scoped-service",
    token: "fixture-scoped-token",
    grants: [{ projectId: "fixture-project", environment: "dev", path: "/app" }],
    expiresAt: 1_700_000_030_000,
  })
  const runtime = createRuntime({ trees: [tree] })
  const client = new InfisicalStore((r) => runtime.fetch(r))
  try {
    await client.admin("POST", "/clock", { set: 1_700_000_000_000, freeze: true })
    const legacy = new InfisicalStore(
      (r) => runtime.fetch(r),
      client.base,
      undefined,
      "fixture-scoped-token",
    )
    expect((await body(await legacy.list("/sibling"))).secrets.map((s) => s.secretKey)).toEqual([
      "APP_VALUE",
    ])
    await client.admin("POST", "/clock", { advance: 30_000 })
    const expired = await legacy.list()
    expect(expired.status).toBe(403)
    expect(await body(expired)).toMatchObject({ message: "Service token has expired" })
  } finally {
    runtime.stop?.()
  }
})

test("namespaces, credential routing, custom prefix, resets, HTTP and fault controls preserve state and vendor shapes", async () => {
  const server = await createServer({ adminPrefix: "/_control/mock" })
  const a = new InfisicalStore(
    (r) => fetch(r),
    server.url,
    "suite-a",
    "fixture-service-token",
    "/_control/mock",
  )
  const b = new InfisicalStore(
    (r) => fetch(r),
    server.url,
    "suite-b",
    "fixture-service-token",
    "/_control/mock",
  )
  try {
    expect((await a.admin("GET", "/health")).status).toBe(200)
    const changes = await Promise.all([
      a.write("PATCH", "ROOT_VALUE", { secretValue: "fixture-suite-a" }),
      b.write("PATCH", "ROOT_VALUE", { secretValue: "fixture-suite-b" }),
    ])
    expect(changes.map((r) => r.status)).toEqual([200, 200])
    expect((await body(await b.get("ROOT_VALUE"))).secret.secretValue).toBe("fixture-suite-b")
    const prefixed = new InfisicalStore((r) => fetch(r), `${server.url}/_control/mock/ns/suite-a`)
    expect((await body(await prefixed.get("ROOT_VALUE"))).secret.secretValue).toBe(
      "fixture-suite-a",
    )
    const root = new InfisicalStore(
      (r) => fetch(r),
      server.url,
      undefined,
      "fixture-service-token",
      "/_control/mock",
    )
    await root.admin("PUT", "/credentials", { credentials: { "fixture-service-token": "suite-a" } })
    expect((await body(await root.get("ROOT_VALUE"))).secret.secretValue).toBe("fixture-suite-a")
    const auth = await body(await a.login())
    const cross = new InfisicalStore((r) => fetch(r), server.url, "suite-b", auth.accessToken)
    expect((await cross.list("/app")).status).toBe(401)
    await a.admin("POST", "/faults", { preset: "rate_limited", count: 1 })
    const rate = await a.list()
    expect(rate.status).toBe(429)
    expect(rate.headers.get("retry-after")).toBe("1")
    expect(await body(rate)).toMatchObject({ error: "RateLimitError", statusCode: 429 })
    expect((await a.list()).status).toBe(200)
    await a.admin("POST", "/faults", { preset: "missing_version", count: 1 })
    expect((await a.get("ROOT_VALUE")).status).toBe(404)
    expect((await a.get("ROOT_VALUE")).status).toBe(200)
    await a.admin("POST", "/faults", { preset: "server_error", count: 1 })
    expect((await a.list()).status).toBe(500)
    await a.admin("POST", "/faults", { preset: "network_reset", count: 1 })
    await expect(
      a.write("PATCH", "ROOT_VALUE", { secretValue: "fixture-dropped" }),
    ).rejects.toBeInstanceOf(TypeError)
    expect((await body(await a.get("ROOT_VALUE"))).secret.secretValue).toBe("fixture-suite-a")
    await a.admin("POST", "/reset")
    expect((await body(await a.get("ROOT_VALUE"))).secret.secretValue).toBe("fixture-root-value")
    const denied = await a.request("GET", "/api/v3/secrets/raw?workspaceId=missing&environment=dev")
    expect(denied.status).toBe(404)
    const invalid = await a.write("POST", "BAD", { secretValue: 12 })
    expect(invalid.status).toBe(422)
    expect((await body(invalid)).message).toBeArray()
  } finally {
    await server.close()
  }
})

test("persistent keys decrypt reopened state and reject tampering; renames preserve historical names and concurrent versions", async () => {
  const vaultKey = createVaultKey()
  const runtime = createRuntime({ vaultKey })
  const client = new InfisicalStore((r) => runtime.fetch(r))
  try {
    expect(
      (await client.write("POST", "ORIGINAL", { secretValue: "fixture-before-rename" })).status,
    ).toBe(200)
    expect(
      (
        await client.write("PATCH", "ORIGINAL", {
          newSecretName: "RENAMED",
          secretValue: "fixture-after-rename",
        })
      ).status,
    ).toBe(200)
    expect((await client.get("ORIGINAL")).status).toBe(404)
    expect((await body(await client.get("ORIGINAL", "/", 1))).secret.secretValue).toBe(
      "fixture-before-rename",
    )
    const results = await Promise.all([
      client.write("PATCH", "RENAMED", { secretValue: "fixture-concurrent-one" }),
      client.write("PATCH", "RENAMED", { secretValue: "fixture-concurrent-two" }),
    ])
    expect(results.map((r) => r.status)).toEqual([200, 200])
    expect((await body(await client.get("RENAMED"))).secret.version).toBe(4)
    const reopened = createRuntime({ sqlite: runtime.sqlite, vaultKey })
    const reopenedClient = new InfisicalStore((r) => reopened.fetch(r))
    expect((await body(await reopenedClient.get("RENAMED", "/", 2))).secret.secretValue).toBe(
      "fixture-after-rename",
    )
    const record = runtime.instance().state.find("fixture-project", "dev", "/", "RENAMED")
    expect(record).toBeDefined()
    if (!record) throw new Error("Missing test secret")
    const mutated = structuredClone(record)
    mutated.sealed.ciphertext[0] = (mutated.sealed.ciphertext[0] ?? 0) ^ 1
    runtime.instance().state.secrets.update(record.id, mutated)
    const rejected = await reopenedClient.get("RENAMED")
    expect(rejected.status).toBe(400)
    expect(await rejected.text()).not.toContain("fixture-concurrent")
    expect((await reopenedClient.admin("GET", "/secrets")).status).toBe(200)
  } finally {
    runtime.stop?.()
  }
})

test("Timeline branches decrypt inherited secrets and credentials while isolating later version updates", async () => {
  const { runtime, client } = setup()
  try {
    const checkpoint = await body(await client.admin("POST", "/checkpoints"))
    expect(
      (await client.admin("POST", "/branches/fixture-branch", { at: checkpoint.id })).status,
    ).toBe(201)
    const branchHeaders = { "x-emulates-branch": "fixture-branch" }
    const original = await client.request(
      "GET",
      "/api/v3/secrets/raw/ROOT_VALUE?workspaceId=fixture-project&environment=dev",
      undefined,
      branchHeaders,
    )
    expect(original.status).toBe(200)
    expect((await body(original)).secret.secretValue).toBe("fixture-root-value")
    const write = await client.request(
      "PATCH",
      "/api/v3/secrets/raw/ROOT_VALUE",
      { workspaceId: "fixture-project", environment: "dev", secretValue: "fixture-branch-value" },
      branchHeaders,
    )
    expect(write.status).toBe(200)
    expect((await body(await client.get("ROOT_VALUE"))).secret.secretValue).toBe(
      "fixture-root-value",
    )
    expect(
      (
        await body(
          await client.request(
            "GET",
            "/api/v3/secrets/raw/ROOT_VALUE?workspaceId=fixture-project&environment=dev",
            undefined,
            branchHeaders,
          ),
        )
      ).secret.secretValue,
    ).toBe("fixture-branch-value")
  } finally {
    runtime.stop?.()
  }
})
