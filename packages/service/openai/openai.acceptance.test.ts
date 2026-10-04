import { expect, test } from "bun:test"
import { createClock } from "@crvouga/mockingbird-service"
import {
  type ChatScript,
  createRuntime,
  DEFAULT_TOKEN,
  fingerprint,
  OpenAIAPI,
} from "./src/index.js"
import { consumer, retryChat } from "./test/consumer.js"

const body = {
  model: "fixture-chat",
  messages: [{ role: "user", content: "synthetic-private-prompt" }],
  prompt_cache_key: "synthetic-private-cache",
}
const script: ChatScript = {
  kind: "chat",
  message: { role: "assistant", content: "synthetic-private-answer" },
  usage: { prompt_tokens: 12, completion_tokens: 3, cached_tokens: 8 },
}
const queue = async (c: ReturnType<typeof consumer>, s: unknown) =>
  expect((await c.admin("/scripts", s)).status).toBe(201)

test("reported nonstream tool loop matches FIFO predicates, string arguments, cached usage and final answer", async () => {
  const runtime = createRuntime()
  const c = consumer(runtime)
  await queue(c, { ...script, match: { model: "unused-model" } })
  await queue(c, {
    kind: "chat",
    match: { model: "fixture-chat", lastRole: "user" },
    message: {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "call_fixture",
          type: "function",
          function: { name: "fixture_lookup", arguments: '{"value":7}' },
        },
      ],
    },
    usage: { prompt_tokens: 20, completion_tokens: 4, cached_tokens: 10 },
  })
  await queue(c, {
    ...script,
    match: { lastRole: "tool", toolCallId: "call_fixture", contentIncludes: "fixture-result" },
  })
  const first = await (
    await c.chat({
      ...body,
      tools: [
        {
          type: "function",
          function: {
            name: "fixture_lookup",
            parameters: { type: "object", properties: { value: { type: "integer" } } },
          },
        },
      ],
      tool_choice: "auto",
      max_tokens: 64,
    })
  ).json()
  expect(first.choices[0].message.content).toBeNull()
  expect(first.choices[0].finish_reason).toBe("tool_calls")
  expect(first.choices[0].message.tool_calls[0].function.arguments).toBe('{"value":7}')
  expect(first.usage).toEqual({
    prompt_tokens: 20,
    completion_tokens: 4,
    total_tokens: 24,
    prompt_tokens_details: { cached_tokens: 10 },
  })
  const followup = {
    ...body,
    messages: [
      ...body.messages,
      first.choices[0].message,
      { role: "tool", tool_call_id: "call_fixture", content: "fixture-result" },
    ],
  }
  const second = await (await c.chat(followup)).json()
  expect(second.choices[0].message.content).toBe(script.message.content)
  expect(second.choices[0].finish_reason).toBe("stop")
  expect(second.id).not.toBe(first.id)
  const meta = await (await c.admin("/request-metadata")).json()
  expect(meta.requests[1].roles).toEqual(["user", "assistant", "tool"])
  expect(
    (
      await (
        await c.admin("/request-assertions", {
          fingerprints: [
            fingerprint({
              ...body,
              tools: [
                {
                  type: "function",
                  function: {
                    name: "fixture_lookup",
                    parameters: { type: "object", properties: { value: { type: "integer" } } },
                  },
                },
              ],
              tool_choice: "auto",
              max_tokens: 64,
            }),
            fingerprint(followup),
          ],
        })
      ).json()
    ).matches,
  ).toBe(true)
  expect(
    (await (await c.admin("/scripts")).json()).scripts.map(
      (s: { consumed: boolean }) => s.consumed,
    ),
  ).toEqual([false, true, true])
})

