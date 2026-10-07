import { expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { createClock } from "../packages/service/core/src/clock.ts"
import {
  ADMIN_KEY_HEADER,
  createControlPlane,
  NAMESPACE_HEADER,
} from "../packages/service/core/src/control.ts"
import { createFaultRegistry } from "../packages/service/core/src/faults.ts"
import { createJournal } from "../packages/service/core/src/journal.ts"
import { createMetrics } from "../packages/service/core/src/metrics.ts"
import { MOCKINGBIRD_HEADER } from "../packages/service/core/src/runtime.ts"
import { createRuntime } from "../packages/service/docker/src/index.ts"
import { createDefaultSqlite, migrateCore } from "../packages/sqlite/src/index.ts"

const root = join(import.meta.dir, "..")

type Manifest = {
  name?: string
  bin?: Record<string, string>
  private?: boolean
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  repository?: { url?: string }
  mockingbird?: { layer?: string }
}

const manifests = (): Array<{ path: string; manifest: Manifest }> => {
  const out: Array<{ path: string; manifest: Manifest }> = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules" || entry === "dist" || entry === ".git") continue
      const path = join(dir, entry)
      if (statSync(path).isDirectory()) {
        walk(path)
        continue
      }
      if (entry !== "package.json") continue
      out.push({ path, manifest: JSON.parse(readFileSync(path, "utf8")) as Manifest })
    }
  }
  walk(root)
  return out
}

test("workspace packages use Mockingbird names, bins, and repository URLs", () => {
  const packages = manifests()
  const rootManifest = packages.find((pkg) => pkg.path === join(root, "package.json"))
  expect(rootManifest?.manifest.name).toBe("mockingbird-monorepo")

  const names = packages.flatMap((pkg) => (pkg.manifest.name ? [pkg.manifest.name] : []))
  expect(names).toContain("@crvouga/mockingbird-docs")
  expect(names).toContain("@crvouga/mockingbird-sqlite")
  expect(names).toContain("@crvouga/mockingbird-service")
  expect(names).toContain("@crvouga/mockingbird-service-stripe")

  for (const { path, manifest } of packages) {
    if (path === join(root, "package.json")) continue
    expect(manifest.name ?? "").toMatch(/^@crvouga\/mockingbird(?:-[a-z0-9]+)*$/)
    const deps = {
      ...manifest.dependencies,
      ...manifest.devDependencies,
      ...manifest.peerDependencies,
    }
    const bannedScopes = ["emulates", "emulators"].map((scope) => `@${scope}/`)
    for (const dep of Object.keys(deps)) {
      for (const scope of bannedScopes) expect(dep.startsWith(scope)).toBe(false)
    }
    for (const bin of Object.keys(manifest.bin ?? {})) {
      expect(bin.startsWith("mockingbird-")).toBe(true)
    }
    const repo = manifest.repository?.url
    if (repo) expect(repo).toContain("github.com/crvouga/mockingbird")
  }

  for (const entry of readdirSync(join(root, "packages/service"))) {
    const manifestPath = join(root, "packages/service", entry, "package.json")
    try {
      if (!statSync(manifestPath).isFile()) continue
    } catch {
      continue
    }
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest
    const expected =
      entry === "core" ? "@crvouga/mockingbird-service" : `@crvouga/mockingbird-service-${entry}`
    expect(manifest.name).toBe(expected)
  }
})

