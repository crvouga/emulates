import { describe, expect, test } from "bun:test"
import { pollWebAuth, webChallenge } from "./web-auth.ts"

const challenge = {
  authUrl: "https://www.npmjs.com/login/00000000-0000-0000-0000-000000000000",
  doneUrl: "https://registry.npmjs.org/-/v1/done?authId=00000000-0000-0000-0000-000000000000",
}

describe("webChallenge", () => {
  test("reads the security-key urls from a trust 401", () => {
    expect(webChallenge(401, challenge)).toEqual(challenge)
  })

  test("ignores a 401 that is not the web-auth challenge", () => {
    expect(webChallenge(401, { message: "Unauthorized" })).toBeNull()
    expect(webChallenge(200, challenge)).toBeNull()
    expect(
      webChallenge(401, {
        authUrl: "https://evil.example/login",
        doneUrl: challenge.doneUrl,
      }),
    ).toBeNull()
  })
})

describe("pollWebAuth", () => {
  test("waits through 202 and returns the one-time code", async () => {
    const seen: number[] = []
    const code = await pollWebAuth(
      async () => {
        seen.push(seen.length)
        if (seen.length === 1) return { status: 202, retryAfter: "1", body: {} }
        return { status: 200, retryAfter: null, body: { token: "otp-code" } }
      },
      async () => {},
    )
    expect(code).toBe("otp-code")
    expect(seen).toEqual([0, 1])
  })

  test("stops when the security-key prompt is not approved in time", async () => {
    let clock = 0
    await expect(
      pollWebAuth(
        async () => ({ status: 202, retryAfter: "1", body: {} }),
        async () => {
          clock += 60_000
        },
        () => clock,
        1000,
      ),
    ).rejects.toThrow("timed out waiting for the npm security key")
  })
})
