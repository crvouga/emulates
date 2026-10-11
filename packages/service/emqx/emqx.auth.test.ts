/**
 * EMQX's JWT authenticator and JWT ACL, checked against tokens signed by `jose` (an independent
 * implementation), following apps/emqx_auth_jwt/src/emqx_authn_jwt.erl and
 * apps/emqx_auth/src/emqx_authz/sources/emqx_authz_client_info.erl at v5.8.6.
 */
import { describe, expect, test } from "bun:test"
import { SignJWT } from "jose"
import { type AclRequest, PLACEHOLDER, verifyJwt } from "./src/auth.js"
import {
  checkAcl,
  DEFAULT_JWT_AUTHENTICATOR,
  type JwtAuthenticator,
  parseAcl,
} from "./src/index.js"

const SECRET = "fixture-jwt-signing-secret"
const NOW = 1_767_225_600
const settings: JwtAuthenticator = { ...DEFAULT_JWT_AUTHENTICATOR, secret: SECRET }
const identity = { clientId: "device-1", username: "alice" }

const sign = (
  claims: Record<string, unknown>,
  options: { alg?: string; secret?: Uint8Array } = {},
): Promise<string> =>
  new SignJWT(claims)
    .setProtectedHeader({ alg: options.alg ?? "HS256" })
    .sign(options.secret ?? new TextEncoder().encode(SECRET))

const request = (fields: Partial<AclRequest>): AclRequest => ({
  action: "subscribe",
  topic: "t",
  qos: 1,
  retain: false,
  ...identity,
  ...fields,
})

describe("JWT authenticator", () => {
  test("a verified token is accepted with its expiry; one without exp never expires", async () => {
    expect(await verifyJwt(await sign({ exp: NOW + 60 }), settings, NOW, identity)).toEqual({
      result: "ok",
      acl: null,
      expiresAt: NOW + 60,
    })
    expect(await verifyJwt(await sign({}), settings, NOW, identity)).toEqual({
      result: "ok",
      acl: null,
      expiresAt: null,
    })
  })

  test("HS384, HS512 and a base64-encoded secret verify", async () => {
    for (const alg of ["HS384", "HS512"]) {
      const result = await verifyJwt(await sign({}, { alg }), settings, NOW, identity)
      expect(result.result).toBe("ok")
    }
    const raw = Uint8Array.from({ length: 32 }, (_, index) => index * 7)
    const encoded = btoa(String.fromCharCode(...raw))
    const result = await verifyJwt(
      await sign({}, { secret: raw }),
      { ...settings, secret: encoded, secretBase64Encoded: true },
      NOW,
      identity,
    )
    expect(result.result).toBe("ok")
  })

  test("no token, a non-token and a bad signature are ignored, for the next authenticator", async () => {
    const other = await sign({}, { secret: new TextEncoder().encode("another-secret") })
    for (const token of [undefined, "", "plain-password", "a.b.c", other]) {
      expect(await verifyJwt(token, settings, NOW, identity)).toEqual({ result: "ignore" })
    }
    // An unsigned token names no HMAC algorithm.
    const unsigned = `${btoa('{"alg":"none"}').replace(/=+$/, "")}.${btoa("{}").replace(/=+$/, "")}.`
    expect(await verifyJwt(unsigned, settings, NOW, identity)).toEqual({ result: "ignore" })
  })

  test("exp must be in the future and nbf must not be", async () => {
    const verdict = async (claims: Record<string, unknown>) =>
      (await verifyJwt(await sign(claims), settings, NOW, identity)).result
    // `Now < ExpireTime`: a token expiring this very second is already expired.
    expect(await verdict({ exp: NOW })).toBe("error")
    expect(await verdict({ exp: NOW - 1 })).toBe("error")
    expect(await verdict({ exp: NOW + 1 })).toBe("ok")
    expect(await verdict({ exp: String(NOW + 1) })).toBe("ok")
    expect(await verdict({ exp: "soon" })).toBe("error")
    expect(await verdict({ nbf: NOW })).toBe("ok")
    expect(await verdict({ nbf: NOW + 1 })).toBe("error")
  })

  test("verify_claims compares claims, expanding the clientid and username placeholders", async () => {
    const checked = {
      ...settings,
      verifyClaims: { sub: PLACEHOLDER.clientId, name: PLACEHOLDER.username },
    }
    const verdict = async (claims: Record<string, unknown>) =>
      (await verifyJwt(await sign(claims), checked, NOW, identity)).result
    expect(await verdict({ sub: "device-1", name: "alice" })).toBe("ok")
    expect(await verdict({ sub: "device-2", name: "alice" })).toBe("error")
    expect(await verdict({ sub: "device-1" })).toBe("error")
  })

  test("the token may travel in the username, and the acl claim may be renamed", async () => {
    const token = await sign({ permissions: { sub: ["t"] } })
    const result = await verifyJwt(
      token,
      { ...settings, from: "username", aclClaimName: "permissions" },
      NOW,
      { clientId: "c", username: token },
    )
    expect(result).toMatchObject({ result: "ok", acl: { form: "object", subscribe: ["t"] } })
  })

  test("a malformed acl claim fails authentication", async () => {
    for (const acl of [
      "all",
      7,
      { sub: "t" },
      [{ permission: "maybe", action: "sub", topic: "t" }],
    ]) {
      expect((await verifyJwt(await sign({ acl }), settings, NOW, identity)).result).toBe("error")
    }
  })
})

