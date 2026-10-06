import { beforeEach, describe, expect, test } from "bun:test"
import { App, LogLevel, SocketModeReceiver } from "@slack/bolt"
import { SocketModeClient } from "@slack/socket-mode"
import { createRuntime } from "./src/index.js"
import { createServer } from "./src/server.js"
import { closeSocketNamespace } from "./src/sockets.js"

const APP = "xapp-1-A0MOCKAPP-socketsock"
const APP_A = "xapp-1-A0WORKSPACEA-aaaaaaaa"
const APP_B = "xapp-1-B0WORKSPACEB-bbbbbbbb"
const BOT = "xoxb-socket-bot"
const BOT_A = "xoxb-workspace-a"
const BOT_B = "xoxb-workspace-b"
const HOST = "http://slack.mock"

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

type Connection = {
  namespace: string
  appId: string
  ticket: string
  connectedAt: string | null
  state: string
  reconnectCount: number
}

const connections = async (base: string, namespace?: string): Promise<Connection[]> => {
  const headers: Record<string, string> = {}
  if (namespace) headers["x-emulates-namespace"] = namespace
  const body = (await (await fetch(`${base}/__admin/socket/connections`, { headers })).json()) as {
    connections: Connection[]
  }
  return body.connections
}

const open = async (
  fetchImpl: (input: Request) => Promise<Response>,
  token?: string,
  namespace?: string,
) => {
  const headers: Record<string, string> = { "content-type": "application/json; charset=utf-8" }
  if (token) headers.authorization = `Bearer ${token}`
  if (namespace) headers["x-emulates-namespace"] = namespace
  const response = await fetchImpl(
    new Request(`${HOST}/api/apps.connections.open`, {
      method: "POST",
      headers,
      body: "{}",
    }),
  )
  return { response, body: (await response.json()) as Record<string, unknown> }
}

const firstMessage = (url: string) =>
  new Promise<{ socket: WebSocket; data: string }>((resolve, reject) => {
    const socket = new WebSocket(url)
    const timer = setTimeout(() => {
      socket.close()
      reject(new Error("timed out waiting for a socket message"))
    }, 4_000)
    socket.onmessage = (event) => {
      clearTimeout(timer)
      resolve({ socket, data: String(event.data) })
    }
    socket.onerror = () => {
      clearTimeout(timer)
      reject(new Error("websocket error"))
    }
  })

