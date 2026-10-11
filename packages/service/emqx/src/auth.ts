/**
 * EMQX's JWT authenticator and the ACL a token carries.
 *
 * Follows EMQX 5.8 (`apps/emqx_auth_jwt/src/emqx_authn_jwt.erl`,
 * `apps/emqx_auth/src/emqx_authz/sources/emqx_authz_client_info.erl`,
 * `apps/emqx_auth/src/emqx_authz/emqx_authz_rule.erl` and `emqx_authz_rule_raw.erl`), and
 * https://docs.emqx.com/en/emqx/latest/access-control/authn/jwt.html.
 */
import { topicMatches } from "@crvouga/mockingbird-mqtt-broker"
import { fromBase64 } from "@crvouga/mockingbird-service"
import type { JwtAuthenticator } from "./state.js"

/** One rule of the list-form `acl` claim (EMQX 5.5 and later). */
export type AclRule = {
  permission: "allow" | "deny"
  action: "publish" | "subscribe" | "all"
  topics: string[]
  /** Only these QoS levels; absent means every level. */
  qos?: number[]
  /** Only publishes with this RETAIN flag; absent means either. */
  retain?: boolean
}

/**
 * The `acl` claim. The object form lists allowed topics and denies everything else; the list
 * form is checked rule by rule and falls through to `authorization.no_match` when none applies.
 */
export type Acl =
  | { form: "object"; publish: string[]; subscribe: string[]; all: string[] }
  | { form: "list"; rules: AclRule[] }

/** What an authenticator in EMQX's chain answers: `ignore` passes to the next one. */
export type JwtResult =
  | { result: "ignore" }
  | { result: "error" }
  | { result: "ok"; acl: Acl | null; expiresAt: number | null }

export type ClientIdentity = { clientId: string; username: string | undefined }

const HASHES: Record<string, string> = { HS256: "SHA-256", HS384: "SHA-384", HS512: "SHA-512" }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const base64Url = (value: string): Uint8Array | undefined => {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) return undefined
  try {
    return fromBase64(value.replace(/-/g, "+").replace(/_/g, "/"))
  } catch {
    return undefined
  }
}

const json = (bytes: Uint8Array | undefined): unknown => {
  if (!bytes) return undefined
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
  } catch {
    return undefined
  }
}

/** The placeholders EMQX expands in `verify_claims` values and ACL topics. */
export const PLACEHOLDER = {
  // biome-ignore lint/suspicious/noTemplateCurlyInString: EMQX's placeholder syntax
  clientId: "${clientid}",
  // biome-ignore lint/suspicious/noTemplateCurlyInString: EMQX's placeholder syntax
  username: "${username}",
} as const

const render = (template: string, identity: ClientIdentity): string =>
  template
    .replaceAll(PLACEHOLDER.clientId, identity.clientId)
    .replaceAll(PLACEHOLDER.username, identity.username ?? "")

/** EMQX converts a numeric string before comparing a time claim. */
const numeric = (value: unknown): number | undefined => {
  if (typeof value === "number") return value
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
    return Number(value)
  }
  return undefined
}

const topicList = (value: unknown): string[] | undefined =>
  Array.isArray(value) && value.every((each) => typeof each === "string")
    ? (value as string[])
    : undefined

const parseQos = (value: unknown): number[] | undefined => {
  const list =
    typeof value === "number"
      ? [value]
      : typeof value === "string"
        ? value.split(",").map((each) => Number(each.trim()))
        : Array.isArray(value)
          ? value.map(Number)
          : undefined
  return list?.every((each) => each === 0 || each === 1 || each === 2) ? list : undefined
}

const ACTIONS: Record<string, AclRule["action"]> = {
  pub: "publish",
  publish: "publish",
  sub: "subscribe",
  subscribe: "subscribe",
  all: "all",
}

const parseRule = (value: unknown): AclRule | undefined => {
  if (!isRecord(value)) return undefined
  const permission = value.permission
  const action = typeof value.action === "string" ? ACTIONS[value.action] : undefined
  const topics =
    typeof value.topic === "string" ? [value.topic] : topicList(value.topics ?? undefined)
  if ((permission !== "allow" && permission !== "deny") || !action || !topics) return undefined
  const rule: AclRule = { permission, action, topics }
  if (value.qos !== undefined) {
    const qos = parseQos(value.qos)
    if (!qos) return undefined
    rule.qos = qos
  }
  if (value.retain !== undefined && value.retain !== "all") {
    if (value.retain === true || value.retain === 1) rule.retain = true
    else if (value.retain === false || value.retain === 0) rule.retain = false
    else return undefined
  }
  return rule
}

