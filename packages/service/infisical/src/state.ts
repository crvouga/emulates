import { Collection, IdSequence } from "@emulates/service"
import type { SqliteClient } from "@emulates/sqlite-client"
import type { Sealed, Vault } from "./vault.js"
export type Grant = {
  projectId: string
  environment: string
  path: string
  recursive?: boolean
  actions?: ("read" | "create" | "edit")[]
}
export type SecretFixture = {
  key: string
  value: string
  comment?: string
  tags?: { id: string; slug: string; name: string; color?: string }[]
  metadata?: Record<string, string>
  version?: number
}
export type ProjectTree = {
  organization: { id: string; slug: string; name: string }
  project: { id: string; slug: string; name: string }
  environments: {
    slug: string
    name?: string
    folders: {
      path: string
      secrets?: SecretFixture[]
      imports?: { environment: string; path: string }[]
    }[]
  }[]
  machines?: { id: string; clientSecret: string; grants: Grant[]; ttl?: number; maxTTL?: number }[]
  serviceTokens?: { id: string; token: string; grants: Grant[]; expiresAt?: number }[]
}
export const DEFAULT_ADMIN_KEY = "fixture-infisical-admin"
export const DEFAULT_TREE: ProjectTree = {
  organization: { id: "fixture-org", slug: "fixture-org", name: "Fixture organization" },
  project: { id: "fixture-project", slug: "fixture-project", name: "Fixture project" },
  environments: [
    {
      slug: "dev",
      folders: [
        { path: "/", secrets: [{ key: "ROOT_VALUE", value: "fixture-root-value" }] },
        {
          path: "/app",
          secrets: [{ key: "APP_VALUE", value: "fixture-app-value", comment: "Synthetic fixture" }],
        },
        { path: "/sibling", secrets: [{ key: "SIBLING_VALUE", value: "fixture-sibling-value" }] },
      ],
    },
  ],
  machines: [
    {
      id: "fixture-machine",
      clientSecret: "fixture-client-secret",
      ttl: 60,
      maxTTL: 3600,
      grants: [{ projectId: "fixture-project", environment: "dev", path: "/app", recursive: true }],
    },
  ],
  serviceTokens: [
    {
      id: "fixture-service",
      token: "fixture-service-token",
      grants: [{ projectId: "fixture-project", environment: "dev", path: "/", recursive: true }],
    },
  ],
}
export type SecretRecord = {
  id: string
  projectId: string
  environment: string
  path: string
  key: string
  version: number
  type: "shared"
  createdAt: string
  updatedAt: string
  sealed: Sealed
}
export type SecretData = {
  value: string
  comment: string
  tags: NonNullable<SecretFixture["tags"]>
  metadata: Record<string, string>
}
export type Machine = {
  id: string
  organizationId: string
  grants: Grant[]
  ttl: number
  maxTTL: number
  secret: Sealed
}
export type Token = {
  id: string
  machineId: string | null
  kind: "machine" | "service"
  grants: Grant[]
  issuedAt: number
  expiresAt: number | null
  maxExpiresAt: number | null
  revoked: boolean
  credential: Sealed
}
export type Folder = {
  id: string
  projectId: string
  environment: string
  path: string
  imports: { environment: string; path: string }[]
}
export const normalizePath = (input: string): string => {
  const path = input.trim()
  if (
    !path.startsWith("/") ||
    path.includes("\\") ||
    path.includes("\0") ||
    path.split("/").some((s) => s === "." || s === "..")
  )
    throw new Error("Invalid secret path")
  return path.replace(/\/+$/, "") || "/"
}
export const folderKey = (project: string, environment: string, path: string): string =>
  JSON.stringify([project, environment, path])
export class InfisicalState {
  readonly organizations: Collection<ProjectTree["organization"]>
  readonly projects: Collection<ProjectTree["project"] & { organizationId: string }>
  readonly environments: Collection<{ projectId: string; slug: string; name: string }>
  readonly folders: Collection<Folder>
  readonly machines: Collection<Machine>
  readonly tokens: Collection<Token>
  readonly secrets: Collection<SecretRecord>
  readonly versions: Collection<SecretRecord>
  readonly denials: Collection<Grant>
  readonly settings: Collection<{ initialized: boolean }>
  readonly ids: IdSequence
  constructor(
    readonly sqlite: SqliteClient,
    readonly namespace: string,
    readonly vault: Vault,
    private readonly vaultNamespace = namespace,
  ) {
    this.organizations = new Collection(sqlite, namespace, "organizations")
    this.projects = new Collection(sqlite, namespace, "projects")
    this.environments = new Collection(sqlite, namespace, "environments")
    this.folders = new Collection(sqlite, namespace, "folders")
    this.machines = new Collection(sqlite, namespace, "machines")
    this.tokens = new Collection(sqlite, namespace, "tokens")
    this.secrets = new Collection(sqlite, namespace, "secrets")
    this.versions = new Collection(sqlite, namespace, "secret_versions")
    this.denials = new Collection(sqlite, namespace, "denials")
    this.settings = new Collection(sqlite, namespace, "settings")
    this.ids = new IdSequence(sqlite, namespace, "infisical")
  }
  context(kind: string, id: string): string {
    return JSON.stringify([this.vaultNamespace, kind, id])
  }
  find(project: string, environment: string, path: string, name: string): SecretRecord | undefined {
    return this.secrets
      .list()
      .find(
        ({ value: s }) =>
          s.projectId === project &&
          s.environment === environment &&
          s.path === path &&
          s.key === name,
      )?.value
  }
  data(secret: SecretRecord): SecretData {
    return this.vault.open(secret.sealed, this.context("secret", `${secret.id}:${secret.version}`))
  }
  save(secret: Omit<SecretRecord, "sealed">, data: SecretData): SecretRecord {
    const row = {
      ...secret,
      sealed: this.vault.seal(data, this.context("secret", `${secret.id}:${secret.version}`)),
    }
    this.sqlite.transaction(() => {
      if (this.secrets.has(row.id)) this.secrets.update(row.id, row)
      else this.secrets.insert(row.id, row)
      const versionId = `${row.id}:${row.version}`
      if (this.versions.has(versionId)) this.versions.update(versionId, row)
      else this.versions.insert(versionId, row)
    })
    return row
  }
}
