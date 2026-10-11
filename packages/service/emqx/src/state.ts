import { Collection, IdSequence } from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"

/** A REST API key, sent as HTTP Basic: the key is the username, the secret the password. */
export type ApiKey = { key: string; secret: string }

/** A row of EMQX's built-in database authenticator (`user_id_type = username`). */
export type MqttUser = { username: string; password: string; superuser?: boolean }

/** EMQX's JWT authenticator with an HMAC secret (`algorithm = hmac-based`). */
export type JwtAuthenticator = {
  secret: string
  /** `secret_base64_encoded`. Default `false`. */
  secretBase64Encoded: boolean
  /** Which CONNECT field carries the token. EMQX's default is `password`. */
  from: "password" | "username"
  /** `acl_claim_name`. Default `acl`. */
  aclClaimName: string
  /** `verify_claims`: claim name to expected value; `${username}` and `${clientid}` expand. */
  verifyClaims: Record<string, string>
  /** `disconnect_after_expire`. Default `true` (EMQX 5.7 and later). */
  disconnectAfterExpire: boolean
}

/** Per-namespace broker configuration, set through `PUT /__admin/settings`; reseeded on reset. */
export type Settings = {
  /** Only these key/secret pairs may call the REST API; empty means any pair may. */
  apiKeys: ApiKey[]
  /** The built-in database, first in the authentication chain when it has rows. */
  users: MqttUser[]
  /** The JWT authenticator, after the built-in database; `null` leaves it out of the chain. */
  jwt: JwtAuthenticator | null
  authorization: {
    /** `authorization.no_match`: what applies when no ACL rule decides. EMQX 5 defaults to `allow`. */
    noMatch: "allow" | "deny"
    /** `authorization.deny_action`. Default `ignore`. */
    denyAction: "ignore" | "disconnect"
  }
}

export const DEFAULT_JWT_AUTHENTICATOR: Omit<JwtAuthenticator, "secret"> = {
  secretBase64Encoded: false,
  from: "password",
  aclClaimName: "acl",
  verifyClaims: {},
  disconnectAfterExpire: true,
}

/** An EMQX 5 broker as installed: no authenticator, so anyone connects, and `no_match = allow`. */
export const DEFAULT_SETTINGS: Settings = {
  apiKeys: [],
  users: [],
  jwt: null,
  authorization: { noMatch: "allow", denyAction: "ignore" },
}

/** What `settings` options and `PUT /__admin/settings` accept: every level may be partial. */
export type SettingsPatch = {
  apiKeys?: ApiKey[]
  users?: MqttUser[]
  jwt?: (Partial<JwtAuthenticator> & { secret: string }) | null
  authorization?: Partial<Settings["authorization"]>
}

export const mergeSettings = (base: Settings, patch: SettingsPatch): Settings => ({
  apiKeys: patch.apiKeys ?? base.apiKeys,
  users: patch.users ?? base.users,
  jwt:
    patch.jwt === undefined
      ? base.jwt
      : patch.jwt === null
        ? null
        : { ...DEFAULT_JWT_AUTHENTICATOR, ...patch.jwt },
  authorization: { ...base.authorization, ...patch.authorization },
})

export class EmqxState {
  readonly settings: Collection<Settings>
  readonly ids: IdSequence

  constructor(
    sqlite: SqliteClient,
    namespace: string,
    private readonly seed: SettingsPatch,
  ) {
    this.settings = new Collection(sqlite, namespace, "settings")
    this.ids = new IdSequence(sqlite, namespace, "emqx")
    this.ensureSeeded()
  }

  /** Re-apply the configured settings after a reset. */
  ensureSeeded(): void {
    if (!this.settings.has("settings")) {
      this.settings.insert("settings", mergeSettings(DEFAULT_SETTINGS, this.seed))
    }
  }

  current(): Settings {
    return this.settings.get("settings") ?? DEFAULT_SETTINGS
  }

  update(patch: SettingsPatch): Settings {
    const next = mergeSettings(this.current(), patch)
    this.settings.insert("settings", next)
    return next
  }

  /** A message id as EMQX prints one: a 16-byte GUID in uppercase hexadecimal. */
  nextMessageId(): string {
    const token = this.ids.next("", 32)
    let out = ""
    for (let index = 0; index < token.length; index++) {
      out += (token.charCodeAt(index) % 16).toString(16)
    }
    return out.toUpperCase()
  }
}
