import { describe, expect, test } from "bun:test"
import { type App, deleteApp, initializeApp } from "firebase-admin/app"
import { getMessaging } from "firebase-admin/messaging"
import {
  type App as App12,
  deleteApp as deleteApp12,
  initializeApp as initializeApp12,
} from "firebase-admin-12/app"
import { getMessaging as getMessaging12 } from "firebase-admin-12/messaging"
import { type AdminTransport, createAdminTransport } from "./src/admin.js"
import { FCM_FIXTURE_PROJECT } from "./src/index.js"
import { createServer, type FcmServer } from "./src/server.js"

type Batch = {
  successCount: number
  failureCount: number
  responses: { success: boolean; messageId?: string; error?: { code?: string } }[]
}

type MessagingClient = {
  enableLegacyHttpTransport(): void
  send(message: Record<string, unknown>, dryRun?: boolean): Promise<string>
  sendEachForMulticast(message: Record<string, unknown>): Promise<Batch>
}

type Sdk = {
  version: "13.5.0" | "12.7.0"
  server: FcmServer
  transport: AdminTransport
  app: App | App12
  messaging: MessagingClient
}

const codeOf = (error: unknown): string => {
  if (typeof error === "object" && error !== null && "code" in error) return String(error.code)
  throw error
}

const start = async (version: "13.5.0" | "12.7.0"): Promise<Sdk> => {
  const server = await createServer()
  const transport = await createAdminTransport({ origin: server.url, token: "sdk-token" })
  const name = `fcm-${version}-${Math.random().toString(16).slice(2)}`
  const options = {
    projectId: FCM_FIXTURE_PROJECT,
    credential: transport.credential,
    httpAgent: transport.agent,
  }
  const app = version === "13.5.0" ? initializeApp(options, name) : initializeApp12(options, name)
  const messaging = (version === "13.5.0"
    ? getMessaging(app)
    : getMessaging12(app)) as unknown as MessagingClient
  messaging.enableLegacyHttpTransport()
  return { version, server, transport, app, messaging }
}

const stop = async (sdk: Sdk) => {
  if (sdk.version === "13.5.0") await deleteApp(sdk.app as App)
  else await deleteApp12(sdk.app as App12)
  await sdk.transport.close()
  await sdk.server.close()
}

const reset = async (sdk: Sdk) => {
  await sdk.server.runtime.fetch(
    new Request(`${sdk.server.url}/__admin/faults`, { method: "DELETE" }),
  )
  await sdk.server.runtime.fetch(
    new Request(`${sdk.server.url}/__admin/scripts`, { method: "DELETE" }),
  )
  await sdk.server.runtime.fetch(new Request(`${sdk.server.url}/__admin/reset`, { method: "POST" }))
}

const register = async (
  sdk: Sdk,
  tokens: { token: string; state?: string; project?: string }[],
) => {
  const response = await sdk.server.runtime.fetch(
    new Request(`${sdk.server.url}/__admin/tokens`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        tokens: tokens.map((token) => ({
          platform: "android",
          project: FCM_FIXTURE_PROJECT,
          ...token,
        })),
      }),
    }),
  )
  expect(response.status).toBe(201)
}