describe("Socket Mode", () => {
  // Tickets live in a process-wide registry so the WebSocket upgrade, which has no Fetch
  // context, can find them. Each test starts from an empty registry for the names it uses.
  beforeEach(() => {
    closeSocketNamespace("default")
    closeSocketNamespace("a")
    closeSocketNamespace("b")
  })

  test("a configured app token mints a unique ticket bound to that namespace", async () => {
    const runtime = createRuntime()
    const fetchImpl = (request: Request) => runtime.fetch(request)
    await runtime.fetch(
      new Request(`${HOST}/__admin/settings`, {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          "x-emulates-namespace": "a",
        },
        body: JSON.stringify({ appId: "A0WORKSPACEA", appTokens: [APP_A] }),
      }),
    )
    const first = await open(fetchImpl, APP_A, "a")
    const second = await open(fetchImpl, APP_A, "a")
    expect(first.response.status).toBe(200)
    expect(first.body.ok).toBe(true)
    const url = String(first.body.url)
    const ticket = new URL(url).searchParams.get("ticket")
    expect(ticket).toBeTruthy()
    expect(url).toContain("app_id=A0WORKSPACEA")
    expect(second.body.url).not.toBe(first.body.url)
    const rows = await (
      await runtime.fetch(
        new Request(`${HOST}/__admin/socket/connections`, {
          headers: { "x-emulates-namespace": "a" },
        }),
      )
    ).json()
    const listed = (rows as { connections: Connection[] }).connections
    expect(listed.map((row) => row.ticket)).toEqual(
      expect.arrayContaining([ticket, new URL(String(second.body.url)).searchParams.get("ticket")]),
    )
    expect(listed.every((row) => row.namespace === "a" && row.appId === "A0WORKSPACEA")).toBe(true)
    expect(listed.every((row) => row.state === "pending")).toBe(true)
  })

  test("missing, malformed, revoked, and foreign app tokens open nothing", async () => {
    const runtime = createRuntime()
    const fetchImpl = (request: Request) => runtime.fetch(request)
    await runtime.fetch(
      new Request(`${HOST}/__admin/settings`, {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          "x-emulates-namespace": "a",
        },
        body: JSON.stringify({
          appTokens: [APP_A],
          revokedAppTokens: ["xapp-1-REVOKEDAPP-revoked1"],
        }),
      }),
    )
    await runtime.fetch(
      new Request(`${HOST}/__admin/credentials`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ credentials: { [APP_B]: "b" } }),
      }),
    )
    const missing = await open(fetchImpl, undefined, "a")
    const malformed = await open(fetchImpl, "xapp-no", "a")
    const bot = await open(fetchImpl, BOT, "a")
    const revoked = await open(fetchImpl, "xapp-1-REVOKEDAPP-revoked1", "a")
    const foreign = await open(fetchImpl, APP_B, "a")
    const bodyOnly = await fetchImpl(
      new Request(`${HOST}/api/apps.connections.open`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "x-emulates-namespace": "a",
        },
        body: `token=${APP_A}`,
      }),
    )
    expect(missing.body).toEqual({ ok: false, error: "not_authed" })
    expect(malformed.body).toEqual({ ok: false, error: "invalid_auth" })
    expect(bot.body).toEqual({ ok: false, error: "not_allowed_token_type" })
    expect(revoked.body).toEqual({ ok: false, error: "token_revoked" })
    expect(foreign.body).toEqual({ ok: false, error: "invalid_auth" })
    expect(await bodyOnly.json()).toEqual({ ok: false, error: "not_authed" })
    for (const result of [missing, malformed, bot, revoked, foreign]) {
      expect(result.response.status).toBe(200)
    }
    const rows = await (
      await runtime.fetch(
        new Request(`${HOST}/__admin/socket/connections`, {
          headers: { "x-emulates-namespace": "a" },
        }),
      )
    ).json()
    expect((rows as { connections: Connection[] }).connections).toEqual([])
  })

  test("a valid ticket upgrades once and the first frame is hello", async () => {
    const server = await createServer()
    try {
      const response = await fetch(`${server.url}/api/apps.connections.open`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${APP}`,
          "content-type": "application/json; charset=utf-8",
        },
        body: "{}",
      })
      const body = (await response.json()) as { ok: boolean; url: string }
      expect(body.ok).toBe(true)
      const { socket, data } = await firstMessage(body.url)
      const hello = JSON.parse(data) as {
        type: string
        num_connections: number
        connection_info: { app_id: string }
        debug_info: { approximate_connection_time: number }
      }
      expect(hello.type).toBe("hello")
      expect(hello.connection_info.app_id).toBe("A0MOCKAPP")
      expect(hello.num_connections).toBe(1)
      expect(typeof hello.debug_info.approximate_connection_time).toBe("number")
      const extra: string[] = []
      socket.onmessage = (event) => extra.push(String(event.data))
      socket.send(JSON.stringify({ envelope_id: "env-1" }))
      await delay(200)
      expect(extra).toEqual([])
      expect(socket.readyState).toBe(WebSocket.OPEN)
      socket.close()
      await delay(50)
      const again = new WebSocket(body.url)
      const rejected = await new Promise<boolean>((resolve) => {
        again.onopen = () => resolve(false)
        again.onerror = () => resolve(true)
        again.onclose = () => resolve(true)
      })
      expect(rejected).toBe(true)
      again.close()
    } finally {
      await server.close()
    }
  })

  test("ping and pong keep a default Socket Mode client connected", async () => {
    const server = await createServer()
    const client = new SocketModeClient({
      appToken: APP,
      logLevel: LogLevel.ERROR,
      clientOptions: { slackApiUrl: `${server.url}/api/` },
    })
    let connected = 0
    client.on("connected", () => {
      connected += 1
    })
    try {
      await client.start()
      await delay(6_500)
      expect(connected).toBe(1)
      const rows = await connections(server.url)
      expect(rows.filter((row) => row.state === "open")).toHaveLength(1)
    } finally {
      await client.disconnect()
      await server.close()
    }
  }, 15_000)

  test("a configured lifetime ends the socket with a warning disconnect", async () => {
    const server = await createServer()
    try {
      await fetch(`${server.url}/__admin/settings`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ socketLifetimeMs: 200 }),
      })
      const response = await fetch(`${server.url}/api/apps.connections.open`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${APP}`,
          "content-type": "application/json; charset=utf-8",
        },
        body: "{}",
      })
      const body = (await response.json()) as { url: string }
      const { socket, data } = await firstMessage(body.url)
      expect(JSON.parse(data).type).toBe("hello")
      const next = await new Promise<string>((resolve) => {
        socket.onmessage = (event) => resolve(String(event.data))
      })
      expect(JSON.parse(next)).toMatchObject({ type: "disconnect", reason: "warning" })
      socket.close()
    } finally {
      await server.close()
    }
  })

  test("warning and refresh_requested disconnects follow Slack's envelope", async () => {
    const server = await createServer()
    const client = new SocketModeClient({
      appToken: APP,
      logLevel: LogLevel.ERROR,
      clientPingTimeout: 200,
      clientOptions: { slackApiUrl: `${server.url}/api/` },
    })
    try {
      await client.start()
      const before = await connections(server.url)
      expect(before.filter((row) => row.state === "open")).toHaveLength(1)
      const warned = await fetch(`${server.url}/__admin/socket/disconnect`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: "warning" }),
      })
      expect(((await warned.json()) as { closed: number }).closed).toBe(1)
      let reopened = false
      for (let i = 0; i < 40 && !reopened; i++) {
        await delay(50)
        const rows = await connections(server.url)
        reopened = rows.some((row) => row.state === "open" && row.reconnectCount === 1)
      }
      expect(reopened).toBe(true)
      expect(
        before[0] &&
          (await connections(server.url)).some(
            (row) => row.ticket === before[0]?.ticket && row.state === "closed",
          ),
      ).toBe(true)

      const fresh = await fetch(`${server.url}/api/apps.connections.open`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${APP}`,
          "content-type": "application/json; charset=utf-8",
        },
        body: "{}",
      })
      const url = ((await fresh.json()) as { url: string }).url
      const { socket, data } = await firstMessage(url)
      expect(JSON.parse(data).type).toBe("hello")
      const pending = new Promise<Record<string, unknown>>((resolve) => {
        socket.onmessage = (event) =>
          resolve(JSON.parse(String(event.data)) as Record<string, unknown>)
      })
      await fetch(`${server.url}/__admin/socket/disconnect`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: "refresh_requested" }),
      })
      const envelope = await pending
      expect(envelope.type).toBe("disconnect")
      expect(envelope.reason).toBe("refresh_requested")
      expect(envelope).not.toHaveProperty("url")
      expect(envelope.debug_info).toBeTruthy()
      socket.close()
    } finally {
      await client.disconnect()
      await server.close()
    }
  }, 15_000)

  test("an abnormal close lets Bolt replace the socket without losing the outbox", async () => {
    const server = await createServer()
    server.runtime.applyPreset("socket_abnormal_close", "default", { count: 1 })
    const app = new App({
      token: BOT,
      appToken: APP,
      socketMode: true,
      clientOptions: { slackApiUrl: `${server.url}/api/` },
      logLevel: LogLevel.ERROR,
    })
    try {
      await app.start()
      const posted = await app.client.chat.postMessage({ channel: "C0SOCKET", text: "keep me" })
      let replaced = false
      for (let i = 0; i < 50 && !replaced; i++) {
        await delay(200)
        const rows = await connections(server.url)
        const openRows = rows.filter((row) => row.state === "open")
        replaced =
          openRows.length === 1 &&
          openRows[0]?.reconnectCount === 1 &&
          rows.some((row) => row.state === "closed")
      }
      expect(replaced).toBe(true)
      const closed = (await connections(server.url)).find((row) => row.state === "closed")
      const reuse = new WebSocket(
        `${server.url.replace("http", "ws")}/link/?ticket=${closed?.ticket ?? "missing"}&app_id=A0MOCKAPP`,
      )
      const rejected = await new Promise<boolean>((resolve) => {
        reuse.onopen = () => resolve(false)
        reuse.onerror = () => resolve(true)
        reuse.onclose = () => resolve(true)
      })
      expect(rejected).toBe(true)
      reuse.close()
      const outbox = (await (await fetch(`${server.url}/__admin/outbox`)).json()) as {
        messages: { text: string | null; ts: string }[]
      }
      expect(outbox.messages.map((message) => message.text)).toContain("keep me")
      expect(posted.ok).toBe(true)
    } finally {
      await app.stop()
      await server.close()
    }
  }, 20_000)

  test("two Bolt workspaces keep separate sockets, messages, and faults", async () => {
    const server = await createServer()
    await fetch(`${server.url}/__admin/credentials`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        credentials: { [APP_A]: "a", [BOT_A]: "a", [APP_B]: "b", [BOT_B]: "b" },
      }),
    })
    for (const [namespace, appId, token] of [
      ["a", "A0WORKSPACEA", APP_A],
      ["b", "B0WORKSPACEB", APP_B],
    ] as const) {
      await fetch(`${server.url}/__admin/settings`, {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          "x-emulates-namespace": namespace,
        },
        body: JSON.stringify({
          appId,
          appTokens: [token],
          teamId: namespace === "a" ? "T0A" : "T0B",
        }),
      })
    }
    const boot = (token: string, appToken: string) => {
      let connected = 0
      const receiver = new SocketModeReceiver({
        appToken,
        logLevel: LogLevel.ERROR,
        installerOptions: { clientOptions: { slackApiUrl: `${server.url}/api/` } },
      })
      receiver.client.on("connected", () => {
        connected += 1
      })
      const app = new App({
        token,
        socketMode: true,
        receiver,
        clientOptions: { slackApiUrl: `${server.url}/api/` },
        logLevel: LogLevel.ERROR,
      })
      return { app, connected: () => connected }
    }
    const workspaceA = boot(BOT_A, APP_A)
    const workspaceB = boot(BOT_B, APP_B)
    try {
      await workspaceA.app.start()
      await workspaceB.app.start()
      expect(workspaceA.connected()).toBe(1)
      expect(workspaceB.connected()).toBe(1)
      const blocks = [{ type: "section", text: { type: "mrkdwn", text: "desk alert" } }]
      const posted = await workspaceA.app.client.chat.postMessage({
        channel: "C0DESK",
        text: "desk alert",
        blocks,
        unfurl_links: false,
      })
      const reply = await workspaceA.app.client.chat.postMessage({
        channel: "C0DESK",
        text: "thread reply",
        thread_ts: posted.ts as string,
        unfurl_links: false,
      })
      const updated = await workspaceA.app.client.chat.update({
        channel: "C0DESK",
        ts: posted.ts as string,
        text: "desk alert edited",
      })
      expect(posted.ok).toBe(true)
      expect(reply.ts).not.toBe(posted.ts)
      expect(updated.ts).toBe(posted.ts)
      const outbox = (await (
        await fetch(`${server.url}/__admin/outbox?channel=C0DESK`, {
          headers: { "x-emulates-namespace": "a" },
        })
      ).json()) as {
        messages: {
          text: string | null
          blocks: unknown[] | null
          thread_ts: string | null
          ts: string
          unfurl_links: boolean | null
          workspace: string
          edited: { user: string } | null
        }[]
      }
      expect(outbox.messages.map((message) => message.ts)).toEqual([
        posted.ts as string,
        reply.ts as string,
      ])
      expect(outbox.messages[0]).toMatchObject({
        text: "desk alert edited",
        blocks,
        unfurl_links: false,
        workspace: "T0A",
        thread_ts: null,
      })
      expect(outbox.messages[0]?.edited).toBeTruthy()
      expect(outbox.messages[1]).toMatchObject({
        text: "thread reply",
        thread_ts: posted.ts,
        unfurl_links: false,
        workspace: "T0A",
      })
      const threaded = (await (
        await fetch(
          `${server.url}/__admin/outbox?thread_ts=${encodeURIComponent(posted.ts as string)}`,
          { headers: { "x-emulates-namespace": "a" } },
        )
      ).json()) as { messages: { ts: string }[] }
      expect(threaded.messages.map((message) => message.ts)).toEqual([reply.ts as string])

      await fetch(`${server.url}/__admin/socket/disconnect`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-emulates-namespace": "a" },
        body: JSON.stringify({ reason: "warning" }),
      })
      await delay(100)
      const openB = (await connections(server.url, "b")).filter((row) => row.state === "open")
      expect(openB).toHaveLength(1)
      const still = await workspaceB.app.client.chat.postMessage({
        channel: "C0OTHER",
        text: "b still up",
      })
      expect(still.ok).toBe(true)
      const outboxB = (await (
        await fetch(`${server.url}/__admin/outbox`, {
          headers: { "x-emulates-namespace": "b" },
        })
      ).json()) as { messages: { text: string | null; workspace: string }[] }
      expect(outboxB.messages.map((message) => message.text)).toEqual(["b still up"])
      expect(outboxB.messages[0]?.workspace).toBe("T0B")
    } finally {
      await workspaceA.app.stop()
      await workspaceB.app.stop()
      await server.close()
    }
  }, 20_000)

  test("chat.postMessage and chat.update keep blocks, threads, and logical errors", async () => {
    const runtime = createRuntime()
    const api = async (path: string, body: unknown, token: string | null = BOT) => {
      const headers: Record<string, string> = {
        "content-type": "application/json; charset=utf-8",
      }
      if (token) headers.authorization = `Bearer ${token}`
      const response = await runtime.fetch(
        new Request(`${HOST}/api/${path}`, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
        }),
      )
      return { status: response.status, headers: response.headers, body: await response.json() }
    }
    const blocks = [{ type: "section", text: { type: "mrkdwn", text: "page on-call" } }]
    const posted = await api("chat.postMessage", {
      channel: "C0PAGE",
      text: "page on-call",
      blocks,
      unfurl_links: false,
    })
    expect(posted.status).toBe(200)
    expect(posted.body).toMatchObject({ ok: true, channel: "C0PAGE" })
    const parent = posted.body as { ts: string }
    const reply = await api("chat.postMessage", {
      channel: "C0PAGE",
      text: "details",
      thread_ts: parent.ts,
      unfurl_links: false,
    })
    expect((reply.body as { ts: string }).ts).not.toBe(parent.ts)
    const updated = await api("chat.update", { channel: "C0PAGE", ts: parent.ts, text: "paged" })
    expect(updated.body).toMatchObject({ ok: true, ts: parent.ts, text: "paged" })
    const outbox = (await (
      await runtime.fetch(new Request(`${HOST}/__admin/outbox?channel=C0PAGE`))
    ).json()) as {
      messages: {
        ts: string
        text: string | null
        blocks: unknown[] | null
        thread_ts: string | null
        unfurl_links: boolean | null
        workspace: string
        edited: unknown
      }[]
    }
    expect(outbox.messages).toHaveLength(2)
    expect(outbox.messages[0]).toMatchObject({
      ts: parent.ts,
      text: "paged",
      blocks,
      unfurl_links: false,
      workspace: "T0MOCKBIRD",
      thread_ts: null,
    })
    expect(outbox.messages[0]?.edited).toBeTruthy()
    expect(outbox.messages[1]?.thread_ts).toBe(parent.ts)

    await runtime.fetch(
      new Request(`${HOST}/__admin/settings`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ strictChannels: true }),
      }),
    )
    await runtime.fetch(
      new Request(`${HOST}/__admin/channels`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: "C0ARCHIVED", name: "archived", is_archived: true }),
      }),
    )
    expect((await api("chat.postMessage", { channel: "C0MISSING", text: "x" })).body).toMatchObject(
      {
        ok: false,
        error: "channel_not_found",
      },
    )
    expect(
      (await api("chat.postMessage", { channel: "C0ARCHIVED", text: "x" })).body,
    ).toMatchObject({
      ok: false,
      error: "is_archived",
    })
    expect((await api("chat.postMessage", { channel: "C0PAGE" })).body).toMatchObject({
      ok: false,
      error: "no_text",
    })
    expect(
      (await api("chat.postMessage", { channel: "C0PAGE", blocks: [{ text: "no type" }] })).body,
    ).toMatchObject({ ok: false, error: "invalid_blocks" })
    expect(
      (await api("chat.postMessage", { channel: "C0PAGE", text: "x" }, null)).body,
    ).toMatchObject({ ok: false, error: "not_authed" })
    expect(
      (await api("chat.postMessage", { channel: "C0PAGE", text: "x" }, "nope")).body,
    ).toMatchObject({
      ok: false,
      error: "invalid_auth",
    })
    runtime.applyPreset("rate_limited", "default", { count: 1 })
    const limited = await api("chat.postMessage", { channel: "C0PAGE", text: "x" })
    expect(limited.status).toBe(429)
    expect(limited.body).toMatchObject({ ok: false, error: "ratelimited" })
    expect(limited.headers.get("retry-after")).toBe("1")
    runtime.applyPreset("5xx", "default", { count: 1 })
    const broken = await api("chat.postMessage", { channel: "C0PAGE", text: "x" })
    expect(broken.status).toBe(500)
    expect(broken.body).toMatchObject({ ok: false, error: "internal_error" })
    runtime.applyPreset("connections_open_invalid_auth", "default", { count: 1 })
    const denied = await open((request) => runtime.fetch(request), APP)
    expect(denied.body).toEqual({ ok: false, error: "invalid_auth" })
    runtime.applyPreset("connections_open_429", "default", { count: 1, params: { retryAfter: 3 } })
    const slow = await runtime.fetch(
      new Request(`${HOST}/api/apps.connections.open`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${APP}`,
          "content-type": "application/json; charset=utf-8",
        },
        body: "{}",
      }),
    )
    expect(slow.status).toBe(429)
    expect(slow.headers.get("retry-after")).toBe("3")
    runtime.applyPreset("connections_open_5xx", "default", { count: 1, params: { status: 503 } })
    const down = await runtime.fetch(
      new Request(`${HOST}/api/apps.connections.open`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${APP}`,
          "content-type": "application/json; charset=utf-8",
        },
        body: "{}",
      }),
    )
    expect(down.status).toBe(503)
    expect(await down.json()).toEqual({ ok: false, error: "service_unavailable" })
  })

  test("hello can be delayed, and a close-after-hello preset ends the socket", async () => {
    const server = await createServer()
    try {
      server.runtime.applyPreset("socket_hello_latency", "default", {
        count: 1,
        params: { latencyMs: 250 },
      })
      const delayed = await fetch(`${server.url}/api/apps.connections.open`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${APP}`,
          "content-type": "application/json; charset=utf-8",
        },
        body: "{}",
      })
      const delayedUrl = ((await delayed.json()) as { url: string }).url
      const started = Date.now()
      const { socket, data } = await firstMessage(delayedUrl)
      expect(Date.now() - started).toBeGreaterThanOrEqual(200)
      expect(JSON.parse(data).type).toBe("hello")
      socket.close()

      server.runtime.applyPreset("socket_close_after_hello", "default", { count: 1 })
      const closing = await fetch(`${server.url}/api/apps.connections.open`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${APP}`,
          "content-type": "application/json; charset=utf-8",
        },
        body: "{}",
      })
      const closingUrl = ((await closing.json()) as { url: string }).url
      const next = await firstMessage(closingUrl)
      expect(JSON.parse(next.data).type).toBe("hello")
      const code = await new Promise<number>((resolve) => {
        next.socket.onclose = (event) => resolve(event.code)
      })
      expect(code).toBe(1000)
    } finally {
      await server.close()
    }
  })

  test("App.stop closes sockets and does not schedule a reconnect", async () => {
    const server = await createServer()
    const app = new App({
      token: BOT,
      appToken: APP,
      socketMode: true,
      clientOptions: { slackApiUrl: `${server.url}/api/` },
      logLevel: LogLevel.ERROR,
    })
    try {
      await app.start()
      expect((await connections(server.url)).filter((row) => row.state === "open")).toHaveLength(1)
      const journalBefore = await (await fetch(`${server.url}/__admin/requests`)).json()
      const opensBefore = JSON.stringify(journalBefore).split("AppsConnectionsOpen").length - 1
      await app.stop()
      await delay(6_000)
      const rows = await connections(server.url)
      expect(rows.filter((row) => row.state === "open" || row.state === "closing")).toEqual([])
      const journalAfter = await (await fetch(`${server.url}/__admin/requests`)).json()
      const opensAfter = JSON.stringify(journalAfter).split("AppsConnectionsOpen").length - 1
      expect(opensAfter).toBe(opensBefore)
    } finally {
      await server.close()
    }
  }, 15_000)

  test("the journal records channel, ts, and namespace, never bodies or tokens", async () => {
    const server = await createServer()
    try {
      await fetch(`${server.url}/api/apps.connections.open`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${APP}`,
          "content-type": "application/json; charset=utf-8",
        },
        body: "{}",
      })
      await fetch(`${server.url}/api/chat.postMessage`, {
        method: "POST",
        headers: {
          authorization: `Bearer xoxb-journal-secret`,
          "content-type": "application/json; charset=utf-8",
        },
        body: JSON.stringify({
          channel: "C0PHI",
          text: "PHI Ada Lovelace potassium",
          blocks: [{ type: "section", text: { type: "mrkdwn", text: "LAB-PHI-991" } }],
        }),
      })
      const journal = await (await fetch(`${server.url}/__admin/requests`)).json()
      const serialized = JSON.stringify(journal)
      expect(serialized).not.toContain("Lovelace")
      expect(serialized).not.toContain("LAB-PHI-991")
      expect(serialized).not.toContain("xoxb-journal-secret")
      expect(serialized).not.toContain(APP)
      expect(serialized).toContain("ChatPostMessage")
      expect(serialized).toContain("AppsConnectionsOpen")
      expect(serialized).toContain("C0PHI")
      expect(serialized).toContain("default")
    } finally {
      await server.close()
    }
  })
})
