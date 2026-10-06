import type { FetchAPI } from "@emulators/core"
import {
  type APIOptions,
  annotateResponse,
  bearerToken,
  bodyIssues,
  bootSqlite,
  createService,
  defineOperations,
  faultEffect,
  type OperationContext,
  type Service,
} from "@emulators/service"
import type { SqliteClient } from "@emulators/sqlite-client"
import { document, type SupportedOperationId } from "./generated/openapi.js"
import {
  DEFAULT_TREE,
  folderKey,
  type Grant,
  InfisicalState,
  normalizePath,
  type ProjectTree,
  type SecretData,
  type SecretRecord,
  type Token,
} from "./state.js"
import { createVaultKey, Vault } from "./vault.js"

export { document, supportedOperationIds } from "./generated/openapi.js"
export type { Grant, ProjectTree, SecretFixture, SecretRecord, Token } from "./state.js"
export { DEFAULT_ADMIN_KEY, DEFAULT_TREE, normalizePath } from "./state.js"
export { createVaultKey } from "./vault.js"
export const INFISICAL_NAMESPACE = "infisical"
export type InfisicalAPIOptions = APIOptions & {
  trees?: readonly ProjectTree[]
  vaultKey?: Uint8Array
  /** Logical encryption domain; runtime supplies the public namespace for Timeline branches. */
  vaultNamespace?: string
}
export const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
const vendorError = (
  status: number,
  message: unknown,
  name?: string,
  headers?: HeadersInit,
): Response =>
  Response.json(
    {
      reqId: "fixture-request",
      statusCode: status,
      message,
      error:
        name ??
        {
          400: "BadRequestError",
          401: "UnauthorizedError",
          403: "PermissionDenied",
          404: "NotFoundError",
          422: "ValidationFailure",
          429: "RateLimitError",
          500: "InternalServerError",
        }[status] ??
        "Error",
    },
    { status, ...(headers ? { headers } : {}) },
  )
class Rejection extends Error {
  constructor(readonly response: Response) {
    super("Infisical request rejected")
  }
}
function reject(status: number, message: unknown, name?: string): never {
  throw new Rejection(vendorError(status, message, name))
}
const match = (grant: Grant, project: string, environment: string, path: string): boolean =>
  grant.projectId === project &&
  grant.environment === environment &&
  (grant.path === path ||
    (grant.recursive === true && (grant.path === "/" || path.startsWith(`${grant.path}/`))))
const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "")
const secretValue = (value: string): string =>
  value.endsWith("\n") ? `${value.trim()}\n` : value.trim()
