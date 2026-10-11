/**
 * AWS IoT Core policy evaluation and SigV4 verification as units.
 * Policies: https://docs.aws.amazon.com/iot/latest/developerguide/pub-sub-policy.html and
 * https://docs.aws.amazon.com/iot/latest/developerguide/iot-policies.html.
 */
import { describe, expect, test } from "bun:test"
import {
  isAllowed,
  type PolicyDocument,
  PolicyError,
  parsePolicyDocument,
  parseSettings,
  resourceArn,
} from "./src/index.js"
import { parseAuthorization, verifySigV4 } from "./src/sigv4.js"
import { signRequest } from "./test/consumer.js"

const context = { region: "us-east-1", accountId: "123456789012", clientId: "device-1" }
const arn = (resource: string) => `arn:aws:iot:us-east-1:123456789012:${resource}`
const allow = (Action: string | string[], Resource: string | string[]): PolicyDocument => ({
  Version: "2012-10-17",
  Statement: [{ Effect: "Allow", Action, Resource }],
})

describe("policy evaluation", () => {
  test("each action names its own kind of resource", () => {
    expect(resourceArn("iot:Connect", "device-1", context)).toBe(arn("client/device-1"))
    expect(resourceArn("iot:Publish", "a/b", context)).toBe(arn("topic/a/b"))
    expect(resourceArn("iot:Receive", "a/b", context)).toBe(arn("topic/a/b"))
    expect(resourceArn("iot:Subscribe", "a/+", context)).toBe(arn("topicfilter/a/+"))
  })

  test("nothing is allowed until a statement allows it", () => {
    expect(isAllowed([], "iot:Publish", "a", context)).toBe(false)
    const policy = allow("iot:Publish", arn("topic/a"))
    expect(isAllowed([policy], "iot:Publish", "a", context)).toBe(true)
    expect(isAllowed([policy], "iot:Publish", "b", context)).toBe(false)
    // A topic resource does not grant a subscription, nor the other way round.
    expect(isAllowed([policy], "iot:Subscribe", "a", context)).toBe(false)
    expect(isAllowed([policy], "iot:Receive", "a", context)).toBe(false)
    // Another account's or region's ARN is another resource.
    const elsewhere = allow("iot:Publish", "arn:aws:iot:eu-west-1:123456789012:topic/a")
    expect(isAllowed([elsewhere], "iot:Publish", "a", context)).toBe(false)
  })

  test("* and ? are the wildcards; MQTT's + and # are ordinary characters", () => {
    const star = allow("iot:Subscribe", arn("topicfilter/department/*"))
    // "the * character is not confined to a single topic level"
    expect(isAllowed([star], "iot:Subscribe", "department/a/b/c", context)).toBe(true)
    expect(isAllowed([star], "iot:Subscribe", "department/#", context)).toBe(true)
    expect(isAllowed([star], "iot:Subscribe", "other/a", context)).toBe(false)

    // "devices can subscribe to the topic department/+/employees but not to the topic
    // department/engineering/employees"
    const plus = allow("iot:Subscribe", arn("topicfilter/department/+/employees"))
    expect(isAllowed([plus], "iot:Subscribe", "department/+/employees", context)).toBe(true)
    expect(isAllowed([plus], "iot:Subscribe", "department/engineering/employees", context)).toBe(
      false,
    )

    const single = allow("iot:Publish", arn("topic/room/?"))
    expect(isAllowed([single], "iot:Publish", "room/1", context)).toBe(true)
    expect(isAllowed([single], "iot:Publish", "room/12", context)).toBe(false)
  })

  test("an explicit Deny in any document overrides every Allow", () => {
    const documents: PolicyDocument[] = [
      allow("iot:*", "*"),
      { Statement: { Effect: "Deny", Action: ["iot:Publish"], Resource: [arn("topic/secret/*")] } },
    ]
    expect(isAllowed(documents, "iot:Publish", "open/a", context)).toBe(true)
    expect(isAllowed(documents, "iot:Publish", "secret/a", context)).toBe(false)
    expect(isAllowed(documents, "iot:Receive", "secret/a", context)).toBe(true)
    expect(isAllowed(documents, "iot:Connect", "anything", context)).toBe(true)
  })

  test("the iot:ClientId policy variable expands to the connecting client", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: AWS's policy variable syntax
    const own = allow(["iot:Publish", "iot:Receive"], arn("topic/devices/${iot:ClientId}/*"))
    expect(isAllowed([own], "iot:Publish", "devices/device-1/state", context)).toBe(true)
    expect(isAllowed([own], "iot:Publish", "devices/device-2/state", context)).toBe(false)
  })

  test("documents arrive as objects or JSON strings; what cannot be evaluated is refused", () => {
    const text = JSON.stringify(allow("iot:Connect", arn("client/device-1")))
    expect(isAllowed([parsePolicyDocument(text)], "iot:Connect", "device-1", context)).toBe(true)
    for (const bad of [
      "{not json",
      [],
      { Statement: [{ Effect: "Maybe", Action: "iot:Connect", Resource: "*" }] },
      { Statement: [{ Effect: "Allow", Action: "iot:Connect" }] },
      { Statement: [{ Effect: "Allow", Action: [], Resource: "*" }] },
      {
        Statement: [
          {
            Effect: "Allow",
            Action: "iot:Publish",
            Resource: "*",
            Condition: { IpAddress: { "aws:SourceIp": "203.0.113.0/24" } },
          },
        ],
      },
      { Statement: [{ Effect: "Allow", NotAction: "iot:Publish", Resource: "*" }] },
    ]) {
      expect(() => parsePolicyDocument(bad)).toThrow(PolicyError)
    }
  })

  test("settings are validated: quota bounds, principal ids, document counts", () => {
    const document = allow("iot:Connect", "*")
    expect(
      parseSettings({
        region: "eu-west-1",
        persistentSessionExpirySeconds: 604_800,
        credentials: [{ accessKeyId: "k", secretAccessKey: "s" }],
        authorizers: [
          { username: "u", principalId: "abc123", policyDocuments: [JSON.stringify(document)] },
        ],
      }),
    ).toEqual({
      region: "eu-west-1",
      persistentSessionExpirySeconds: 604_800,
      credentials: [{ accessKeyId: "k", secretAccessKey: "s" }],
      // Documents are kept in one shape: Action and Resource as lists.
      authorizers: [
        {
          username: "u",
          principalId: "abc123",
          policyDocuments: [
            {
              Version: "2012-10-17",
              Statement: [{ Effect: "Allow", Action: ["iot:Connect"], Resource: ["*"] }],
            },
          ],
        },
      ],
    })
    for (const bad of [
      null,
      { region: "" },
      { persistentSessionExpirySeconds: 0 },
      { persistentSessionExpirySeconds: 604_801 },
      { credentials: [{ accessKeyId: "k" }] },
      { authorizers: [{ password: "p", policyDocuments: [] }] },
      { authorizers: [{ username: "u", principalId: "not valid!", policyDocuments: [] }] },
      {
        authorizers: [
          { username: "u", policyDocuments: Array.from({ length: 11 }, () => document) },
        ],
      },
      { authorizers: [{ username: "u", policyDocuments: [{ Statement: [{ Effect: "Allow" }] }] }] },
    ]) {
      expect(() => parseSettings(bad)).toThrow()
    }
  })
})

