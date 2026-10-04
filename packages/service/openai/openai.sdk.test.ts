import { expect, test } from "bun:test"
import { createOpenAI } from "@ai-sdk/openai"
import { embed, generateText, jsonSchema, stepCountIs, streamText, tool } from "ai"
import OpenAI from "openai"
import { type ChatScript, DEFAULT_TOKEN } from "./src/index.js"
import { createServer } from "./src/server.js"

const scripts: ChatScript[] = [
  {
    kind: "chat",
    message: {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "call_sdk",
          type: "function",
          function: { name: "fixture_lookup", arguments: '{"value":7}' },
        },
      ],
    },
    usage: { prompt_tokens: 20, completion_tokens: 4, cached_tokens: 10 },
  },
  {
    kind: "chat",
    match: { lastRole: "tool" },
    message: { role: "assistant", content: "SDK final answer" },
    usage: { prompt_tokens: 24, completion_tokens: 5, cached_tokens: 12 },
  },
]
test("unmodified OpenAI 7.27.0 performs the reported tool loop and stored completion lifecycle", async () => {
  const server = await createServer({ scripts })
  try {
    const client = new OpenAI({ apiKey: DEFAULT_TOKEN, baseURL: `${server.url}/v1`, maxRetries: 0 })
    const first = await client.chat.completions.create({
      model: "fixture-chat",
      messages: [{ role: "user", content: "fixture request" }],
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
      prompt_cache_key: "fixture-cache",
      store: true,
    })
    const message = first.choices[0]?.message
    expect(message?.content).toBeNull()
    expect(first.usage?.prompt_tokens_details?.cached_tokens).toBe(10)
    const second = await client.chat.completions.create({
      model: "fixture-chat",
      messages: [
        { role: "user", content: "fixture request" },
        message ?? { role: "assistant", content: "" },
        { role: "tool", tool_call_id: "call_sdk", content: '{"fixture":7}' },
      ],
      store: true,
    })
    expect(second.choices[0]?.message.content).toBe("SDK final answer")
    expect((await client.chat.completions.retrieve(first.id)).id).toBe(first.id)
    const page = await client.chat.completions.list({ limit: 1, order: "asc" })
    expect(page.data[0]?.id).toBe(first.id)
    expect(page.hasNextPage()).toBe(true)
    const next = await page.getNextPage()
    expect(next.data[0]?.id).toBe(second.id)
    expect((await client.chat.completions.delete(first.id)).deleted).toBe(true)
    await expect(
      Promise.resolve(client.chat.completions.retrieve(first.id)),
    ).rejects.toBeInstanceOf(OpenAI.NotFoundError)
    await expect(
      Promise.resolve(
        client.chat.completions.create({
          model: "missing",
          messages: [{ role: "user", content: "fixture" }],
        }),
      ),
    ).rejects.toBeInstanceOf(OpenAI.NotFoundError)
  } finally {
    await server.close()
  }
})
test("unmodified @ai-sdk/openai 4.0.83 + ai 7.0.127 execute a function and continue to the final answer", async () => {
  const server = await createServer({ scripts })
  try {
    const provider = createOpenAI({ apiKey: DEFAULT_TOKEN, baseURL: `${server.url}/v1` })
    const calls: number[] = []
    const result = await generateText({
      model: provider.chat("fixture-chat"),
      prompt: "fixture request",
      tools: {
        fixture_lookup: tool({
          inputSchema: jsonSchema<{ value: number }>({
            type: "object",
            properties: { value: { type: "integer" } },
            required: ["value"],
            additionalProperties: false,
          }),
          execute: async ({ value }) => {
            calls.push(value)
            return { fixture: value }
          },
        }),
      },
      stopWhen: stepCountIs(3),
      maxRetries: 0,
    })
    expect(calls).toEqual([7])
    expect(result.text).toBe("SDK final answer")
    expect(result.steps).toHaveLength(2)
    expect(result.steps[0]?.usage.inputTokens).toBe(20)
    expect(result.steps[0]?.usage.inputTokenDetails.cacheReadTokens).toBe(10)
  } finally {
    await server.close()
  }
})
test("both official SDK and AI SDK reconstruct Chat streams and decode scripted embedding vectors", async () => {
  const server = await createServer({
    scripts: [
      {
        kind: "chat",
        message: { role: "assistant", content: "stream 🦉 fixture" },
        chunk_size: 1,
        usage: { prompt_tokens: 9, completion_tokens: 4, cached_tokens: 3 },
      },
      {
        kind: "chat",
        message: { role: "assistant", content: "AI stream fixture" },
        chunk_size: 2,
        usage: { prompt_tokens: 8, completion_tokens: 3, cached_tokens: 2 },
      },
      { kind: "embedding", vectors: [[0.25, -0.5, 1]], usage: { prompt_tokens: 5 } },
      { kind: "embedding", vectors: [[0.5, 0.25, -1]], usage: { prompt_tokens: 4 } },
    ],
  })
  try {
    const client = new OpenAI({ apiKey: DEFAULT_TOKEN, baseURL: `${server.url}/v1`, maxRetries: 0 })
    const stream = await client.chat.completions.create({
      model: "fixture-chat",
      messages: [{ role: "user", content: "fixture" }],
      stream: true,
      stream_options: { include_usage: true },
    })
    let text = ""
    let total = 0
    for await (const frame of stream) {
      text += frame.choices[0]?.delta.content ?? ""
      if (frame.usage) total = frame.usage.total_tokens
    }
    expect(text).toBe("stream 🦉 fixture")
    expect(total).toBe(13)
    const provider = createOpenAI({ apiKey: DEFAULT_TOKEN, baseURL: `${server.url}/v1` })
    const result = streamText({
      model: provider.chat("fixture-chat"),
      prompt: "fixture",
      maxRetries: 0,
    })
    let content = ""
    for await (const chunk of result.textStream) content += chunk
    expect(content).toBe("AI stream fixture")
    expect(await result.finishReason).toBe("stop")
    expect((await result.usage).inputTokenDetails.cacheReadTokens).toBe(2)
    expect(
      (await client.embeddings.create({ model: "fixture-embedding", input: "fixture" })).data[0]
        ?.embedding,
    ).toEqual([0.25, -0.5, 1])
    expect(
      (
        await embed({
          model: provider.embeddingModel("fixture-embedding"),
          value: "fixture",
          maxRetries: 0,
        })
      ).embedding,
    ).toEqual([0.5, 0.25, -1])
  } finally {
    await server.close()
  }
})
test("official SDK models, multipart files and staged Uploads run over real Node HTTP", async () => {
  const server = await createServer()
  try {
    const client = new OpenAI({ apiKey: DEFAULT_TOKEN, baseURL: `${server.url}/v1`, maxRetries: 0 })
    expect((await client.models.list()).data.map((m) => m.id)).toEqual([
      "fixture-chat",
      "fixture-embedding",
    ])
    expect((await client.models.retrieve("fixture-chat")).object).toBe("model")
    const file = await client.files.create({
      file: new File([new Uint8Array([0, 255, 65])], "fixture.bin"),
      purpose: "user_data",
    })
    expect(file.bytes).toBe(3)
    expect(new Uint8Array(await (await client.files.content(file.id)).arrayBuffer())).toEqual(
      new Uint8Array([0, 255, 65]),
    )
    expect((await client.files.retrieve(file.id)).filename).toBe("fixture.bin")
    expect((await client.files.list({ purpose: "user_data", limit: 1 })).data[0]?.id).toBe(file.id)
    const upload = await client.uploads.create({
      filename: "parts.txt",
      purpose: "batch",
      mime_type: "text/plain",
      bytes: 4,
    })
    const p1 = await client.uploads.parts.create(upload.id, { data: new File(["ab"], "a.txt") })
    const p2 = await client.uploads.parts.create(upload.id, { data: new File(["cd"], "b.txt") })
    const completed = await client.uploads.complete(upload.id, {
      part_ids: [p1.id, p2.id],
      md5: "e2fc714c4727ee9395f324cd2e7f331f",
    })
    expect(completed.file?.bytes).toBe(4)
    expect(await (await client.files.content(completed.file?.id ?? "")).text()).toBe("abcd")
    const cancelled = await client.uploads.create({
      filename: "cancel.txt",
      purpose: "batch",
      mime_type: "text/plain",
      bytes: 0,
    })
    expect((await client.uploads.cancel(cancelled.id)).status).toBe("cancelled")
    expect((await client.files.delete(file.id)).deleted).toBe(true)
  } finally {
    await server.close()
  }
})