test("vendor authentication, model scope and request errors have correct envelopes and request IDs", async () => {
  const runtime = createRuntime({ tokens: [{ token: DEFAULT_TOKEN, models: ["fixture-chat"] }] })
  const c = consumer(runtime)
  for (const [request, status, code] of [
    [
      () => c.request("/v1/models", { headers: { authorization: "Bearer constructor" } }),
      401,
      "invalid_api_key",
    ],
    [() => c.chat({ ...body, model: "missing" }), 403, "permission_denied"],
    [
      () =>
        c.chat({
          ...body,
          messages: [{ role: "tool", content: "unmatched", tool_call_id: "missing" }],
        }),
      400,
      null,
    ],
  ] as const) {
    const r = await request()
    expect(r.status).toBe(status)
    expect(r.headers.get("x-request-id")).toMatch(/^req_/)
    expect((await r.json()).error.code).toBe(code)
  }
  const ordinary = consumer(createRuntime())
  expect((await ordinary.chat({ ...body, model: "missing" })).status).toBe(404)
  expect((await ordinary.chat({ ...body, max_tokens: 0 })).status).toBe(400)
  expect((await ordinary.chat({ ...body, messages: [] })).status).toBe(400)
})

test("retryable faults leave scripts queued and the faithful consumer retries exactly once", async () => {
  for (const preset of ["rate_limited", "server_error", "service_unavailable", "network_reset"]) {
    const runtime = createRuntime({ scripts: [script] })
    const c = consumer(runtime)
    expect((await c.admin(`/faults/presets/${preset}`, {})).status).toBe(201)
    const r = await retryChat(c, body)
    expect(r.status).toBe(200)
    expect((await r.json()).choices[0].message.content).toBe(script.message.content)
    const requests = runtime.journal.list({ namespace: "default" })
    expect(requests.filter((r) => r.operationId === "CreateChatCompletion")).toHaveLength(2)
    expect(runtime.instance("default").state.chats.list()).toHaveLength(1)
  }
  for (const status of [400, 401, 403, 404, 409, 422]) {
    const runtime = createRuntime({ scripts: [script] })
    const c = consumer(runtime)
    await c.admin("/faults", {
      status,
      count: 1,
      body: {
        error: {
          message: "Fixture rejection",
          type: "invalid_request_error",
          param: null,
          code: null,
        },
      },
    })
    expect((await retryChat(c, body)).status).toBe(status)
    expect(
      runtime.journal
        .list({ namespace: "default" })
        .filter((r) => r.operationId === "CreateChatCompletion"),
    ).toHaveLength(1)
    expect(runtime.instance("default").state.scripts.list()[0]?.value.consumed).toBe(false)
  }
})

test("strict normal scripts reject malformed tools atomically; raw faults and refusal are explicit", async () => {
  const runtime = createRuntime({ scripts: [script] })
  const c = consumer(runtime)
  for (const s of [
    { ...script, unknown: true },
    { kind: "chat", message: { role: "assistant", content: null } },
    {
      kind: "chat",
      message: {
        role: "assistant",
        content: null,
        tool_calls: [{ type: "function", function: { name: "fixture", arguments: { value: 1 } } }],
      },
    },
    { ...script, usage: { prompt_tokens: 1, cached_tokens: 2 } },
  ])
    expect((await c.admin("/scripts", s)).status).toBe(400)
  expect(runtime.instance("default").state.scripts.list()).toHaveLength(1)
  await c.admin("/raw-faults", { body: '{"unexpected":true}', model: "fixture-chat" })
  expect(await (await c.chat(body)).json()).toEqual({ unexpected: true })
  expect(runtime.instance("default").state.scripts.list()[0]?.value.consumed).toBe(false)
  await c.admin("/faults/presets/invalid_json", {})
  await expect((await c.chat(body)).json()).rejects.toThrow()
  await c.admin("/faults/presets/malformed_stream", {})
  expect(await (await c.chat({ ...body, stream: true })).text()).toContain('"choices":"malformed"')
  await c.admin("/faults/presets/content_refusal", {})
  const refusal = await (await c.chat(body)).json()
  expect(refusal.choices[0].finish_reason).toBe("content_filter")
  expect(refusal.choices[0].message.refusal).toBe("Fixture content refusal")
})