const script = async (sdk: Sdk, token: string, errorCode: string, count = 1) => {
  const response = await sdk.server.runtime.fetch(
    new Request(`${sdk.server.url}/__admin/scripts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token, errorCode, count }),
    }),
  )
  expect(response.status).toBe(201)
}

const wireOf = async (sdk: Sdk) => {
  const response = await sdk.server.runtime.fetch(new Request(`${sdk.server.url}/__admin/outbox`))
  const body = (await response.json()) as { messages: { wire: Record<string, unknown> }[] }
  return body.messages
}

describe.each(["13.5.0", "12.7.0"] as const)("firebase-admin %s", (version) => {
  let sdk: Sdk

  test("boots", async () => {
    sdk = await start(version)
  })

  test("send resolves to the provider message name", async () => {
    await reset(sdk)
    await register(sdk, [{ token: "device-a" }])
    const name = await sdk.messaging.send({
      token: "device-a",
      notification: { title: "Hi", body: "There" },
    })
    expect(name.startsWith(`projects/${FCM_FIXTURE_PROJECT}/messages/`)).toBe(true)
    const stored = await wireOf(sdk)
    expect(stored).toHaveLength(1)
  })

  test("serializes android and apns the way this SDK writes the wire body", async () => {
    await reset(sdk)
    await register(sdk, [{ token: "device-wire" }])
    await sdk.messaging.send({
      token: "device-wire",
      data: { actions: '{"a":1}', empty: "", link: "https://example.com/x", note: "héllo" },
      android: {
        priority: "high",
        ttl: 3_600_000,
        collapseKey: "refill",
        notification: { imageUrl: "https://example.com/a.png", clickAction: "OPEN" },
      },
      apns: {
        headers: { "apns-expiration": "1700003600" },
        payload: { aps: { mutableContent: true, category: "ORDER" } },
      },
    })
    const wire = (await wireOf(sdk))[0]?.wire as {
      data: Record<string, string>
      android: {
        priority: string
        ttl: string
        collapse_key: string
        notification: { image: string; click_action: string }
      }
      apns: {
        headers: Record<string, string>
        payload: { aps: { "mutable-content": number; category: string } }
      }
    }
    expect(wire.data.actions).toBe('{"a":1}')
    expect(wire.data.empty).toBe("")
    expect(wire.data.note).toBe("héllo")
    expect(wire.android.priority).toBe("high")
    expect(wire.android.ttl).toBe("3600s")
    expect(wire.android.collapse_key).toBe("refill")
    expect(wire.android.notification.image).toBe("https://example.com/a.png")
    expect(wire.android.notification.click_action).toBe("OPEN")
    expect(wire.apns.headers["apns-expiration"]).toBe("1700003600")
    expect(wire.apns.payload.aps["mutable-content"]).toBe(1)
    expect(wire.apns.payload.aps.category).toBe("ORDER")
  })

  test("sendEachForMulticast keeps per-token results in input order", async () => {
    await reset(sdk)
    await register(sdk, [
      { token: "token-a" },
      { token: "token-b", state: "unregistered" },
      { token: "token-c" },
    ])
    const batch = await sdk.messaging.sendEachForMulticast({
      tokens: ["token-a", "token-b", "token-c"],
      notification: { title: "batch" },
    })
    expect(batch.successCount).toBe(2)
    expect(batch.failureCount).toBe(1)
    expect(batch.responses[0]?.success).toBe(true)
    expect(batch.responses[0]?.messageId?.startsWith("projects/")).toBe(true)
    expect(batch.responses[1]?.success).toBe(false)
    expect(batch.responses[1]?.error?.code).toBe("messaging/registration-token-not-registered")
    expect(batch.responses[2]?.success).toBe(true)
    expect(batch.responses[2]?.messageId?.startsWith("projects/")).toBe(true)
  })

  test("several stale tokens keep their input indexes", async () => {
    await reset(sdk)
    await register(sdk, [
      { token: "ok-1" },
      { token: "stale-1", state: "unregistered" },
      { token: "ok-2" },
      { token: "stale-2", state: "expired" },
    ])
    const batch = await sdk.messaging.sendEachForMulticast({
      tokens: ["ok-1", "stale-1", "ok-2", "stale-2"],
      notification: { title: "idx" },
    })
    expect(batch.responses.map((response) => response.success)).toEqual([true, false, true, false])
    expect(batch.responses[1]?.error?.code).toBe("messaging/registration-token-not-registered")
    expect(batch.responses[3]?.error?.code).toBe("messaging/registration-token-not-registered")
  })

  test("maps Google RPC errors the way this SDK does", async () => {
    await reset(sdk)
    await register(sdk, [{ token: "mapped" }, { token: "mismatch", state: "sender_mismatch" }])
    const expectCode = async (errorCode: string, sdkCode: string, count = 1) => {
      await script(sdk, "mapped", errorCode, count)
      const error = await sdk.messaging.send({ token: "mapped" }).then(
        () => undefined,
        (caught: unknown) => caught,
      )
      expect(codeOf(error)).toBe(sdkCode)
    }
    await expectCode("INVALID_ARGUMENT", "messaging/invalid-argument")
    await expectCode("SENDER_ID_MISMATCH", "messaging/mismatched-credential")
    await expectCode("QUOTA_EXCEEDED", "messaging/message-rate-exceeded")
    await expectCode("INTERNAL", "messaging/internal-error")
    // DEADLINE_EXCEEDED is not in firebase-admin's MESSAGING_SERVER_TO_CLIENT_CODE
    // (12.7.0 and 13.5.0), so the SDK reports unknown-error rather than server-unavailable.
    await expectCode("DEADLINE_EXCEEDED", "messaging/unknown-error")
    const mismatch = await sdk.messaging.send({ token: "mismatch" }).then(
      () => undefined,
      (caught: unknown) => caught,
    )
    expect(codeOf(mismatch)).toBe("messaging/mismatched-credential")

    await sdk.server.runtime.fetch(
      new Request(`${sdk.server.url}/__admin/settings`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ strict: true, credentials: {} }),
      }),
    )
    const unauthenticated = await sdk.messaging.send({ token: "mapped" }).then(
      () => undefined,
      (caught: unknown) => caught,
    )
    // Google's JSON 401 is status UNAUTHENTICATED with no FcmError details. Both pinned
    // SDKs map that to third-party-auth-error. authentication-error is for a non-JSON 401.
    expect(codeOf(unauthenticated)).toBe("messaging/third-party-auth-error")
  })

  test(
    "503 UNAVAILABLE is retried, then surfaces as server-unavailable",
    async () => {
      await reset(sdk)
      await register(sdk, [{ token: "flaky" }])
      // Count covers the first attempt plus firebase-admin's default 4 retries (status 503 only).
      await script(sdk, "flaky", "UNAVAILABLE", 8)
      const started = Date.now()
      const error = await sdk.messaging.send({ token: "flaky" }).then(
        () => undefined,
        (caught: unknown) => caught,
      )
      expect(codeOf(error)).toBe("messaging/server-unavailable")
      // Default backoff is 0 + 0.5s + 1s + 2s. Assert the retries happened without pinning the full sum.
      expect(Date.now() - started).toBeGreaterThan(2_000)
      const stored = await wireOf(sdk)
      expect(stored).toHaveLength(0)
    },
    { timeout: 40_000 },
  )

  test("rejects an empty multicast and one over 500 tokens before any HTTP call", async () => {
    // Both SDKs throw synchronously, before the call returns a promise.
    const empty = await Promise.resolve()
      .then(() => sdk.messaging.sendEachForMulticast({ tokens: [] }))
      .then(
        () => undefined,
        (caught: unknown) => caught,
      )
    expect(codeOf(empty)).toBe("messaging/invalid-argument")
    const tooMany = Array.from({ length: 501 }, (_, index) => `overflow-${index}`)
    const overflow = await Promise.resolve()
      .then(() => sdk.messaging.sendEachForMulticast({ tokens: tooMany }))
      .then(
        () => undefined,
        (caught: unknown) => caught,
      )
    expect(codeOf(overflow)).toBe("messaging/invalid-argument")
  })

  test("shuts down", async () => {
    await stop(sdk)
  })
})

test(
  "firebase-admin 13.5.0 sendEachForMulticast of 500 tokens keeps order",
  async () => {
    const sdk = await start("13.5.0")
    try {
      const tokens = Array.from({ length: 500 }, (_, index) => `bulk-${index}`)
      await register(
        sdk,
        tokens.map((token) => ({ token })),
      )
      const batch = await sdk.messaging.sendEachForMulticast({
        tokens,
        notification: { title: "bulk" },
      })
      expect(batch.successCount).toBe(500)
      expect(batch.failureCount).toBe(0)
      expect(batch.responses).toHaveLength(500)
      const ids = batch.responses.map((response) => response.messageId)
      expect(new Set(ids).size).toBe(500)
      expect(ids.every((id) => id?.startsWith(`projects/${FCM_FIXTURE_PROJECT}/messages/`))).toBe(
        true,
      )
    } finally {
      await stop(sdk)
    }
  },
  { timeout: 60_000 },
)

test("a stopped mock settles as a transport failure without the 15s retry budget", async () => {
  const sdk = await start("13.5.0")
  try {
    await register(sdk, [{ token: "device-a" }])
    await sdk.transport.close()
    await sdk.server.close()
    const started = Date.now()
    const error = await sdk.messaging.send({ token: "device-a" }).then(
      () => undefined,
      (caught: unknown) => caught,
    )
    expect(codeOf(error)).toBe("app/network-error")
    expect(Date.now() - started).toBeLessThan(10_000)
  } finally {
    if (sdk.version === "13.5.0") await deleteApp(sdk.app as App)
  }
})