describe("JWT ACL", () => {
  test("the object form allows what it lists and denies everything else", () => {
    const acl = parseAcl({
      pub: [`out/${PLACEHOLDER.clientId}`],
      sub: ["in/+", "eq exact/#"],
      all: ["both"],
    })
    if (!acl) throw new Error("acl did not parse")
    expect(checkAcl(acl, request({ topic: "in/a" }))).toBe("allow")
    expect(checkAcl(acl, request({ topic: "in/a/b" }))).toBe("deny")
    expect(checkAcl(acl, request({ topic: "both" }))).toBe("allow")
    expect(checkAcl(acl, request({ action: "publish", topic: "both" }))).toBe("allow")
    expect(checkAcl(acl, request({ action: "publish", topic: "in/a" }))).toBe("deny")
    expect(checkAcl(acl, request({ action: "publish", topic: "out/device-1" }))).toBe("allow")
    expect(checkAcl(acl, request({ action: "publish", topic: "out/device-2" }))).toBe("deny")
    // `eq` compares the filter as text: the wildcard is not expanded.
    expect(checkAcl(acl, request({ topic: "exact/#" }))).toBe("allow")
    expect(checkAcl(acl, request({ topic: "exact/a" }))).toBe("deny")
    // A requested filter is matched word by word as written (emqx_topic:match_tokens/2), so
    // `in/+` covers `in/#`, whose second word is the single word `#`, and not `in/a/#`.
    expect(checkAcl(acl, request({ topic: "in/+" }))).toBe("allow")
    expect(checkAcl(acl, request({ topic: "in/#" }))).toBe("allow")
    expect(checkAcl(acl, request({ topic: "in/a/#" }))).toBe("deny")
    expect(checkAcl(acl, request({ topic: "#" }))).toBe("deny")
  })

  test("the list form takes the first matching rule and passes when none matches", () => {
    const acl = parseAcl([
      { permission: "deny", action: "subscribe", topic: `user/${PLACEHOLDER.username}/secret` },
      {
        permission: "allow",
        action: "sub",
        topics: [`user/${PLACEHOLDER.username}/#`],
        qos: [0, 1],
      },
      { permission: "allow", action: "pub", topic: "telemetry", qos: "1", retain: false },
      { permission: "deny", action: "all", topic: "blocked/#" },
    ])
    if (!acl) throw new Error("acl did not parse")
    expect(checkAcl(acl, request({ topic: "user/alice/inbox" }))).toBe("allow")
    expect(checkAcl(acl, request({ topic: "user/alice/secret" }))).toBe("deny")
    expect(checkAcl(acl, request({ topic: "user/bob/inbox" }))).toBe("nomatch")
    expect(checkAcl(acl, request({ topic: "user/alice/inbox", qos: 2 }))).toBe("nomatch")
    expect(checkAcl(acl, request({ action: "publish", topic: "telemetry" }))).toBe("allow")
    expect(checkAcl(acl, request({ action: "publish", topic: "telemetry", qos: 0 }))).toBe(
      "nomatch",
    )
    expect(checkAcl(acl, request({ action: "publish", topic: "telemetry", retain: true }))).toBe(
      "nomatch",
    )
    expect(checkAcl(acl, request({ action: "publish", topic: "blocked/x" }))).toBe("deny")
    expect(checkAcl(acl, request({ topic: "blocked/x" }))).toBe("deny")
  })
})