test("Chat SSE reconstructs indexed tool argument strings, finish reason, usage and DONE", async () => {
  const api = new OpenAIAPI({
    scripts: [
      {
        kind: "chat",
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_stream",
              type: "function",
              function: { name: "fixture", arguments: '{"emoji":"🦉"}' },
            },
          ],
        },
        chunk_size: 1,
        usage: { prompt_tokens: 9, completion_tokens: 4, cached_tokens: 2 },
      },
    ],
  })
  const r = await consumer(api).chat({
    ...body,
    stream: true,
    stream_options: { include_usage: true },
  })
  expect(r.headers.get("content-type")).toBe("text/event-stream")
  const text = await r.text()
  expect(text.endsWith("data: [DONE]\n\n")).toBe(true)
  const frames = text
    .split("\n\n")
    .filter((v) => v && v !== "data: [DONE]")
    .map((v) => JSON.parse(v.slice(6)))
  const args = frames
    .flatMap((f) => f.choices)
    .flatMap((c) => c.delta.tool_calls ?? [])
    .map((c) => c.function.arguments)
    .join("")
  expect(args).toBe('{"emoji":"🦉"}')
  expect(frames.at(-2).choices[0].finish_reason).toBe("tool_calls")
  expect(frames.at(-1).choices).toEqual([])
  expect(frames.at(-1).usage.total_tokens).toBe(13)
  expect(api.state.streams.list()[0]?.value.status).toBe("closed")
})

test("abort before dispatch and during stream consumption closes work without dangling writes", async () => {
  const runtime = createRuntime({ scripts: [{ ...script, stream_delay_ms: 5, chunk_size: 1 }] })
  const c = consumer(runtime)
  await c.admin("/faults/presets/slow_response", {})
  const early = new AbortController()
  const pending = c.chat(body, early.signal)
  early.abort()
  await expect(pending).rejects.toThrow()
  expect(runtime.instance("default").state.scripts.list()[0]?.value.consumed).toBe(false)
  const controller = new AbortController()
  const response = await c.chat({ ...body, stream: true }, controller.signal)
  const reader = response.body?.getReader()
  expect(reader).toBeDefined()
  await reader?.read()
  controller.abort()
  await expect(reader?.read()).rejects.toThrow()
  expect(runtime.instance("default").state.streams.list()[0]?.value.status).toBe("aborted")
  const stopped = runtime.instance("default").state.streams.list()[0]?.value.chunks
  await new Promise((r) => setTimeout(r, 15))
  expect(runtime.instance("default").state.streams.list()[0]?.value.chunks).toBe(stopped)
})

test("namespaces, reset, history branches and metadata retain no plaintext prompts, replies, file bytes or keys", async () => {
  const logs: unknown[] = []
  const runtime = createRuntime({ scripts: [script], onLog: (entry) => logs.push(entry) })
  const a = consumer(runtime, "a")
  const b = consumer(runtime, "b")
  const response = await a.chat({ ...body, store: true })
  const id = (await response.json()).id
  const checkpoint = response.headers.get("x-mockingbird-checkpoint")
  expect(checkpoint).toBeTruthy()
  expect((await b.request(`/v1/chat/completions/${id}`)).status).toBe(404)
  const branch = await a.request(`/v1/chat/completions/${id}`, {
    headers: { "x-mockingbird-branch": "fixture-branch", "x-mockingbird-at": checkpoint ?? "" },
  })
  expect(branch.status).toBe(200)
  expect((await branch.json()).choices[0].message.content).toBe(script.message.content)
  const inspect = JSON.stringify({
    state: await (await a.admin("/state")).json(),
    journal: runtime.journal.list(),
    logs,
  })
  for (const value of [
    body.messages[0]?.content,
    body.prompt_cache_key,
    script.message.content,
    DEFAULT_TOKEN,
  ])
    expect(inspect).not.toContain(value as string)
  expect((await a.admin("/reset", {})).status).toBe(200)
  expect((await (await a.admin("/scripts")).json()).scripts[0].consumed).toBe(false)
  const custom = consumer(createRuntime({ adminPrefix: "/control" }))
  expect((await custom.request("/control/health")).status).toBe(200)
  expect((await custom.request("/__admin/health")).status).toBe(404)
})