export class InfisicalAPI implements FetchAPI {
  readonly sqlite: SqliteClient
  readonly state: InfisicalState
  readonly app: Service["app"]
  private readonly service: Service
  private readonly now: () => number
  private readonly trees: readonly ProjectTree[]
  constructor(options: InfisicalAPIOptions = {}) {
    this.sqlite = options.sqlite ?? bootSqlite()
    this.now = options.now ?? Date.now
    this.trees = structuredClone(options.trees ?? [DEFAULT_TREE])
    this.state = new InfisicalState(
      this.sqlite,
      options.namespace ?? INFISICAL_NAMESPACE,
      new Vault(options.vaultKey ?? createVaultKey()),
      options.vaultNamespace,
    )
    this.ensureSeeded()
    const wrap =
      (fn: (c: OperationContext) => Response) =>
      (c: OperationContext): Response => {
        try {
          return fn(c)
        } catch (error) {
          if (error instanceof Rejection) return error.response
          return vendorError(400, "Invalid request")
        }
      }
    this.service = createService({
      document,
      sqlite: this.sqlite,
      namespace: options.namespace ?? INFISICAL_NAMESPACE,
      now: this.now,
      handlers: defineOperations<SupportedOperationId>({
        UniversalAuthLogin: wrap((c) => this.login(c)),
        RenewAccessToken: wrap((c) => this.renew(c)),
        ListSecrets: wrap((c) => this.list(c)),
        GetSecret: wrap((c) => this.get(c)),
        CreateSecret: wrap((c) => this.write(c, false)),
        UpdateSecret: wrap((c) => this.write(c, true)),
      }),
      before: (c) => {
        if (
          c.operation.operationId === "UniversalAuthLogin" ||
          c.operation.operationId === "RenewAccessToken"
        )
          return undefined
        try {
          this.authenticate(c.request)
          return undefined
        } catch (error) {
          return error instanceof Rejection ? error.response : vendorError(400, "Invalid request")
        }
      },
      notFound: () => vendorError(404, "Route not found", "Not Found"),
      onError: () => vendorError(400, "Invalid request body", "BodyParserError"),
    })
    this.app = this.service.app
  }
  fetch(request: Request): Promise<Response> {
    return this.service.fetch(request)
  }
  async reset(): Promise<void> {
    await this.service.reset()
    this.ensureSeeded()
  }
  ensureSeeded(): void {
    if (this.state.settings.has("current")) return
    this.sqlite.transaction(() => {
      for (const tree of this.trees) this.seedTree(tree)
      this.state.settings.insert("current", { initialized: true })
    })
  }
  /** Explicit write control; returns metadata only. All fixture values are sealed before storage. */
  seedTree(tree: ProjectTree): { projectId: string; environments: number; secrets: number } {
    // Validate and normalize the entire tree before any database mutation.
    const prepared = structuredClone(tree)
    if (
      !prepared.organization?.id ||
      !prepared.project?.id ||
      !Array.isArray(prepared.environments)
    )
      throw new Error("Invalid project tree")
    for (const record of [prepared.organization, prepared.project])
      if (![record.id, record.slug, record.name].every((x) => typeof x === "string" && x.trim()))
        throw new Error("Invalid project metadata")
    const validateGrant = (g: Grant): void => {
      if (
        typeof g.projectId !== "string" ||
        !g.projectId ||
        typeof g.environment !== "string" ||
        !g.environment ||
        (g.recursive !== undefined && typeof g.recursive !== "boolean") ||
        (g.actions !== undefined &&
          (!Array.isArray(g.actions) ||
            g.actions.some((a) => !(["read", "create", "edit"] as string[]).includes(a))))
      )
        throw new Error("Invalid permission grant")
      g.path = normalizePath(g.path)
    }
    const seen = new Set<string>()
    for (const env of prepared.environments) {
      if (!env.slug || !Array.isArray(env.folders)) throw new Error("Invalid environment")
      if (!env.folders.some((f) => normalizePath(f.path) === "/"))
        env.folders.unshift({ path: "/" })
      for (const folder of env.folders) {
        folder.path = normalizePath(folder.path)
        const fk = folderKey(prepared.project.id, env.slug, folder.path)
        if (seen.has(fk)) throw new Error("Duplicate folder")
        seen.add(fk)
        const keys = new Set<string>()
        for (const secret of folder.secrets ?? []) {
          if (
            typeof secret.key !== "string" ||
            !secret.key.trim() ||
            typeof secret.value !== "string" ||
            keys.has(secret.key) ||
            (secret.version !== undefined &&
              (!Number.isSafeInteger(secret.version) || secret.version < 1))
          )
            throw new Error("Invalid secret fixture")
          if (
            (secret.comment !== undefined && typeof secret.comment !== "string") ||
            (secret.metadata !== undefined &&
              (typeof secret.metadata !== "object" ||
                secret.metadata === null ||
                Array.isArray(secret.metadata) ||
                Object.values(secret.metadata).some((v) => typeof v !== "string"))) ||
            (secret.tags !== undefined &&
              (!Array.isArray(secret.tags) ||
                secret.tags.some(
                  (t) =>
                    !t ||
                    ![t.id, t.slug, t.name].every((v) => typeof v === "string") ||
                    (t.color !== undefined && typeof t.color !== "string"),
                )))
          )
            throw new Error("Invalid secret metadata")
          keys.add(secret.key)
        }
        for (const imp of folder.imports ?? []) imp.path = normalizePath(imp.path)
      }
    }
    for (const machine of prepared.machines ?? []) {
      if (
        !machine.id ||
        typeof machine.clientSecret !== "string" ||
        !machine.clientSecret ||
        !Array.isArray(machine.grants) ||
        (machine.ttl !== undefined && (!Number.isSafeInteger(machine.ttl) || machine.ttl < 0)) ||
        (machine.maxTTL !== undefined &&
          (!Number.isSafeInteger(machine.maxTTL) || machine.maxTTL < 0))
      )
        throw new Error("Invalid machine fixture")
      for (const g of machine.grants) validateGrant(g)
    }
    for (const token of prepared.serviceTokens ?? []) {
      if (
        !token.id ||
        typeof token.token !== "string" ||
        !token.token ||
        !Array.isArray(token.grants)
      )
        throw new Error("Invalid service-token fixture")
      if (token.expiresAt !== undefined && !Number.isFinite(token.expiresAt))
        throw new Error("Invalid token expiry")
      for (const g of token.grants) validateGrant(g)
    }
    let count = 0
    this.sqlite.transaction(() => {
      const upsert = <T>(
        collection: {
          has(id: string): boolean
          update(id: string, value: T): unknown
          insert(id: string, value: T): unknown
        },
        id: string,
        value: T,
      ) => (collection.has(id) ? collection.update(id, value) : collection.insert(id, value))
      upsert(this.state.organizations, prepared.organization.id, prepared.organization)
      upsert(this.state.projects, prepared.project.id, {
        ...prepared.project,
        organizationId: prepared.organization.id,
      })
      for (const env of prepared.environments) {
        upsert(this.state.environments, folderKey(prepared.project.id, env.slug, "/"), {
          projectId: prepared.project.id,
          slug: env.slug,
          name: env.name ?? env.slug,
        })
        for (const folder of env.folders) {
          const id = folderKey(prepared.project.id, env.slug, folder.path)
          upsert(this.state.folders, id, {
            id,
            projectId: prepared.project.id,
            environment: env.slug,
            path: folder.path,
            imports: folder.imports ?? [],
          })
          for (const s of folder.secrets ?? []) {
            const existing = this.state.find(prepared.project.id, env.slug, folder.path, s.key)
            const time = new Date(this.now()).toISOString()
            this.state.save(
              {
                id: existing?.id ?? this.state.ids.next("secret_", 24),
                projectId: prepared.project.id,
                environment: env.slug,
                path: folder.path,
                key: s.key,
                version: existing ? existing.version + 1 : (s.version ?? 1),
                type: "shared",
                createdAt: existing?.createdAt ?? time,
                updatedAt: time,
              },
              {
                value: secretValue(s.value),
                comment: s.comment ?? "",
                tags: s.tags ?? [],
                metadata: s.metadata ?? {},
              },
            )
            count++
          }
        }
      }
      for (const m of prepared.machines ?? [])
        upsert(this.state.machines, m.id, {
          id: m.id,
          organizationId: prepared.organization.id,
          grants: m.grants,
          ttl: m.ttl ?? 60,
          maxTTL: m.maxTTL ?? 3600,
          secret: this.state.vault.seal(m.clientSecret, this.state.context("machine", m.id)),
        })
      for (const t of prepared.serviceTokens ?? [])
        upsert(this.state.tokens, t.id, {
          id: t.id,
          machineId: null,
          kind: "service",
          grants: t.grants,
          issuedAt: this.now(),
          expiresAt: t.expiresAt ?? null,
          maxExpiresAt: null,
          revoked: false,
          credential: this.state.vault.seal(t.token, this.state.context("token", t.id)),
        })
    })
    return {
      projectId: prepared.project.id,
      environments: prepared.environments.length,
      secrets: count,
    }
  }
  private validate(c: OperationContext): void {
    const issues = bodyIssues(c)
    if (issues.length)
      reject(
        422,
        issues.map((i) => ({
          code: "invalid_type",
          path: i.path.split(".").filter(Boolean),
          message: i.message,
        })),
        "ValidationFailure",
      )
  }
  private authenticate(request: Request, override?: string): Token {
    const credential = override ?? bearerToken(request)
    if (!credential) reject(401, "Token missing")
    const token = this.state.tokens
      .list()
      .find(
        ({ value: t }) =>
          this.state.vault.open<string>(t.credential, this.state.context("token", t.id)) ===
          credential,
      )?.value
    if (!token || token.revoked)
      reject(401, token?.kind === "service" ? "Invalid service token" : "Invalid access token")
    if (token.expiresAt !== null && this.now() >= token.expiresAt)
      reject(
        403,
        token.kind === "service"
          ? "Service token has expired"
          : "Your token has expired. Please re-authenticate.",
        token.kind === "service" ? "UnauthorizedError" : "TokenError",
      )
    return token
  }
  private issue(
    machineId: string,
    grants: Grant[],
    ttl: number,
    maxTTL: number,
    issuedAt = this.now(),
    maxExpiresAt: number | null = null,
  ): Response {
    const id = this.state.ids.next("token_", 24)
    const token = `fixture-machine-token.${[...crypto.getRandomValues(new Uint8Array(24))].map((b) => b.toString(16).padStart(2, "0")).join("")}`
    const maximum = maxExpiresAt ?? (maxTTL > 0 ? issuedAt + maxTTL * 1000 : null)
    const expiry =
      ttl > 0 ? Math.min(this.now() + ttl * 1000, maximum ?? Number.POSITIVE_INFINITY) : maximum
    const row: Token = {
      id,
      machineId,
      kind: "machine",
      grants: structuredClone(grants),
      issuedAt,
      expiresAt: expiry,
      maxExpiresAt: maximum,
      revoked: false,
      credential: this.state.vault.seal(token, this.state.context("token", id)),
    }
    this.state.tokens.insert(id, row)
    return annotateResponse(
      Response.json({
        accessToken: token,
        expiresIn: expiry === null ? 0 : Math.max(0, Math.floor((expiry - this.now()) / 1000)),
        accessTokenMaxTTL: maxTTL,
        tokenType: "Bearer",
      }),
      { ids: { token: id } },
    )
  }
  private login(c: OperationContext): Response {
    this.validate(c)
    const body = c.body.kind === "json" ? object(c.body.value) : {}
    const machine = this.state.machines.get(text(body.clientId))
    if (
      !machine ||
      this.state.vault.open<string>(machine.secret, this.state.context("machine", machine.id)) !==
        text(body.clientSecret)
    )
      reject(401, "Invalid credentials")
    if (
      body.organizationSlug !== undefined &&
      this.state.organizations.get(machine.organizationId)?.slug !== text(body.organizationSlug)
    )
      reject(401, "Invalid credentials")
    return this.issue(machine.id, machine.grants, machine.ttl, machine.maxTTL)
  }
  private renew(c: OperationContext): Response {
    this.validate(c)
    const token = this.authenticate(
      c.request,
      text((c.body.kind === "json" ? object(c.body.value) : {}).accessToken),
    )
    if (token.kind !== "machine" || !token.machineId)
      reject(401, "Cannot renew revoked or unknown access token")
    const machine = this.state.machines.get(token.machineId)
    if (!machine) reject(401, "Invalid access token")
    if (token.maxExpiresAt !== null && this.now() >= token.maxExpiresAt)
      reject(401, "Cannot renew: identity access token has reached its max TTL")
    return this.issue(
      machine.id,
      token.grants,
      machine.ttl,
      machine.maxTTL,
      token.issuedAt,
      token.maxExpiresAt,
    )
  }
  private scope(
    c: OperationContext,
    action: "read" | "create" | "edit",
  ): { project: string; environment: string; path: string; token: Token } {
    const token = this.authenticate(c.request)
    const data =
      c.request.method === "GET"
        ? Object.fromEntries(c.url.searchParams)
        : c.body.kind === "json"
          ? object(c.body.value)
          : {}
    let project =
      text(data.workspaceId) ||
      this.state.projects
        .list()
        .find(({ value: p }) => p.slug === text(data.workspaceSlug ?? data.projectSlug))?.id ||
      ""
    let environment = text(data.environment)
    let path: string
    try {
      path = normalizePath(typeof data.secretPath === "string" ? data.secretPath : "/")
    } catch {
      reject(400, "Invalid secret path")
    }
    // The actual v3 router overrides these fields for a single exact legacy service-token scope.
    if (
      token.kind === "service" &&
      token.grants.length === 1 &&
      token.grants[0]?.recursive !== true
    ) {
      const g = token.grants[0] as Grant
      project = g.projectId
      environment = g.environment
      path = g.path
    }
    if (!environment) reject(400, "Missing environment")
    if (!project) reject(400, "Must provide either project slug or projectId")
    if (!this.state.projects.has(project)) reject(404, "Project not found")
    if (!this.state.environments.has(folderKey(project, environment, "/")))
      reject(404, "Environment not found")
    if (
      !token.grants.some(
        (g) => match(g, project, environment, path) && (!g.actions || g.actions.includes(action)),
      ) ||
      this.state.denials.list().some(({ value: g }) => match(g, project, environment, path))
    )
      reject(403, `You are not allowed to ${action} on Secrets`, "PermissionDenied")
    if (!this.state.folders.has(folderKey(project, environment, path)))
      reject(404, "Folder not found")
    return { project, environment, path, token }
  }
  private allowed(token: Token, s: SecretRecord): boolean {
    return (
      token.grants.some(
        (g) =>
          match(g, s.projectId, s.environment, s.path) &&
          (!g.actions || g.actions.includes("read")),
      ) &&
      !this.state.denials
        .list()
        .some(({ value: g }) => match(g, s.projectId, s.environment, s.path))
    )
  }
  wire(
    secret: SecretRecord,
    values = true,
    expand = false,
    token?: Token,
    seen = new Set<string>(),
  ): Record<string, unknown> {
    const data = this.state.data(secret)
    let value = values ? data.value : ""
    if (values && expand && token && !seen.has(secret.id)) {
      seen.add(secret.id)
      value = value.replace(/\$\{([^{}]+)\}/g, (original, reference: string) => {
        const parts = reference.split(".")
        const key = parts.pop() ?? ""
        let environment = secret.environment
        let path = secret.path
        if (parts.length) {
          environment = parts.shift() ?? environment
          path = `/${parts.join("/")}`
        }
        const target = this.state.find(secret.projectId, environment, path, key)
        if (target && !this.allowed(token, target))
          reject(403, "Failed to expand one or more secret references", "ForbiddenRequestError")
        return target && this.allowed(token, target) && !seen.has(target.id)
          ? String(this.wire(target, true, true, token, new Set(seen)).secretValue)
          : original
      })
    }
    return {
      id: secret.id,
      _id: secret.id,
      workspace: secret.projectId,
      environment: secret.environment,
      secretPath: secret.path,
      version: secret.version,
      type: secret.type,
      secretKey: secret.key,
      secretValue: value,
      secretComment: data.comment,
      tags: data.tags,
      metadata: data.metadata,
      createdAt: secret.createdAt,
      updatedAt: secret.updatedAt,
      secretValueHidden: !values,
    }
  }
  metadata(secret: SecretRecord): Record<string, unknown> {
    return {
      id: secret.id,
      _id: secret.id,
      workspace: secret.projectId,
      environment: secret.environment,
      secretPath: secret.path,
      version: secret.version,
      type: secret.type,
      secretKey: secret.key,
      createdAt: secret.createdAt,
      updatedAt: secret.updatedAt,
      secretValueHidden: true,
    }
  }
  private boolean(c: OperationContext, name: string, def = false): boolean {
    const value = c.url.searchParams.get(name)
    if (value !== null && value !== "true" && value !== "false")
      reject(
        422,
        [{ code: "invalid_enum_value", path: [name], message: "Expected true or false" }],
        "ValidationFailure",
      )
    return value === null ? def : value === "true"
  }
  private selected(c: OperationContext): {
    rows: SecretRecord[]
    imports: {
      secretPath: string
      environment: string
      folderId: string
      secrets: Record<string, unknown>[]
    }[]
    token: Token
    values: boolean
    expand: boolean
  } {
    const { project, environment, path, token } = this.scope(c, "read")
    const recursive = this.boolean(c, "recursive")
    const values = this.boolean(c, "viewSecretValue", true)
    const expand = this.boolean(c, "expandSecretReferences")
    const withImports = this.boolean(c, "include_imports")
    const tags = c.url.searchParams.get("tagSlugs")?.split(",").filter(Boolean) ?? []
    const inPath = (p: string) =>
      p === path || (recursive && (path === "/" || p.startsWith(`${path}/`)))
    const rows = this.state.secrets
      .list()
      .map((r) => r.value)
      .filter(
        (s) =>
          s.projectId === project &&
          s.environment === environment &&
          inPath(s.path) &&
          this.allowed(token, s) &&
          (!tags.length || this.state.data(s).tags.some((t) => tags.includes(t.slug))),
      )
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    const imports: {
      secretPath: string
      environment: string
      folderId: string
      secrets: Record<string, unknown>[]
    }[] = []
    if (withImports)
      for (const { value: f } of this.state.folders
        .list()
        .filter(
          ({ value: f }) =>
            f.projectId === project && f.environment === environment && inPath(f.path),
        )) {
        for (const imp of f.imports) {
          const source = this.state.folders.get(folderKey(project, imp.environment, imp.path))
          if (!source) continue
          const imported = this.state.secrets
            .list()
            .map((r) => r.value)
            .filter(
              (s) =>
                s.projectId === project &&
                s.environment === imp.environment &&
                s.path === imp.path &&
                this.allowed(token, s),
            )
          imports.push({
            secretPath: imp.path,
            environment: imp.environment,
            folderId: source.id,
            secrets: imported.map((s) => this.wire(s, values, expand, token)),
          })
        }
      }
    return { rows, imports, token, values, expand }
  }
  private list(c: OperationContext): Response {
    const selected = this.selected(c)
    return Response.json({
      secrets: selected.rows.map((s) =>
        this.wire(s, selected.values, selected.expand, selected.token),
      ),
      imports: selected.imports,
    })
  }
  private get(c: OperationContext): Response {
    const scope = this.scope(c, "read")
    const version = c.url.searchParams.get("version")
    if (version !== null && !Number.isFinite(Number(version)))
      reject(
        422,
        [{ code: "invalid_type", path: ["version"], message: "Expected number" }],
        "ValidationFailure",
      )
    const type = c.url.searchParams.get("type")
    if (type !== null && type !== "shared" && type !== "personal")
      reject(
        422,
        [{ code: "invalid_enum_value", path: ["type"], message: "Invalid secret type" }],
        "ValidationFailure",
      )
    if (type === "personal" && scope.token.kind === "machine")
      reject(404, `Secret with name '${text(c.params.secretName)}' not found`)
    const secret =
      version === null
        ? this.state.find(scope.project, scope.environment, scope.path, text(c.params.secretName))
        : this.state.versions
            .list()
            .find(
              ({ value: s }) =>
                s.projectId === scope.project &&
                s.environment === scope.environment &&
                s.path === scope.path &&
                s.key === text(c.params.secretName) &&
                s.version === Number(version),
            )?.value
    if (!secret && version === null && this.boolean(c, "include_imports")) {
      const imported = this.selected(c)
        .imports.flatMap((i) => i.secrets)
        .find((s) => s.secretKey === text(c.params.secretName))
      if (imported) return Response.json({ secret: imported })
    }
    if (!secret || faultEffect(c.request, "missing_version"))
      reject(404, `Secret with name '${text(c.params.secretName)}' not found`)
    return annotateResponse(
      Response.json({
        secret: this.wire(
          secret,
          this.boolean(c, "viewSecretValue", true),
          this.boolean(c, "expandSecretReferences"),
          scope.token,
        ),
      }),
      { ids: { secret: secret.id } },
    )
  }
  private write(c: OperationContext, update: boolean): Response {
    this.validate(c)
    const { project, environment, path } = this.scope(c, update ? "edit" : "create")
    const body = c.body.kind === "json" ? object(c.body.value) : {}
    const key = text(c.params.secretName)
    if (!key || key.includes("/"))
      reject(
        422,
        [{ code: "custom", path: ["secretName"], message: "Invalid secret name" }],
        "ValidationFailure",
      )
    if (body.type !== undefined && body.type !== "shared")
      reject(400, "Must be user to create personal secret")
    const existing = this.state.find(project, environment, path, key)
    if (update && !existing) reject(404, `Secret with name ${key} not found`)
    if (!update && existing)
      reject(
        400,
        `Secret '${key}' already exists in path '${path}' of environment '${environment}'`,
      )
    const newKey = body.newSecretName === undefined ? key : text(body.newSecretName)
    if (!newKey || newKey.includes("/")) reject(400, "New secret name cannot be empty")
    if (newKey !== key && this.state.find(project, environment, path, newKey))
      reject(400, "Secret with the new name already exists")
    const data: SecretData = existing
      ? this.state.data(existing)
      : { value: "", comment: "", tags: [], metadata: {} }
    if (body.secretValue !== undefined) data.value = secretValue(body.secretValue as string)
    if (body.secretComment !== undefined)
      data.comment = update ? String(body.secretComment) : text(body.secretComment)
    if (body.metadata !== undefined) data.metadata = body.metadata as Record<string, string>
    if (body.tagIds !== undefined) {
      const known = new Map(
        this.state.secrets
          .list()
          .flatMap((r) => this.state.data(r.value).tags)
          .map((t) => [t.id, t]),
      )
      const tags = (body.tagIds as string[]).map((id) => known.get(id))
      if (tags.some((t) => !t)) reject(404, "One or more tags not found")
      data.tags = tags as SecretData["tags"]
    }
    const time = new Date(this.now()).toISOString()
    const record = this.state.save(
      {
        id: existing?.id ?? this.state.ids.next("secret_", 24),
        projectId: project,
        environment,
        path,
        key: newKey,
        type: "shared",
        version: (existing?.version ?? 0) + 1,
        createdAt: existing?.createdAt ?? time,
        updatedAt: time,
      },
      data,
    )
    return annotateResponse(Response.json({ secret: this.wire(record) }), {
      ids: { secret: record.id },
    })
  }
}
export type { InfisicalRuntime, InfisicalRuntimeOptions } from "./runtime.js"
export { createRuntime, INFISICAL_PRESETS } from "./runtime.js"