test("official SDK retries one 429/5xx fault and preserves the queued response", async () => {
  for (const preset of ["rate_limited", "server_error", "service_unavailable"]) {
    const server = await createServer({
      scripts: [{ kind: "chat", message: { role: "assistant", content: "retry fixture" } }],
    })
    try {
      await server.runtime.fetch(
        new Request(`${server.url}/__admin/faults/presets/${preset}`, {
          method: "POST",
          headers: {
            "x-mockingbird-admin-key": "fixture-openai-admin",
            "content-type": "application/json",
          },
          body: "{}",
        }),
      )
      const client = new OpenAI({
        apiKey: DEFAULT_TOKEN,
        baseURL: `${server.url}/v1`,
        maxRetries: 1,
      })
      const reply = await client.chat.completions.create({
        model: "fixture-chat",
        messages: [{ role: "user", content: "fixture" }],
      })
      expect(reply.choices[0]?.message.content).toBe("retry fixture")
      expect(
        server.runtime.journal.list().filter((r) => r.operationId === "CreateChatCompletion"),
      ).toHaveLength(2)
      expect(server.runtime.instance("default").state.chats.list()).toHaveLength(1)
    } finally {
      await server.close()
    }
  }
  const server = await createServer()
  try {
    const client = new OpenAI({
      apiKey: "fixture-invalid-token",
      baseURL: `${server.url}/v1`,
      maxRetries: 2,
    })
    await expect(Promise.resolve(client.models.list())).rejects.toBeInstanceOf(
      OpenAI.AuthenticationError,
    )
    expect(
      server.runtime.journal.list().filter((r) => r.operationId === "ListModels"),
    ).toHaveLength(1)
  } finally {
    await server.close()
  }
})
