import { Collection, IdSequence } from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"
import { type PolicyDocument, PolicyError, parsePolicyDocument } from "./policy.js"

/** An IAM identity that signs HTTP requests with Signature Version 4. */
export type IamCredential = {
  accessKeyId: string
  secretAccessKey: string
  /** Temporary credentials: the request must carry it in `x-amz-security-token`. */
  sessionToken?: string
  /** What the identity may publish. Absent: everything. */
  policyDocuments?: PolicyDocument[]
}

/**
 * One outcome of a custom authorizer: the CONNECT credentials it recognises and what its Lambda
 * function would answer for them.
 * https://docs.aws.amazon.com/iot/latest/developerguide/custom-auth-lambda.html
 */
export type AuthorizerEntry = {
  /** The authorizer a client must name (`x-amz-customauthorizer-name`); absent: any or none. */
  name?: string
  /** The MQTT username, without its `?…` query string. */
  username: string
  /** The MQTT password; absent: any. */
  password?: string
  /** Default `true`. */
  isAuthenticated?: boolean
  /** 1 to 128 letters and digits. */
  principalId?: string
  /** At most 10. */
  policyDocuments: PolicyDocument[]
}

/** Per-namespace configuration, set through `PUT /__admin/settings`; reseeded on reset. */
export type Settings = {
  region: string
  accountId: string
  /** Empty: any SigV4-signed HTTP request is accepted without checking its signature. */
  credentials: IamCredential[]
  /** Empty (and no `authorizer` function): any MQTT client connects, allowed everything. */
  authorizers: AuthorizerEntry[]
  /**
   * The account's "Persistent session expiry period" quota, in seconds: the longest Session
   * Expiry Interval granted. AWS defaults to one hour and allows up to seven days.
   */
  persistentSessionExpirySeconds: number
}

export type SettingsPatch = Partial<Settings>

/** AWS IoT Core's longest persistent session: seven days. */
export const MAX_PERSISTENT_SESSION_EXPIRY_SECONDS = 604_800

export const DEFAULT_SETTINGS: Settings = {
  region: "us-east-1",
  accountId: "123456789012",
  credentials: [],
  authorizers: [],
  persistentSessionExpirySeconds: 3600,
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const policies = (value: unknown, where: string): PolicyDocument[] => {
  if (!Array.isArray(value)) throw new PolicyError(`${where}: policyDocuments must be a list`)
  // custom-auth-lambda: "The maximum number of policy documents is 10 policy documents."
  if (value.length > 10) throw new PolicyError(`${where}: at most 10 policy documents`)
  return value.map(parsePolicyDocument)
}

/**
 * Check a settings patch from an untyped source (the admin route, CLI flags). Throws
 * `PolicyError` or `TypeError` naming the field that is wrong.
 */
export const parseSettings = (body: unknown): SettingsPatch => {
  if (!isRecord(body)) throw new TypeError("expected a JSON object")
  const patch: SettingsPatch = {}
  for (const field of ["region", "accountId"] as const) {
    if (body[field] === undefined) continue
    if (typeof body[field] !== "string" || body[field] === "") {
      throw new TypeError(`${field}: a non-empty string`)
    }
    patch[field] = body[field] as string
  }
  if (body.persistentSessionExpirySeconds !== undefined) {
    const seconds = body.persistentSessionExpirySeconds
    const valid =
      typeof seconds === "number" &&
      Number.isInteger(seconds) &&
      seconds >= 1 &&
      seconds <= MAX_PERSISTENT_SESSION_EXPIRY_SECONDS
    if (!valid) {
      throw new TypeError(
        `persistentSessionExpirySeconds: 1 to ${MAX_PERSISTENT_SESSION_EXPIRY_SECONDS}`,
      )
    }
    patch.persistentSessionExpirySeconds = seconds as number
  }
  if (body.credentials !== undefined) {
    if (!Array.isArray(body.credentials)) throw new TypeError("credentials: a list")
    patch.credentials = body.credentials.map((each, index) => {
      const where = `credentials[${index}]`
      if (
        !isRecord(each) ||
        typeof each.accessKeyId !== "string" ||
        typeof each.secretAccessKey !== "string" ||
        each.accessKeyId === ""
      ) {
        throw new TypeError(
          `${where}: {accessKeyId, secretAccessKey, sessionToken?, policyDocuments?}`,
        )
      }
      return {
        accessKeyId: each.accessKeyId,
        secretAccessKey: each.secretAccessKey,
        ...(typeof each.sessionToken === "string" ? { sessionToken: each.sessionToken } : {}),
        ...(each.policyDocuments !== undefined
          ? { policyDocuments: policies(each.policyDocuments, where) }
          : {}),
      }
    })
  }
  if (body.authorizers !== undefined) {
    if (!Array.isArray(body.authorizers)) throw new TypeError("authorizers: a list")
    patch.authorizers = body.authorizers.map((each, index) => {
      const where = `authorizers[${index}]`
      if (!isRecord(each) || typeof each.username !== "string") {
        throw new TypeError(`${where}: {username, password?, name?, principalId?, policyDocuments}`)
      }
      // custom-auth-lambda: principalId must match ([a-zA-Z0-9]){1,128}.
      if (
        each.principalId !== undefined &&
        !/^[a-zA-Z0-9]{1,128}$/.test(String(each.principalId))
      ) {
        throw new TypeError(`${where}.principalId: 1 to 128 letters and digits`)
      }
      return {
        username: each.username,
        ...(typeof each.name === "string" ? { name: each.name } : {}),
        ...(typeof each.password === "string" ? { password: each.password } : {}),
        ...(typeof each.isAuthenticated === "boolean"
          ? { isAuthenticated: each.isAuthenticated }
          : {}),
        ...(each.principalId !== undefined ? { principalId: String(each.principalId) } : {}),
        policyDocuments: policies(each.policyDocuments ?? [], where),
      }
    })
  }
  return patch
}

export class AwsIotState {
  readonly settings: Collection<Settings>
  readonly ids: IdSequence

  constructor(
    sqlite: SqliteClient,
    namespace: string,
    private readonly seed: SettingsPatch,
  ) {
    this.settings = new Collection(sqlite, namespace, "settings")
    this.ids = new IdSequence(sqlite, namespace, "aws-iot")
    this.ensureSeeded()
  }

  /** Re-apply the configured settings after a reset. */
  ensureSeeded(): void {
    if (!this.settings.has("settings")) {
      this.settings.insert("settings", { ...DEFAULT_SETTINGS, ...parseSettings(this.seed) })
    }
  }

  current(): Settings {
    return this.settings.get("settings") ?? DEFAULT_SETTINGS
  }

  update(patch: SettingsPatch): Settings {
    const next = { ...this.current(), ...patch }
    this.settings.insert("settings", next)
    return next
  }

  /** A trace id in the UUID shape AWS IoT prints. */
  nextTraceId(): string {
    const token = this.ids.next("", 32)
    let hex = ""
    for (let index = 0; index < token.length; index++) {
      hex += (token.charCodeAt(index) % 16).toString(16)
    }
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
  }
}
