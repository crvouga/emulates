import { describe, expect, test } from "bun:test"
import { createClock } from "@emulates/service"
import {
  createRuntime,
  FCM_FIXTURE_PROJECT,
  FCM_FIXTURE_TOKEN,
  FCM_PRESETS,
  type FcmRuntime,
} from "./src/index.js"
import { createServer } from "./src/server.js"
import { sendToFcm } from "./test/consumer.js"

const BASE = "http://fcm.test"

const admin = async (
  runtime: FcmRuntime,
  method: string,
  path: string,
  body?: unknown,
  namespace?: string,
) => {
  const headers: Record<string, string> = { "content-type": "application/json" }
  if (namespace) headers["x-emulates-namespace"] = namespace
  const response = await runtime.fetch(
    new Request(`${BASE}/__admin${path}`, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }),
  )
  return { status: response.status, body: (await response.json()) as Record<string, unknown> }
}

const outbox = async (runtime: FcmRuntime, namespace?: string) => {
  const result = await admin(runtime, "GET", "/outbox", undefined, namespace)
  return result.body.messages as { id: string; name: string; state: string; token: string }[]
}

const register = (
  runtime: FcmRuntime,
  token: string,
  extra: Record<string, unknown> = {},
  namespace?: string,
) =>
  admin(
    runtime,
    "POST",
    "/tokens",
    { token, platform: "android", project: FCM_FIXTURE_PROJECT, ...extra },
    namespace,
  )

