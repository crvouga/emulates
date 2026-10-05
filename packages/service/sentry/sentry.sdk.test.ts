import { expect, test } from "bun:test"
import { defaultStackParser, makeNodeTransport, NodeClient, Scope } from "@sentry/node"
import { DEFAULT_PROJECT } from "./src/index.js"
import { createServer } from "./src/server.js"
import { eventId, SentryAssertions } from "./test/consumer.js"

test("official @sentry/node 11.4.0 captures an exception and transaction, flushes, and honors category rate limits", async () => {
  const server = await createServer()
  const client = new NodeClient({
    dsn: `${server.url.replace("://", `://${DEFAULT_PROJECT.publicKey}@`)}/1`,
    transport: makeNodeTransport,
    stackParser: defaultStackParser,
    integrations: [],
    tracesSampleRate: 1,
    release: "fixture-sdk-release",
    environment: "test",
    sendClientReports: false,
  })
  const assertions = new SentryAssertions((r) => fetch(r), server.url)
  try {
    const scope = new Scope()
    scope.setTag("suite", "sdk")
    scope.setFingerprint(["sdk-fixture-group"])
    scope.setContext("trace", { trace_id: eventId(200), span_id: "0000000000000200" })
    client.captureException(new Error("fixture SDK failure"), { event_id: eventId(100) }, scope)
    client.captureEvent({
      event_id: eventId(101),
      type: "transaction",
      transaction: "fixture SDK transaction",
      start_timestamp: 1_700_000_000,
      timestamp: 1_700_000_001,
      contexts: { trace: { trace_id: eventId(201), span_id: "0000000000000201", op: "test" } },
    })
    expect(await client.flush(2000)).toBe(true)
    const captured = await (
      await assertions.admin("GET", "/events?release=fixture-sdk-release")
    ).json()
    expect(captured.events).toHaveLength(2)
    const exception = captured.events.find((e: { type: string }) => e.type === "error")
    expect(exception.data.exception.values[0].value).toBe("fixture SDK failure")
    expect(exception.data.tags.suite).toBe("sdk")
    expect((await (await assertions.issues()).json())[0].count).toBe("1")
    expect(
      (
        await (
          await assertions.admin("POST", "/flush", { eventIds: [eventId(100), eventId(101)] })
        ).json()
      ).flushed,
    ).toBe(true)
    await assertions.admin("POST", "/faults", { preset: "rate_limited", count: 1 })
    client.captureException(new Error("fixture rate-limit trigger"), { event_id: eventId(102) })
    expect(await client.flush(2000)).toBe(true)
    const requestsBefore = server.runtime.journal
      .list()
      .filter((e) => e.operationId === "IngestEnvelope").length
    client.captureException(new Error("fixture SDK dropped error"), { event_id: eventId(103) })
    expect(await client.flush(2000)).toBe(true)
    expect(
      server.runtime.journal.list().filter((e) => e.operationId === "IngestEnvelope").length,
    ).toBe(requestsBefore)
    // Error-category quotas do not suppress transactions.
    client.captureEvent({
      event_id: eventId(104),
      type: "transaction",
      transaction: "fixture after quota",
      start_timestamp: 1_700_000_000,
      timestamp: 1_700_000_001,
      contexts: { trace: { trace_id: eventId(204), span_id: "0000000000000204", op: "test" } },
    })
    expect(await client.flush(2000)).toBe(true)
    expect(server.runtime.instance().state.events.count()).toBe(3)
    expect(server.runtime.instance().state.events.has(`1:${eventId(103)}`)).toBe(false)
  } finally {
    await client.close(2000)
    await server.close()
  }
})

test("official Next.js server SDK uses the same DSN transport and flush contract", async () => {
  // Next.js explicitly re-exports the Node SDK transport. Initialize without global integrations.
  const nextjs = await import("@sentry/nextjs")
  const server = await createServer()
  const client = nextjs.init({
    dsn: `${server.url.replace("://", `://${DEFAULT_PROJECT.publicKey}@`)}/1`,
    integrations: [],
    defaultIntegrations: false,
    sendClientReports: false,
    release: "fixture-nextjs-release",
  })
  try {
    expect(client).toBeDefined()
    client?.captureException(new Error("fixture Next.js capture"), { event_id: eventId(110) })
    expect(await client?.flush(2000)).toBe(true)
    expect(server.runtime.instance().state.events.get(`1:${eventId(110)}`)?.data.release).toBe(
      "fixture-nextjs-release",
    )
  } finally {
    await client?.close(2000)
    await server.close()
  }
})
