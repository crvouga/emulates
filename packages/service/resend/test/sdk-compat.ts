/**
 * One fresh process so `resend` reads `RESEND_BASE_URL` at import and never calls api.resend.com.
 * Parent: `bun test/sdk-compat.ts` with MOCK_URL, SDK=2|4, MODE=base|faults, NAMESPACE.
 */
const base = process.env.MOCK_URL
const sdk = process.env.SDK
const mode = process.env.MODE
const namespace = process.env.NAMESPACE
if (!base || (sdk !== "2" && sdk !== "4") || (mode !== "base" && mode !== "faults") || !namespace) {
  throw new Error("MOCK_URL, SDK=2|4, MODE=base|faults, and NAMESPACE are required")
}
process.env.RESEND_BASE_URL = base

const hosts: string[] = []
let unhandled = false
process.on("unhandledRejection", () => {
  unhandled = true
})

const realFetch = globalThis.fetch
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
  const host = new URL(raw).host
  hosts.push(host)
  if (host === "api.resend.com") throw new Error("leaked to api.resend.com")
  return realFetch(input, init)
}) as typeof fetch

type SendPayload = {
  from: string
  to: string
  subject: string
  text: string
  html: string
}
type SendError = { name?: string; message?: string; statusCode?: number } | null
type Client = {
  emails: {
    send: (
      payload: SendPayload,
      options?: { idempotencyKey: string },
    ) => Promise<{ data: { id?: string } | null; error: SendError }>
  }
}

const imported = (await import(sdk === "2" ? "resend-v2" : "resend")) as {
  Resend: new (key: string) => Client
}
const client = new imported.Resend(`re_${namespace}`)

const mapped = await fetch(`${base}/__admin/credentials`, {
  method: "PUT",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ credentials: { [`re_${namespace}`]: namespace } }),
})
if (!mapped.ok) throw new Error(`credential mapping failed: ${mapped.status}`)

const payload: SendPayload = {
  from: "Acme <no-reply@acme.example>",
  to: "jane@example.com",
  subject: "Hello",
  text: "Hello",
  html: "<p>Hello</p>",
}

const send = async (idempotencyKey?: string) => {
  try {
    const result = await client.emails.send(
      payload,
      sdk === "4" && idempotencyKey ? { idempotencyKey } : undefined,
    )
    return { settled: "result" as const, data: result.data, error: result.error }
  } catch (error) {
    return { settled: "rejected" as const, name: error instanceof Error ? error.name : "unknown" }
  }
}

const admin = async (path: string, init?: { method?: string; body?: unknown }) => {
  const response = await fetch(`${base}/__admin${path}`, {
    method: init?.body === undefined ? "GET" : (init.method ?? "POST"),
    headers: {
      "content-type": "application/json",
      "x-emulates-namespace": namespace,
    },
    ...(init?.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  })
  if (!response.ok) throw new Error(`${path} failed: ${response.status} ${await response.text()}`)
  return response.json()
}

const preset = (name: string) => admin("/faults", { body: { preset: name, count: 1 } })

const report: Record<string, unknown> = {
  sdk,
  mode,
  hosts,
  leaked: hosts.includes("api.resend.com"),
  unhandled,
}

if (mode === "base") {
  report.send = await send()
} else {
  report.validation = await (async () => {
    await preset("send_422")
    return send()
  })()
  report.rateLimit = await (async () => {
    await preset("send_429")
    return send()
  })()
  report.internal = await (async () => {
    await preset("send_500")
    return send()
  })()
  report.nonJson = await (async () => {
    await preset("non_json_500")
    return send()
  })()
  report.networkDrop = await (async () => {
    await preset("network_drop")
    return send()
  })()
  const before = (await admin("/outbox")) as { messages: { id: string }[] }
  report.outboxBefore = before.messages.length
  await preset("accepted_then_network_drop")
  report.acceptedDrop = await send("order-42")
  report.retry = await send("order-42")
  const after = (await admin("/outbox")) as { messages: { id: string }[] }
  report.outboxAfter = after.messages.length
  report.outboxIds = after.messages.map((message) => message.id)
  report.outcomes = await admin("/outcomes")
}

report.leaked = hosts.includes("api.resend.com")
report.unhandled = unhandled
console.log(JSON.stringify(report))