test("shipped headers, admin errors, config, env, and docker names are Mockingbird", async () => {
  expect(NAMESPACE_HEADER).toBe("x-mockingbird-namespace")
  expect(ADMIN_KEY_HEADER).toBe("x-mockingbird-admin-key")
  expect(MOCKINGBIRD_HEADER).toBe("x-mockingbird")

  const plane = createControlPlane({
    name: "brand",
    startedAt: 0,
    wallNow: () => 0,
    clock: createClock(() => 0),
    faults: createFaultRegistry(),
    metrics: createMetrics(),
    journal: createJournal(),
    defaultNamespace: "default",
    namespaces: () => ["default"],
    reset: async () => {},
    timeTravel: {
      checkpoint: () => ({ id: "c", branch: "main", parent: null, at: 0 }),
      branch: () => ({ id: "c", branch: "main", parent: null, at: 0 }),
      checkout: () => {},
      retain: () => {},
      release: () => true,
      inspect: () => ({ branches: {}, checkpoints: [] }),
    },
    describe: () => ({}),
    routes: {},
    adminKey: undefined,
  })
  const response = await plane.handle(
    new Request("http://mock.local/__admin/clock", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "[]",
    }),
  )
  expect(response?.status).toBe(400)
  expect(await response?.json()).toEqual({
    error: { type: "mockingbird_admin", message: "expected a JSON object" },
  })

  const cli = readFileSync(join(root, "packages/adapters/node/src/cli.ts"), "utf8")
  expect(cli).toContain("mockingbird.json")
  expect(cli).toContain("MOCKINGBIRD_ADMIN_PREFIX")
  expect(cli).toContain("MOCKINGBIRD_ADMIN_KEY")
  const fleet = readFileSync(join(root, "packages/adapters/node/src/fleet.ts"), "utf8")
  expect(fleet).toContain("process.env.MOCKINGBIRD_ADMIN_KEY")
  expect(fleet).toContain("x-mockingbird-admin-key")
  const stateDir = readFileSync(join(root, "packages/service/github/oracle/run.mjs"), "utf8")
  expect(stateDir).toContain(".mockingbird/github-oracle")

  const runtime = createRuntime()
  const seeded = await runtime.fetch(
    new Request("http://docker.local/__admin/docker/seed", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        images: [
          {
            id: `sha256:${"a".repeat(64)}`,
            tags: ["synthetic:latest"],
            config: { Cmd: ["worker"] },
          },
        ],
      }),
    }),
  )
  expect(seeded.status).toBe(201)
  const created = await runtime.fetch(
    new Request("http://docker.local/containers/create", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ Image: "synthetic" }),
    }),
  )
  expect(created.status).toBe(201)
  const body = (await created.json()) as { Id: string }
  const inspect = await runtime.fetch(new Request(`http://docker.local/containers/${body.Id}/json`))
  const details = (await inspect.json()) as { Name: string }
  expect(details.Name.startsWith("/mockingbird_")).toBe(true)
})

test("core sqlite tables are mockingbird_* and legacy names migrate back", () => {
  const fresh = createDefaultSqlite()
  migrateCore(fresh)
  const tables = fresh
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all<{ name: string }>()
    .map((row) => row.name)
  expect(tables).toContain("mockingbird_records")
  expect(tables).toContain("mockingbird_sequences")

  for (const prefix of ["emulates", "emulators"] as const) {
    const sqlite = createDefaultSqlite()
    sqlite.exec(`
      CREATE TABLE schema_migrations (id TEXT PRIMARY KEY NOT NULL, applied_at INTEGER NOT NULL);
      INSERT INTO schema_migrations (id, applied_at) VALUES ('20260322_core_records_sequences', 1);
      CREATE TABLE ${prefix}_records (
        namespace TEXT NOT NULL, collection TEXT NOT NULL, id TEXT NOT NULL,
        seq INTEGER NOT NULL, value TEXT NOT NULL,
        PRIMARY KEY (namespace, collection, id)
      );
      CREATE TABLE ${prefix}_sequences (
        namespace TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL, value INTEGER NOT NULL,
        PRIMARY KEY (namespace, name, kind)
      );
      INSERT INTO ${prefix}_records (namespace, collection, id, seq, value)
        VALUES ('ns', 'customers', 'cus_1', 1, '{}');
    `)
    migrateCore(sqlite)
    const names = sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all<{ name: string }>()
      .map((row) => row.name)
    expect(names).toContain("mockingbird_records")
    expect(names).not.toContain(`${prefix}_records`)
    const row = sqlite
      .prepare("SELECT id FROM mockingbird_records WHERE namespace = ?")
      .get<{ id: string }>("ns")
    expect(row?.id).toBe("cus_1")
  }
})