describe("FCM HTTP v1", () => {
  test("accepts a fixture token, delivers the inbox, and stamps x-emulates", async () => {
    const runtime = createRuntime()
    // A past apns-expiration expires the accept before the inbox is written.
    const apnsExpiration = String(Math.floor(Date.now() / 1000) + 7200)
    const response = await runtime.fetch(
      new Request(`${BASE}/v1/projects/${FCM_FIXTURE_PROJECT}/messages:send`, {
        method: "POST",
        headers: { authorization: "Bearer fixture-token", "content-type": "application/json" },
        body: JSON.stringify({
          message: {
            token: FCM_FIXTURE_TOKEN,
            notification: { title: "Hello", body: "World", image: "https://example.com/a.png" },
            data: {
              type: "refill",
              actions: '{"ok":true}',
              empty: "",
              link: "https://example.com/go",
              note: "héllo 好",
            },
            android: {
              priority: "HIGH",
              ttl: "3600s",
              collapse_key: "refill",
              notification: { image: "https://example.com/a.png", click_action: "OPEN" },
            },
            apns: {
              headers: { "apns-expiration": apnsExpiration },
              payload: { aps: { "mutable-content": 1, category: "ORDER" } },
            },
          },
        }),
      }),
    )
    expect(response.headers.get("x-emulates")).toContain("fcm@")
    const body = (await response.json()) as { name: string }
    expect(response.status).toBe(200)
    const messages = await outbox(runtime)
    expect(messages).toHaveLength(1)
    expect(body.name).toBe(`projects/${FCM_FIXTURE_PROJECT}/messages/${messages[0]?.id}`)
    expect(messages[0]?.state).toBe("delivered")
    const inbox = await admin(runtime, "GET", `/inbox/${FCM_FIXTURE_TOKEN}`)
    const items = inbox.body.messages as {
      id: string
      messageId: string
      title: string
      body: string
      image: string
      data: Record<string, string>
      android: { priority: string; notification: { click_action: string } }
      apns: { payload: { aps: { category: string } } }
    }[]
    expect(items).toHaveLength(1)
    expect(items[0]?.id).toBe(messages[0]?.id)
    expect(items[0]?.messageId).toBe(messages[0]?.id)
    expect(items[0]?.title).toBe("Hello")
    expect(items[0]?.body).toBe("World")
    expect(items[0]?.image).toBe("https://example.com/a.png")
    expect(items[0]?.data).toEqual({
      type: "refill",
      actions: '{"ok":true}',
      empty: "",
      link: "https://example.com/go",
      note: "héllo 好",
    })
    expect(items[0]?.android.priority).toBe("HIGH")
    expect(items[0]?.android.notification.click_action).toBe("OPEN")
    expect(items[0]?.apns.payload.aps.category).toBe("ORDER")
    const stored = (await admin(runtime, "GET", "/outbox")).body.messages as {
      collapseKey: string
      ttl: string
      apnsExpiration: string
      wire: { data: { actions: string } }
    }[]
    expect(stored[0]?.collapseKey).toBe("refill")
    expect(stored[0]?.ttl).toBe("3600s")
    expect(stored[0]?.apnsExpiration).toBe(apnsExpiration)
    expect(stored[0]?.wire.data.actions).toBe('{"ok":true}')
  })

  test("rejects auth, validation, and foreign tokens without storing a message", async () => {
    const runtime = createRuntime()
    const missing = await sendToFcm(
      runtime.fetch.bind(runtime),
      BASE,
      FCM_FIXTURE_PROJECT,
      { token: FCM_FIXTURE_TOKEN },
      { bearer: "" },
    )
    expect(missing.ok).toBe(false)
    if (!missing.ok) expect(missing.errorStatus).toBe("UNAUTHENTICATED")

    await admin(runtime, "PUT", "/settings", { strict: true })
    const unknown = await sendToFcm(
      runtime.fetch.bind(runtime),
      BASE,
      FCM_FIXTURE_PROJECT,
      { token: FCM_FIXTURE_TOKEN },
      { bearer: "nope" },
    )
    expect(unknown.ok).toBe(false)
    if (!unknown.ok) {
      expect(unknown.status).toBe(401)
      expect(unknown.errorStatus).toBe("UNAUTHENTICATED")
      expect(unknown.errorCode).toBeUndefined()
    }

    await admin(runtime, "PUT", "/settings", {
      strict: true,
      credentials: { "project-a-token": { project: "other-project" } },
    })
    const denied = await sendToFcm(
      runtime.fetch.bind(runtime),
      BASE,
      FCM_FIXTURE_PROJECT,
      { token: FCM_FIXTURE_TOKEN },
      { bearer: "project-a-token" },
    )
    expect(denied.ok).toBe(false)
    if (!denied.ok) {
      expect(denied.status).toBe(403)
      expect(denied.errorStatus).toBe("PERMISSION_DENIED")
    }

    await admin(runtime, "PUT", "/settings", { strict: false, credentials: {} })
    const malformed = await runtime.fetch(
      new Request(`${BASE}/v1/projects/${FCM_FIXTURE_PROJECT}/messages:send`, {
        method: "POST",
        headers: { authorization: "Bearer fixture-token", "content-type": "application/json" },
        body: "{",
      }),
    )
    const malformedBody = (await malformed.json()) as { error: { status: string } }
    expect(malformed.status).toBe(400)
    expect(malformedBody.error.status).toBe("INVALID_ARGUMENT")

    const badData = await sendToFcm(runtime.fetch.bind(runtime), BASE, FCM_FIXTURE_PROJECT, {
      token: FCM_FIXTURE_TOKEN,
      data: { n: 1 },
    })
    expect(badData.ok).toBe(false)
    if (!badData.ok) expect(badData.errorStatus).toBe("INVALID_ARGUMENT")

    const twoTargets = await sendToFcm(runtime.fetch.bind(runtime), BASE, FCM_FIXTURE_PROJECT, {
      token: FCM_FIXTURE_TOKEN,
      topic: "news",
    })
    expect(twoTargets.ok).toBe(false)

    const topicOnly = await sendToFcm(runtime.fetch.bind(runtime), BASE, FCM_FIXTURE_PROJECT, {
      topic: "news",
    })
    expect(topicOnly.ok).toBe(false)
    if (!topicOnly.ok) expect(topicOnly.errorStatus).toBe("INVALID_ARGUMENT")

    await register(runtime, "other-app", { project: "other-project" })
    const foreign = await sendToFcm(runtime.fetch.bind(runtime), BASE, FCM_FIXTURE_PROJECT, {
      token: "other-app",
    })
    expect(foreign.ok).toBe(false)
    if (!foreign.ok) {
      expect(foreign.status).toBe(403)
      expect(foreign.errorCode).toBe("SENDER_ID_MISMATCH")
    }
    expect(await outbox(runtime)).toHaveLength(0)
  })

  test("unregistered and expired tokens do not accept, and a one-shot script then follows token state", async () => {
    const runtime = createRuntime()
    await register(runtime, "gone", { state: "unregistered" })
    await register(runtime, "old", { state: "expired" })
    const unregistered = await sendToFcm(runtime.fetch.bind(runtime), BASE, FCM_FIXTURE_PROJECT, {
      token: "gone",
    })
    const expired = await sendToFcm(runtime.fetch.bind(runtime), BASE, FCM_FIXTURE_PROJECT, {
      token: "old",
    })
    expect(unregistered.ok).toBe(false)
    expect(expired.ok).toBe(false)
    if (!unregistered.ok) expect(unregistered.errorCode).toBe("UNREGISTERED")
    if (!expired.ok) expect(expired.errorCode).toBe("UNREGISTERED")

    await register(runtime, "scripted")
    await admin(runtime, "POST", "/scripts", {
      token: "scripted",
      errorCode: "QUOTA_EXCEEDED",
      count: 1,
    })
    const first = await sendToFcm(runtime.fetch.bind(runtime), BASE, FCM_FIXTURE_PROJECT, {
      token: "scripted",
    })
    const second = await sendToFcm(runtime.fetch.bind(runtime), BASE, FCM_FIXTURE_PROJECT, {
      token: "scripted",
    })
    expect(first.ok).toBe(false)
    if (!first.ok) expect(first.errorCode).toBe("QUOTA_EXCEEDED")
    expect(second.ok).toBe(true)
    expect(await outbox(runtime)).toHaveLength(1)
  })

  test("validate_only returns a name and stores nothing, including when validation fails", async () => {
    const runtime = createRuntime()
    const ok = await sendToFcm(
      runtime.fetch.bind(runtime),
      BASE,
      FCM_FIXTURE_PROJECT,
      { token: FCM_FIXTURE_TOKEN, notification: { title: "dry" } },
      { validateOnly: true },
    )
    expect(ok.ok).toBe(true)
    if (ok.ok) expect(ok.name.startsWith(`projects/${FCM_FIXTURE_PROJECT}/messages/`)).toBe(true)
    expect(await outbox(runtime)).toHaveLength(0)
    const inbox = await admin(runtime, "GET", `/inbox/${FCM_FIXTURE_TOKEN}`)
    expect(inbox.body.messages).toEqual([])
    const bad = await sendToFcm(
      runtime.fetch.bind(runtime),
      BASE,
      FCM_FIXTURE_PROJECT,
      { token: "missing" },
      { validateOnly: true },
    )
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.errorCode).toBe("UNREGISTERED")
    expect(await outbox(runtime)).toHaveLength(0)
  })

  test("collapse keeps only the latest undelivered message, and messages without a key stay distinct", async () => {
    const runtime = createRuntime()
    await admin(runtime, "PUT", "/settings", { automaticDelivery: false, collapse: true })
    await register(runtime, "phone")
    await sendToFcm(runtime.fetch.bind(runtime), BASE, FCM_FIXTURE_PROJECT, {
      token: "phone",
      notification: { title: "older" },
      android: { collapse_key: "order" },
    })
    await sendToFcm(runtime.fetch.bind(runtime), BASE, FCM_FIXTURE_PROJECT, {
      token: "phone",
      notification: { title: "newer" },
      android: { collapse_key: "order" },
    })
    await sendToFcm(runtime.fetch.bind(runtime), BASE, FCM_FIXTURE_PROJECT, {
      token: "phone",
      notification: { title: "solo-a" },
    })
    await sendToFcm(runtime.fetch.bind(runtime), BASE, FCM_FIXTURE_PROJECT, {
      token: "phone",
      notification: { title: "solo-b" },
    })
    await admin(runtime, "POST", "/deliver")
    const messages = (await admin(runtime, "GET", "/outbox")).body.messages as {
      state: string
      notification: { title?: string }
    }[]
    expect(messages.map((message) => message.state)).toEqual([
      "collapsed",
      "delivered",
      "delivered",
      "delivered",
    ])
    const inbox = (await admin(runtime, "GET", "/inbox/phone")).body.messages as { title: string }[]
    expect(inbox.map((item) => item.title)).toEqual(["newer", "solo-a", "solo-b"])
  })

  test("TTL expiry keeps the accept and delivers nothing after the namespace clock moves", async () => {
    const clock = createClock()
    clock.set(1_700_000_000_000)
    const runtime = createRuntime({ clock })
    await admin(runtime, "PUT", "/settings", { automaticDelivery: false })
    await register(runtime, "phone")
    await sendToFcm(runtime.fetch.bind(runtime), BASE, FCM_FIXTURE_PROJECT, {
      token: "phone",
      android: { ttl: "1s" },
      apns: { headers: { "apns-expiration": "1700000002" } },
    })
    await admin(runtime, "POST", "/time", { advanceMs: 1_500 })
    await admin(runtime, "POST", "/deliver")
    const messages = await outbox(runtime)
    expect(messages).toHaveLength(1)
    expect(messages[0]?.state).toBe("expired")
    const inbox = await admin(runtime, "GET", "/inbox/phone")
    expect(inbox.body.messages).toEqual([])
  })

  test("drop-before-accept stores nothing; accepted-then-drop stores the message and throws", async () => {
    const runtime = createRuntime()
    await admin(runtime, "POST", "/faults", { preset: "drop" })
    await expect(
      sendToFcm(runtime.fetch.bind(runtime), BASE, FCM_FIXTURE_PROJECT, {
        token: FCM_FIXTURE_TOKEN,
      }),
    ).rejects.toMatchObject({ code: "EMULATES_DROP" })
    expect(await outbox(runtime)).toHaveLength(0)
    await admin(runtime, "DELETE", "/faults")
    await admin(runtime, "POST", "/faults", { preset: "accepted_then_network_drop" })
    await expect(
      sendToFcm(runtime.fetch.bind(runtime), BASE, FCM_FIXTURE_PROJECT, {
        token: FCM_FIXTURE_TOKEN,
      }),
    ).rejects.toMatchObject({ code: "EMULATES_DROP" })
    const messages = await outbox(runtime)
    expect(messages).toHaveLength(1)
    expect(messages[0]?.state).toBe("delivered")
  })

  test("a quota fault is visible in metrics and stores nothing", async () => {
    const runtime = createRuntime()
    expect(FCM_PRESETS.slow?.rules?.[0]?.latencyMs).toBeGreaterThanOrEqual(15_000)
    await admin(runtime, "POST", "/faults", { preset: "quota_exceeded" })
    const result = await sendToFcm(runtime.fetch.bind(runtime), BASE, FCM_FIXTURE_PROJECT, {
      token: FCM_FIXTURE_TOKEN,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(429)
    const metrics = await admin(runtime, "GET", "/metrics")
    expect(metrics.body.faults).toBe(1)
    expect(await outbox(runtime)).toHaveLength(0)
    await admin(runtime, "DELETE", "/faults")
    await admin(runtime, "DELETE", "/metrics")
    await admin(runtime, "POST", "/faults", { operationId: "SendMessage", latencyMs: 30 })
    await sendToFcm(runtime.fetch.bind(runtime), BASE, FCM_FIXTURE_PROJECT, {
      token: FCM_FIXTURE_TOKEN,
    })
    const after = await admin(runtime, "GET", "/metrics")
    expect(after.body.totalDurationMs as number).toBeGreaterThanOrEqual(30)
  })

  test("namespaces isolate tokens, ids, faults, and clock offsets", async () => {
    const clock = createClock()
    clock.set(1_700_000_000_000)
    const runtime = createRuntime({ clock })
    for (const namespace of ["alpha", "beta"]) {
      await admin(runtime, "PUT", "/settings", { automaticDelivery: false }, namespace)
      await register(runtime, "same-token", {}, namespace)
    }
    await sendToFcm(
      runtime.fetch.bind(runtime),
      BASE,
      FCM_FIXTURE_PROJECT,
      {
        token: "same-token",
        android: { ttl: "1s" },
      },
      { headers: { "x-emulates-namespace": "alpha" } },
    )
    await sendToFcm(
      runtime.fetch.bind(runtime),
      BASE,
      FCM_FIXTURE_PROJECT,
      {
        token: "same-token",
        android: { ttl: "1s" },
      },
      { headers: { "x-emulates-namespace": "beta" } },
    )
    const alpha = await outbox(runtime, "alpha")
    const beta = await outbox(runtime, "beta")
    expect(alpha[0]?.id).not.toBe(beta[0]?.id)
    await admin(runtime, "POST", "/time", { advanceMs: 5_000 }, "alpha")
    await admin(runtime, "POST", "/deliver", undefined, "alpha")
    await admin(runtime, "POST", "/deliver", undefined, "beta")
    expect((await outbox(runtime, "alpha"))[0]?.state).toBe("expired")
    expect((await outbox(runtime, "beta"))[0]?.state).toBe("delivered")
    await admin(runtime, "POST", "/faults", { preset: "invalid_argument" }, "alpha")
    const blocked = await sendToFcm(
      runtime.fetch.bind(runtime),
      BASE,
      FCM_FIXTURE_PROJECT,
      { token: "same-token" },
      {
        headers: { "x-emulates-namespace": "alpha" },
      },
    )
    const open = await sendToFcm(
      runtime.fetch.bind(runtime),
      BASE,
      FCM_FIXTURE_PROJECT,
      { token: "same-token" },
      {
        headers: { "x-emulates-namespace": "beta" },
      },
    )
    expect(blocked.ok).toBe(false)
    expect(open.ok).toBe(true)
    await admin(runtime, "POST", "/reset", undefined, "alpha")
    expect(await outbox(runtime, "alpha")).toHaveLength(0)
    expect((await outbox(runtime, "beta")).length).toBeGreaterThan(0)
  })

  test("the journal records ids and a token hash, never the token, text, url, or bearer", async () => {
    const runtime = createRuntime()
    const token = "raw-device-token-should-not-leak"
    const bearer = "raw-bearer-should-not-leak"
    await register(runtime, token)
    await sendToFcm(
      runtime.fetch.bind(runtime),
      BASE,
      FCM_FIXTURE_PROJECT,
      {
        token,
        notification: { title: "DISTINCTIVE_TITLE", body: "DISTINCTIVE_BODY" },
        data: { actions: "https://secret.example/action" },
      },
      { bearer },
    )
    const logged = await admin(runtime, "GET", "/requests?operationId=SendMessage")
    const text = JSON.stringify(logged.body)
    expect(text).not.toContain(token)
    expect(text).not.toContain(bearer)
    expect(text).not.toContain("DISTINCTIVE_TITLE")
    expect(text).not.toContain("DISTINCTIVE_BODY")
    expect(text).not.toContain("https://secret.example/action")
    expect(text).toContain("tokenHash")
    expect(text).toContain(FCM_FIXTURE_PROJECT)
  })

  test("createServer answers a send over HTTP", async () => {
    const server = await createServer()
    try {
      const health = await fetch(`${server.url}/__admin/health`)
      expect(health.status).toBe(200)
      const result = await sendToFcm(fetch, server.url, FCM_FIXTURE_PROJECT, {
        token: FCM_FIXTURE_TOKEN,
        notification: { title: "served" },
      })
      expect(result.ok).toBe(true)
    } finally {
      await server.close()
    }
  })
})