/** Parse an `acl` claim. `undefined` is a claim EMQX refuses to authenticate with. */
export const parseAcl = (claim: unknown): Acl | undefined => {
  if (Array.isArray(claim)) {
    const rules = claim.map(parseRule)
    return rules.every((rule) => rule !== undefined)
      ? { form: "list", rules: rules as AclRule[] }
      : undefined
  }
  if (!isRecord(claim)) return undefined
  const lists = ["pub", "sub", "all"].map((key) =>
    claim[key] === undefined ? [] : topicList(claim[key]),
  )
  const [publish, subscribe, all] = lists
  return publish && subscribe && all ? { form: "object", publish, subscribe, all } : undefined
}

/** `eq <topic>` compares literally; anything else is an MQTT topic filter with placeholders. */
const ruleMatches = (pattern: string, topic: string, identity: ClientIdentity): boolean =>
  pattern.startsWith("eq ")
    ? pattern.slice(3) === topic
    : topicMatches(render(pattern, identity), topic)

export type AclRequest = ClientIdentity & {
  action: "publish" | "subscribe"
  /** The Topic Name, or for a subscribe the Topic Filter, compared as written. */
  topic: string
  qos: number
  retain: boolean
}

/** What the token's ACL says, or `nomatch` when it leaves the decision to the next source. */
export const checkAcl = (acl: Acl, request: AclRequest): "allow" | "deny" | "nomatch" => {
  if (acl.form === "object") {
    const allowed = [...(request.action === "publish" ? acl.publish : acl.subscribe), ...acl.all]
    return allowed.some((pattern) => ruleMatches(pattern, request.topic, request))
      ? "allow"
      : "deny"
  }
  for (const rule of acl.rules) {
    if (rule.action !== "all" && rule.action !== request.action) continue
    if (rule.qos && !rule.qos.includes(request.qos)) continue
    if (rule.retain !== undefined && request.action === "publish" && rule.retain !== request.retain)
      continue
    if (rule.topics.some((pattern) => ruleMatches(pattern, request.topic, request))) {
      return rule.permission
    }
  }
  return "nomatch"
}

/**
 * Verify a token the way the authenticator does. A token that is not a JWT, or whose signature
 * does not verify, is `ignore`: EMQX hands the CONNECT to the next authenticator. A verified
 * token with a failed `exp`, `nbf`, `verify_claims` or `acl` claim is `error`.
 */
export const verifyJwt = async (
  token: string | undefined,
  settings: JwtAuthenticator,
  nowSeconds: number,
  identity: ClientIdentity,
): Promise<JwtResult> => {
  if (token === undefined) return { result: "ignore" }
  const parts = token.split(".")
  if (parts.length !== 3) return { result: "ignore" }
  const [encodedHeader, encodedPayload, encodedSignature] = parts as [string, string, string]
  const header = json(base64Url(encodedHeader))
  const hash = isRecord(header) && typeof header.alg === "string" ? HASHES[header.alg] : undefined
  const signature = base64Url(encodedSignature)
  if (!hash || !signature) return { result: "ignore" }
  let secret: Uint8Array
  try {
    secret = settings.secretBase64Encoded
      ? fromBase64(settings.secret)
      : new TextEncoder().encode(settings.secret)
  } catch {
    return { result: "ignore" }
  }
  const key = await crypto.subtle.importKey(
    "raw",
    secret as BufferSource,
    { name: "HMAC", hash },
    false,
    ["verify"],
  )
  const verified = await crypto.subtle.verify(
    "HMAC",
    key,
    signature as BufferSource,
    new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`),
  )
  if (!verified) return { result: "ignore" }
  const claims = json(base64Url(encodedPayload))
  if (!isRecord(claims)) return { result: "error" }

  // `exp` and `nbf` are checked only when present (emqx_authn_jwt.erl, verify_claims/2).
  let expiresAt: number | null = null
  if (claims.exp !== undefined) {
    const exp = numeric(claims.exp)
    if (exp === undefined || !(nowSeconds < exp)) return { result: "error" }
    expiresAt = exp
  }
  if (claims.nbf !== undefined) {
    const nbf = numeric(claims.nbf)
    if (nbf === undefined || !(nbf <= nowSeconds)) return { result: "error" }
  }
  for (const [name, expected] of Object.entries(settings.verifyClaims)) {
    if (claims[name] !== render(expected, identity)) return { result: "error" }
  }
  const claim = claims[settings.aclClaimName]
  if (claim === undefined) return { result: "ok", acl: null, expiresAt }
  const acl = parseAcl(claim)
  return acl ? { result: "ok", acl, expiresAt } : { result: "error" }
}