test("file upload preserves exact bytes and staged uploads complete atomically in caller part order", async () => {
  const clock = createClock(() => 1700000000000)
  const runtime = createRuntime({ clock })
  const c = consumer(runtime)
  const form = new FormData()
  form.set("purpose", "user_data")
  form.set("file", new Blob([new Uint8Array([0, 255, 65])]), "fixture.bin")
  const file = await (await c.request("/v1/files", { method: "POST", body: form })).json()
  expect(file.bytes).toBe(3)
  expect(
    new Uint8Array(await (await c.request(`/v1/files/${file.id}/content`)).arrayBuffer()),
  ).toEqual(new Uint8Array([0, 255, 65]))
  const upload = await (
    await c.json("/v1/uploads", {
      filename: "staged.txt",
      purpose: "batch",
      mime_type: "text/plain",
      bytes: 4,
    })
  ).json()
  const part = async (text: string) => {
    const f = new FormData()
    f.set("data", new Blob([text]))
    return (
      await (await c.request(`/v1/uploads/${upload.id}/parts`, { method: "POST", body: f })).json()
    ).id
  }
  const first = await part("ab"),
    second = await part("cd")
  expect((await c.json(`/v1/uploads/${upload.id}/complete`, { part_ids: [first] })).status).toBe(
    400,
  )
  expect(
    (await c.json(`/v1/uploads/${upload.id}/complete`, { part_ids: [first, second], md5: "bad" }))
      .status,
  ).toBe(400)
  expect(runtime.instance("default").state.files.list()).toHaveLength(1)
  const completed = await (
    await c.json(`/v1/uploads/${upload.id}/complete`, { part_ids: [second, first] })
  ).json()
  expect(completed.status).toBe("completed")
  expect(completed.file.bytes).toBe(4)
  expect(await (await c.request(`/v1/files/${completed.file.id}/content`)).text()).toBe("cdab")
  expect(await part("later")).toBeUndefined()
  expect((await c.request(`/v1/files?limit=1&order=asc`)).status).toBe(200)
  expect((await (await c.request(`/v1/files?limit=1&order=asc`)).json()).has_more).toBe(true)
  expect((await c.request(`/v1/files/${file.id}`, { method: "DELETE" })).status).toBe(200)
  expect((await c.request(`/v1/files/${file.id}`)).status).toBe(404)
  const expired = await (
    await c.json("/v1/uploads", {
      filename: "expired.txt",
      purpose: "batch",
      mime_type: "text/plain",
      bytes: 0,
    })
  ).json()
  clock.advance(3600000)
  expect((await c.json(`/v1/uploads/${expired.id}/complete`, { part_ids: [] })).status).toBe(400)
  clock.advance(2592000000)
  expect((await c.request(`/v1/files/${completed.file.id}`)).status).toBe(404)
})

test("repeated cache keys create distinct completions; cursor pages reach each stored chat and file once", async () => {
  const runtime = createRuntime({
    scripts: [script, script, script],
    files: [
      { id: "file_one", filename: "one.txt", purpose: "user_data", bytes: "one" },
      { id: "file_two", filename: "two.txt", purpose: "user_data", bytes: "two" },
      { id: "file_three", filename: "three.txt", purpose: "user_data", bytes: "three" },
    ],
  })
  const c = consumer(runtime)
  const ids: string[] = []
  for (let i = 0; i < 3; i++) ids.push((await (await c.chat({ ...body, store: true })).json()).id)
  expect(new Set(ids).size).toBe(3)
  for (const [path, expected] of [
    ["/v1/chat/completions", ids],
    ["/v1/files", ["file_one", "file_two", "file_three"]],
  ] as const) {
    const found: string[] = []
    let cursor = ""
    for (let i = 0; i < 4; i++) {
      const page = await (
        await c.request(`${path}?limit=1&order=asc${cursor ? `&after=${cursor}` : ""}`)
      ).json()
      found.push(...page.data.map((v: { id: string }) => v.id))
      if (!page.has_more) break
      cursor = page.last_id
    }
    expect(found).toEqual([...expected])
  }
})