describe("Signature Version 4", () => {
  const credentials = { accessKeyId: "fixture-key", secretAccessKey: "fixture-secret" }
  const config = { region: "us-east-1", credentials, now: () => new Date("2026-01-01T12:00:00Z") }
  const body = new TextEncoder().encode('{"type":"x"}')
  const url = new URL("https://example-ats.iot.us-east-1.amazonaws.com/topics/user%2Fexample?qos=1")
  const signed = (headers: Record<string, string> = {}) =>
    new Request(url, {
      method: "POST",
      headers: signRequest(config, "POST", url, body, headers),
      body: body as BodyInit,
    })
  const verify = (
    request: Request,
    sent: Uint8Array = body,
    secret = credentials.secretAccessKey,
  ) => {
    const authorization = parseAuthorization(request.headers.get("authorization"))
    if (!authorization) throw new Error("no authorization parsed")
    return verifySigV4(request, sent, authorization, secret)
  }

  test("the Authorization header is parsed into its scope", () => {
    expect(parseAuthorization(signed().headers.get("authorization"))).toEqual({
      accessKeyId: "fixture-key",
      date: "20260101",
      region: "us-east-1",
      service: "iotdata",
      signedHeaders: ["host", "x-amz-date"],
      signature: expect.stringMatching(/^[0-9a-f]{64}$/),
    })
    for (const header of [
      null,
      "",
      "Bearer token",
      "AWS4-HMAC-SHA256 Credential=k/20260101/us-east-1/iotdata, SignedHeaders=host, Signature=ab",
      "AWS4-HMAC-SHA256 Credential=k/20260101/us-east-1/iotdata/aws4_request, Signature=ab",
      "AWS4-HMAC-SHA256 Credential=k/20260101/us-east-1/iotdata/aws4_request, SignedHeaders=host",
    ]) {
      expect(parseAuthorization(header)).toBeUndefined()
    }
  })

  test("a request verifies only as it was signed", async () => {
    expect(await verify(signed())).toBeUndefined()
    expect(await verify(signed({ "content-type": "application/octet-stream" }))).toBeUndefined()
    expect(await verify(signed(), body, "another-secret")).toBe("signature_mismatch")
    expect(await verify(signed(), new TextEncoder().encode('{"type":"y"}'))).toBe(
      "signature_mismatch",
    )

    const original = signed()
    const moved = new Request(new URL(`${url.origin}/topics/user%2Fother?qos=1`), {
      method: "POST",
      headers: original.headers,
      body: body as BodyInit,
    })
    expect(await verify(moved)).toBe("signature_mismatch")

    const redated = new Headers(original.headers)
    redated.set("x-amz-date", "20260102T120000Z")
    expect(await verify(new Request(url, { method: "POST", headers: redated }))).toBe(
      "date_scope_mismatch",
    )
    redated.delete("x-amz-date")
    expect(await verify(new Request(url, { method: "POST", headers: redated }))).toBe(
      "missing_date",
    )

    const hashed = new Headers(original.headers)
    hashed.set("x-amz-content-sha256", "0".repeat(64))
    expect(await verify(new Request(url, { method: "POST", headers: hashed }))).toBe(
      "payload_hash_mismatch",
    )

    const unsignedHost = new Headers(original.headers)
    unsignedHost.set(
      "authorization",
      (original.headers.get("authorization") as string).replace(
        "SignedHeaders=host;",
        "SignedHeaders=",
      ),
    )
    expect(await verify(new Request(url, { method: "POST", headers: unsignedHost }))).toBe(
      "host_not_signed",
    )
  })
})