test("concurrent namespace writes, path and token carriers reset to constructor files and scripts", async () => {
  const runtime = createRuntime({
    scripts: [script],
    files: [
      {
        id: "file_fixture",
        filename: "fixture.txt",
        purpose: "user_data",
        bytes: "constructor bytes",
      },
    ],
  })
  const a = consumer(runtime, "parallel-a"),
    b = consumer(runtime, "parallel-b")
  const [one, two] = await Promise.all([
    a.chat({ ...body, store: true }),
    b.chat({ ...body, store: true }),
  ])
  const id = (await one.json()).id
  expect((await two.json()).choices[0].message.content).toBe(script.message.content)
  expect(runtime.instance("parallel-a").state.requests.list()).toHaveLength(1)
  expect(runtime.instance("parallel-b").state.requests.list()).toHaveLength(1)
  await a.request(`/v1/files/file_fixture`, { method: "DELETE" })
  expect((await a.request("/v1/files/file_fixture")).status).toBe(404)
  expect((await b.request("/v1/files/file_fixture")).status).toBe(200)
  await a.admin("/reset", {})
  expect(await (await a.request("/v1/files/file_fixture/content")).text()).toBe("constructor bytes")
  expect((await a.request(`/v1/chat/completions/${id}`)).status).toBe(404)
  const base = consumer(runtime)
  expect((await base.request("/__admin/ns/parallel-a/v1/files/file_fixture")).status).toBe(200)
  expect(
    (
      await base.json(
        "/__admin/credentials",
        { credentials: [{ credential: DEFAULT_TOKEN, namespace: "parallel-b" }] },
        { method: "PUT", headers: { "x-mockingbird-admin-key": "fixture-openai-admin" } },
      )
    ).status,
  ).toBe(200)
  expect((await base.request("/v1/files/file_fixture")).headers.get("x-mockingbird")).toContain(
    "ns=parallel-b",
  )
})

test("finish reasons and exact accounting survive JSON and wrong-shaped embeddings do not consume scripts", async () => {
  for (const finish_reason of ["length", "content_filter"] as const) {
    const c = consumer(createRuntime({ scripts: [{ ...script, finish_reason }] }))
    const reply = await (await c.chat(body)).json()
    expect(reply.choices[0].finish_reason).toBe(finish_reason)
    expect(reply.usage.total_tokens).toBe(15)
  }
  const runtime = createRuntime({
    scripts: [{ kind: "embedding", vectors: [[1, 2, 3]], usage: { prompt_tokens: 7 } }],
  })
  const c = consumer(runtime)
  expect(
    (await c.json("/v1/embeddings", { model: "fixture-embedding", input: ["one", "two"] })).status,
  ).toBe(400)
  expect(runtime.instance("default").state.scripts.list()[0]?.value.consumed).toBe(false)
  const reply = await (
    await c.json("/v1/embeddings", { model: "fixture-embedding", input: "fixture", dimensions: 2 })
  ).json()
  expect(reply.data[0].embedding).toEqual([1, 2])
  expect(reply.usage).toEqual({ prompt_tokens: 7, total_tokens: 7 })
})

test(
  "abort during incomplete request parsing cancels the input and leaves no completion or consumed script",
  async () => {
    const runtime = createRuntime({ scripts: [script] })
    const controller = new AbortController()
    let cancelled = false
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode('{"model":"fixture-chat","messages":['))
      },
      cancel() {
        cancelled = true
      },
    })
    const pending = runtime.fetch(
      new Request("http://mock.local/v1/chat/completions", {
        method: "POST",
        headers: { authorization: `Bearer ${DEFAULT_TOKEN}`, "content-type": "application/json" },
        body: stream,
        signal: controller.signal,
      }),
    )
    await new Promise((r) => setTimeout(r, 5))
    controller.abort()
    await expect(pending).rejects.toThrow()
    expect(cancelled).toBe(true)
    expect(runtime.instance("default").state.chats.list()).toHaveLength(0)
    expect(runtime.instance("default").state.scripts.list()[0]?.value.consumed).toBe(false)
  },
  { timeout: 1000 },
)
