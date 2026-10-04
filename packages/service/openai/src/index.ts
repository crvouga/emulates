import type { FetchAPI } from "@crvouga/mockingbird-core"
import {
  type APIOptions,
  annotateResponse,
  bearerToken,
  bootSqlite,
  createService,
  defineOperations,
  faultEffect,
  type OperationContext,
  type Service,
} from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"
import { md5 } from "@noble/hashes/legacy.js"
import { document, type SupportedOperationId } from "./generated/openapi.js"
import {
  type AssistantMessage,
  type ChatRecord,
  type ChatScript,
  DEFAULT_MODELS,
  DEFAULT_TOKEN,
  type FileFixture,
  type FileRecord,
  fingerprint,
  hex,
  type ModelFixture,
  OpenAIState,
  object,
  type RequestMetadata,
  type Script,
  type ScriptMatch,
  type ScriptRecord,
  type UploadRecord,
  validateScript,
} from "./state.js"
import { createVaultKey, Vault } from "./vault.js"

export { document, supportedOperationIds } from "./generated/openapi.js"
export type {
  AssistantMessage,
  ChatScript,
  EmbeddingScript,
  FileFixture,
  ModelFixture,
  RequestMetadata,
  Script,
  ScriptMatch,
  ScriptUsage,
  ToolCall,
} from "./state.js"
export { DEFAULT_MODELS, DEFAULT_TOKEN, fingerprint, validateScript } from "./state.js"
export { createVaultKey } from "./vault.js"
export const OPENAI_NAMESPACE = "openai"
export const DEFAULT_ADMIN_KEY = "fixture-openai-admin"
export type OpenAIAPIOptions = APIOptions & {
  models?: readonly ModelFixture[]
  scripts?: readonly Script[]
  files?: readonly FileFixture[]
  tokens?: readonly { token: string; models?: readonly string[] }[]
  vaultKey?: Uint8Array
  publicNamespace?: string
  maxFileBytes?: number
}
export const vendorError = (
  status: number,
  message: string,
  type = "invalid_request_error",
  param: string | null = null,
  code: string | null = null,
): Response => Response.json({ error: { message, type, param, code } }, { status })
class Rejection extends Error {
  constructor(readonly response: Response) {
    super("OpenAI request rejected")
  }
}
function reject(
  status: number,
  message: string,
  param: string | null = null,
  code: string | null = null,
  type = "invalid_request_error",
): never {
  throw new Rejection(vendorError(status, message, type, param, code))
}
function bad(message: string, param: string | null = null): never {
  return reject(400, message, param)
}
function required(value: unknown, param: string): string {
  if (typeof value !== "string" || !value) bad(`Missing or invalid parameter: '${param}'.`, param)
  return value
}
function integer(value: unknown, param: string, min = 0): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min)
    bad(`Invalid value for '${param}'.`, param)
  return value
}
const purposes = ["assistants", "batch", "fine-tune", "vision", "user_data"]
const aborted = (request: Request): void => {
  if (request.signal.aborted)
    throw request.signal.reason ?? new DOMException("The operation was aborted.", "AbortError")
}
export class OpenAIAPI implements FetchAPI {
  readonly sqlite: SqliteClient
  readonly state: OpenAIState
  readonly app: Service["app"]
  private readonly service: Service
  private readonly now: () => number
  private readonly fixtures: {
    models: readonly ModelFixture[]
    scripts: readonly Script[]
    files: readonly FileFixture[]
  }
  private readonly tokens: readonly { token: string; models?: readonly string[] }[]
  private readonly maxFileBytes: number
  private readonly multipartBodies = new WeakMap<Request, FormData>()
  private readonly requestIds = new WeakMap<Request, string>()
  constructor(options: OpenAIAPIOptions = {}) {
    this.sqlite = options.sqlite ?? bootSqlite()
    this.now = options.now ?? Date.now
    this.tokens = structuredClone(options.tokens ?? [{ token: DEFAULT_TOKEN }])
    this.maxFileBytes = options.maxFileBytes ?? 20 * 1024 * 1024
    if (!Number.isSafeInteger(this.maxFileBytes) || this.maxFileBytes < 1)
      throw new Error("maxFileBytes must be a positive integer")
    this.fixtures = structuredClone({
      models: options.models ?? DEFAULT_MODELS,
      scripts: options.scripts ?? [],
      files: options.files ?? [],
    })
    this.state = new OpenAIState(
      this.sqlite,
      options.namespace ?? OPENAI_NAMESPACE,
      new Vault(options.vaultKey ?? createVaultKey()),
      options.publicNamespace,
    )
    this.ensureSeeded()
    const wrap =
      (fn: (c: OperationContext) => Response) =>
      (c: OperationContext): Response => {
        try {
          aborted(c.request)
          return fn(c)
        } catch (e) {
          if (e instanceof Rejection) return e.response
          throw e
        }
      }
    this.service = createService({
      document,
      sqlite: this.sqlite,
      namespace: options.namespace ?? OPENAI_NAMESPACE,
      now: this.now,
      handlers: defineOperations<SupportedOperationId>({
        CreateChatCompletion: wrap((c) => this.chat(c)),
        ListChatCompletions: wrap((c) => this.listChats(c)),
        GetChatCompletion: wrap((c) => this.getChat(c)),
        DeleteChatCompletion: wrap((c) => this.deleteChat(c)),
        CreateEmbeddings: wrap((c) => this.embed(c)),
        ListModels: wrap(() =>
          Response.json({
            object: "list",
            data: this.state.models.list({ order: "oldest" }).map((r) => this.modelWire(r.value)),
          }),
        ),
        GetModel: wrap((c) => this.getModel(c)),
        CreateFile: wrap((c) => this.createFile(c)),
        ListFiles: wrap((c) => this.listFiles(c)),
        GetFile: wrap((c) => this.getFile(c)),
        DeleteFile: wrap((c) => this.deleteFile(c)),
        DownloadFile: wrap((c) => this.downloadFile(c)),
        CreateUpload: wrap((c) => this.createUpload(c)),
        CreateUploadPart: wrap((c) => this.createPart(c)),
        CompleteUpload: wrap((c) => this.completeUpload(c)),
        CancelUpload: wrap((c) => this.cancelUpload(c)),
      }),
      before: (c) => {
        try {
          this.authenticate(c.request)
          return undefined
        } catch (e) {
          if (e instanceof Rejection) return e.response
          throw e
        }
      },
      notFound: () =>
        vendorError(
          404,
          "Invalid URL (unsupported route).",
          "invalid_request_error",
          null,
          "not_found",
        ),
      onError: (e) => {
        if (e instanceof Rejection) return e.response
        if (e instanceof DOMException && e.name === "AbortError") throw e
        return vendorError(400, "Invalid request body.")
      },
    })
    this.app = this.service.app
  }
  private id(request: Request): string {
    let id = this.requestIds.get(request)
    if (!id) {
      id = this.state.ids.next("req_", 24)
      this.requestIds.set(request, id)
    }
    return id
  }
  async fetch(request: Request): Promise<Response> {
    aborted(request)
    const requestId = this.id(request)
    try {
      this.authenticate(request)
    } catch (e) {
      if (e instanceof Rejection) {
        e.response.headers.set("x-request-id", requestId)
        return e.response
      }
      throw e
    }
    if (request.headers.get("content-type")?.toLowerCase().startsWith("multipart/form-data")) {
      try {
        const form = await request.clone().formData()
        this.multipartBodies.set(request, form)
        const part = form.get(new URL(request.url).pathname.endsWith("/parts") ? "data" : "file")
        if (part instanceof Blob) {
          if (part.size > this.maxFileBytes)
            return this.stamp(
              vendorError(
                413,
                "File exceeds the configured local size limit.",
                "invalid_request_error",
                "file",
                "file_too_large",
              ),
              requestId,
            )
          this.fileBodies.set(request, {
            filename: "name" in part ? String(part.name) : "blob",
            bytes: new Uint8Array(await part.arrayBuffer()),
          })
        }
      } catch {
        return this.stamp(vendorError(400, "Invalid multipart request."), requestId)
      }
    }
    aborted(request)
    const response = await this.service.fetch(request)
    aborted(request)
    return this.stamp(response, requestId)
  }
  private stamp(response: Response, id: string): Response {
    response.headers.set("x-request-id", id)
    return response
  }
  async reset(): Promise<void> {
    await this.service.reset()
    this.ensureSeeded()
  }
  ensureSeeded(): void {
    if (this.state.settings.has("current")) return
    const scripts = this.fixtures.scripts.map(validateScript)
    for (const m of this.fixtures.models) {
      if (
        !m.id ||
        !["chat", "embedding"].includes(m.kind) ||
        (m.dimensions !== undefined && (!Number.isSafeInteger(m.dimensions) || m.dimensions < 1))
      )
        throw new Error("Invalid model fixture")
    }
    this.sqlite.transaction(() => {
      for (const m of this.fixtures.models)
        this.state.models.insert(m.id, {
          ...m,
          created: m.created ?? Math.floor(this.now() / 1000),
          owned_by: m.owned_by ?? "mockingbird",
        })
      for (const s of scripts) this.queue(s)
      for (const f of this.fixtures.files) this.seedFile(f)
      this.state.settings.insert("current", { initialized: true })
    })
  }
  queue(input: unknown): { id: string; kind: Script["kind"] } {
    const script = validateScript(input)
    const id = this.state.ids.next("script_", 24)
    this.state.scripts.insert(id, {
      id,
      kind: script.kind,
      consumed: false,
      sealed: this.state.seal(script, "script", id),
    })
    return { id, kind: script.kind }
  }
  queueRaw(input: unknown): { id: string } {
    const b = object(input)
    if (
      Object.keys(b).some((k) => !["body", "status", "content_type", "model"].includes(k)) ||
      typeof b.body !== "string" ||
      (b.model !== undefined && typeof b.model !== "string")
    )
      throw new Error("Invalid raw fault")
    const status = b.status ?? 200
    const type = b.content_type ?? "application/json"
    if (
      typeof status !== "number" ||
      !Number.isInteger(status) ||
      status < 200 ||
      status > 599 ||
      [204, 205, 304].includes(status) ||
      !["application/json", "text/event-stream"].includes(String(type))
    )
      throw new Error("Invalid raw fault response")
    const id = this.state.ids.next("raw_", 24)
    this.state.rawFaults.insert(id, {
      id,
      ...(typeof b.model === "string" ? { model: b.model } : {}),
      status,
      content_type: type as "application/json" | "text/event-stream",
      sealed: this.state.seal(b.body, "raw", id),
    })
    return { id }
  }
  private authenticate(request: Request, model?: string): void {
    const token = bearerToken(request),
      key = this.tokens.find((t) => t.token === token)
    if (!key)
      reject(
        401,
        "Invalid authentication credentials.",
        null,
        "invalid_api_key",
        "authentication_error",
      )
    if (model && key.models && !key.models.includes(model))
      reject(
        403,
        "You do not have access to this model.",
        "model",
        "permission_denied",
        "permission_error",
      )
  }
  private body(c: OperationContext): Record<string, unknown> {
    if (
      c.body.kind !== "json" ||
      !c.body.value ||
      typeof c.body.value !== "object" ||
      Array.isArray(c.body.value)
    )
      bad("Expected a JSON object.")
    return object(c.body.value)
  }
  private model(c: OperationContext, id: string, kind?: ModelFixture["kind"]): ModelFixture {
    this.authenticate(c.request, id)
    const model = this.state.models.get(id)
    if (!model)
      reject(
        404,
        `The model '${id}' does not exist or you do not have access to it.`,
        "model",
        "model_not_found",
      )
    if (kind && model.kind !== kind) bad("This model does not support this endpoint.", "model")
    return model
  }
  private modelWire(m: ModelFixture): Record<string, unknown> {
    return { id: m.id, object: "model", created: m.created, owned_by: m.owned_by }
  }
  private getModel(c: OperationContext): Response {
    return Response.json(this.modelWire(this.model(c, c.params.model ?? "")))
  }
  private metadata(
    c: OperationContext,
    b: Record<string, unknown>,
    messages: Record<string, unknown>[],
  ): RequestMetadata {
    const id = this.id(c.request)
    const meta: RequestMetadata = {
      id,
      operationId: c.operation.operationId,
      model: typeof b.model === "string" ? b.model : null,
      message_count: messages.length,
      roles: messages.map((m) => String(m.role)),
      content_bytes: new TextEncoder().encode(
        JSON.stringify(messages.map((m) => m.content ?? null)),
      ).length,
      tool_count: Array.isArray(b.tools) ? b.tools.length : 0,
      fingerprint: fingerprint(b),
      cache_key_hash:
        typeof b.prompt_cache_key === "string" ? fingerprint(b.prompt_cache_key) : null,
      script_id: null,
      response_id: null,
      created_at: Math.floor(this.now() / 1000),
    }
    this.state.requests.insert(id, meta)
    return meta
  }
  private matches(
    match: ScriptMatch | undefined,
    b: Record<string, unknown>,
    messages: Record<string, unknown>[],
  ): boolean {
    if (!match) return true
    const last = messages[messages.length - 1]
    const content =
      typeof last?.content === "string"
        ? last.content
        : JSON.stringify(last?.content ?? b.input ?? "")
    return (
      (!match.model || match.model === b.model) &&
      (!match.lastRole || match.lastRole === last?.role) &&
      (!match.toolCallId || match.toolCallId === last?.tool_call_id) &&
      (!match.contentIncludes || content.includes(match.contentIncludes))
    )
  }
  private select(
    kind: Script["kind"],
    b: Record<string, unknown>,
    messages: Record<string, unknown>[],
  ): { record: ScriptRecord; script: Script } | undefined {
    for (const { value: r } of this.state.scripts.list({ order: "oldest" })) {
      if (r.kind !== kind || r.consumed) continue
      const s = this.state.open<Script>(r.sealed, "script", r.id)
      if (this.matches(s.match, b, messages)) return { record: r, script: s }
    }
    return undefined
  }
  private raw(c: OperationContext, b: Record<string, unknown>): Response | undefined {
    const fault = this.state.rawFaults
      .list({ order: "oldest" })
      .find(({ value: f }) => !f.model || f.model === b.model)?.value
    if (fault) {
      this.state.rawFaults.delete(fault.id)
      return new Response(this.state.open<string>(fault.sealed, "raw", fault.id), {
        status: fault.status,
        headers: { "content-type": fault.content_type },
      })
    }
    if (faultEffect(c.request, "invalid_json"))
      return new Response("{", { headers: { "content-type": "application/json" } })
    if (faultEffect(c.request, "malformed_stream"))
      return new Response('data: {"choices":"malformed"}\n\ndata: [DONE]\n\n', {
        headers: { "content-type": "text/event-stream" },
      })
    return undefined
  }
  private validateMessages(value: unknown): Record<string, unknown>[] {
    if (!Array.isArray(value) || !value.length)
      bad("'messages' must be a nonempty array.", "messages")
    const known = new Set<string>()
    return value.map((v, i) => {
      const m = object(v)
      if (
        !["system", "developer", "user", "assistant", "tool", "function"].includes(String(m.role))
      )
        bad("Invalid message role.", `messages[${i}].role`)
      if (
        m.content !== undefined &&
        m.content !== null &&
        typeof m.content !== "string" &&
        !Array.isArray(m.content)
      )
        bad("Invalid message content.", `messages[${i}].content`)
      if (m.role === "tool" && !known.has(required(m.tool_call_id, `messages[${i}].tool_call_id`)))
        bad("Tool result has no matching assistant call.", `messages[${i}].tool_call_id`)
      if (m.tool_calls !== undefined) {
        if (m.role !== "assistant" || !Array.isArray(m.tool_calls) || !m.tool_calls.length)
          bad("Invalid assistant tool calls.", `messages[${i}].tool_calls`)
        for (const t of m.tool_calls) {
          const call = object(t)
          const fn = object(call.function)
          if (
            call.type !== "function" ||
            typeof fn.name !== "string" ||
            typeof fn.arguments !== "string"
          )
            bad("Invalid function tool call.", `messages[${i}].tool_calls`)
          known.add(required(call.id, `messages[${i}].tool_calls.id`))
        }
      }
      if (
        (m.role === "user" || m.role === "system" || m.role === "developer" || m.role === "tool") &&
        m.content === undefined
      )
        bad("Message content is required.", `messages[${i}].content`)
      return m
    })
  }
  private chat(c: OperationContext): Response {
    const b = this.body(c)
    const model = required(b.model, "model")
    this.model(c, model, "chat")
    const messages = this.validateMessages(b.messages)
    if (b.stream !== undefined && b.stream !== null && typeof b.stream !== "boolean")
      bad("Invalid stream value.", "stream")
    if (b.store !== undefined && b.store !== null && typeof b.store !== "boolean")
      bad("Invalid store value.", "store")
    for (const field of ["max_tokens", "max_completion_tokens"])
      if (b[field] !== undefined && b[field] !== null) integer(b[field], field, 1)
    if (
      b.tools !== undefined &&
      (!Array.isArray(b.tools) ||
        b.tools.some((t) => {
          const tool = object(t)
          return tool.type !== "function" || typeof object(tool.function).name !== "string"
        }))
    )
      bad("Invalid tools.", "tools")
    const meta = this.metadata(c, b, messages)
    const raw = this.raw(c, b)
    if (raw) return raw
    const selected = this.select("chat", b, messages)
    let script: ChatScript =
      selected?.script.kind === "chat"
        ? selected.script
        : { kind: "chat", message: { role: "assistant", content: "Fixture response" } }
    if (faultEffect(c.request, "content_refusal"))
      script = {
        ...script,
        message: { role: "assistant", content: null, refusal: "Fixture content refusal" },
        finish_reason: "content_filter",
      }
    const id = this.state.ids.next("chatcmpl-", 24)
    const message: AssistantMessage = {
      ...script.message,
      ...(script.message.tool_calls
        ? {
            tool_calls: script.message.tool_calls.map((t) => ({
              ...t,
              id: t.id ?? this.state.ids.next("call_", 24),
            })),
          }
        : {}),
    }
    const prompt = script.usage?.prompt_tokens ?? Math.max(1, Math.ceil(meta.content_bytes / 4))
    const completion =
      script.usage?.completion_tokens ??
      Math.max(1, Math.ceil(new TextEncoder().encode(JSON.stringify(message)).length / 4))
    const usage = {
      prompt_tokens: prompt,
      completion_tokens: completion,
      total_tokens: prompt + completion,
      prompt_tokens_details: { cached_tokens: script.usage?.cached_tokens ?? 0 },
    }
    const result = {
      id,
      object: "chat.completion",
      created: Math.floor(this.now() / 1000),
      model,
      choices: [
        {
          index: 0,
          message,
          finish_reason: script.finish_reason ?? (message.tool_calls ? "tool_calls" : "stop"),
          logprobs: null,
        },
      ],
      usage,
      system_fingerprint: null,
      ...(b.metadata ? { metadata: b.metadata } : {}),
    }
    this.sqlite.transaction(() => {
      if (selected)
        this.state.scripts.update(selected.record.id, { ...selected.record, consumed: true })
      this.state.chats.insert(id, {
        id,
        model,
        created: result.created,
        stored: b.store === true,
        requestId: meta.id,
        sealed: this.state.seal(result, "chat", id),
      })
      this.state.requests.update(meta.id, {
        ...meta,
        script_id: selected?.record.id ?? null,
        response_id: id,
      })
    })
    if (b.stream === true)
      return annotateResponse(
        this.stream(c, result, script, object(b.stream_options).include_usage === true),
        { ids: { chat: id } },
      )
    return annotateResponse(Response.json(result), { ids: { chat: id } })
  }
  private stream(
    c: OperationContext,
    result: {
      id: string
      model: string
      created: number
      choices: { message: AssistantMessage; finish_reason: string }[]
      usage: unknown
    },
    script: ChatScript,
    includeUsage: boolean,
  ): Response {
    const choice = result.choices[0]
    if (!choice) throw new Error("Missing scripted choice")
    const frames: string[] = []
    const add = (delta: unknown, finish: string | null = null) =>
      frames.push(
        `data: ${JSON.stringify({ id: result.id, object: "chat.completion.chunk", created: result.created, model: result.model, choices: [{ index: 0, delta, finish_reason: finish, logprobs: null }], ...(includeUsage ? { usage: null } : {}) })}\n\n`,
      )
    add({ role: "assistant", content: "" })
    const chunks = (value: string): string[] => {
      const chars = Array.from(value)
      const size = script.chunk_size ?? 8
      const parts: string[] = []
      for (let i = 0; i < chars.length; i += size) parts.push(chars.slice(i, i + size).join(""))
      return parts
    }
    if (choice.message.content)
      for (const part of chunks(choice.message.content)) add({ content: part })
    if (choice.message.refusal)
      for (const part of chunks(choice.message.refusal)) add({ refusal: part })
    for (const [index, call] of (choice.message.tool_calls ?? []).entries()) {
      add({
        tool_calls: [
          {
            index,
            id: call.id,
            type: "function",
            function: { name: call.function.name, arguments: "" },
          },
        ],
      })
      for (const part of chunks(call.function.arguments))
        add({ tool_calls: [{ index, function: { arguments: part } }] })
    }
    add({}, choice.finish_reason)
    if (includeUsage)
      frames.push(
        `data: ${JSON.stringify({ id: result.id, object: "chat.completion.chunk", created: result.created, model: result.model, choices: [], usage: result.usage })}\n\n`,
      )
    frames.push("data: [DONE]\n\n")
    const id = this.id(c.request)
    this.state.streams.insert(id, { id, status: "open", chunks: 0 })
    const state = this.state
    let next = 0
    let done = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let pending: (() => void) | undefined
    const finish = (status: "closed" | "aborted") => {
      if (done) return
      done = true
      clearTimeout(timer)
      pending?.()
      c.request.signal.removeEventListener("abort", onAbort)
      state.streams.update(id, { id, status, chunks: next })
    }
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined
    const onAbort = () => {
      finish("aborted")
      controller?.error(c.request.signal.reason ?? new DOMException("Aborted", "AbortError"))
    }
    const body = new ReadableStream<Uint8Array>({
      start(cn) {
        controller = cn
        c.request.signal.addEventListener("abort", onAbort, { once: true })
        if (c.request.signal.aborted) onAbort()
      },
      async pull(cn) {
        if (done) return
        if (script.stream_delay_ms) {
          await new Promise<void>((resolve) => {
            pending = resolve
            timer = setTimeout(resolve, script.stream_delay_ms)
          })
          pending = undefined
          if (done) return
        }
        const frame = frames[next++]
        if (frame !== undefined) {
          cn.enqueue(new TextEncoder().encode(frame))
          state.streams.update(id, { id, status: "open", chunks: next })
        }
        if (next >= frames.length) {
          finish("closed")
          cn.close()
        }
      },
      cancel() {
        finish("aborted")
      },
    })
    return new Response(body, {
      headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
    })
  }
  private storedChat(id: string): ChatRecord {
    const row = this.state.chats.get(id)
    if (!row?.stored) reject(404, "No stored chat completion found.", "completion_id", "not_found")
    return row
  }
  private getChat(c: OperationContext): Response {
    const row = this.storedChat(c.params.completion_id ?? "")
    this.model(c, row.model)
    return Response.json(this.state.open(row.sealed, "chat", row.id))
  }
  private deleteChat(c: OperationContext): Response {
    const row = this.storedChat(c.params.completion_id ?? "")
    this.model(c, row.model)
    this.state.chats.delete(row.id)
    return Response.json({ id: row.id, object: "chat.completion.deleted", deleted: true })
  }
  private page<T extends { id: string }>(
    c: OperationContext,
    items: T[],
    defaultLimit: number,
    maxLimit: number,
  ): Record<string, unknown> {
    const raw = c.url.searchParams.get("limit")
    const limit = raw === null ? defaultLimit : Number(raw)
    integer(limit, "limit", 1)
    if (limit > maxLimit) bad("Limit exceeds the documented maximum.", "limit")
    const after = c.url.searchParams.get("after")
    if (after) {
      const index = items.findIndex((r) => r.id === after)
      if (index < 0) bad("Invalid pagination cursor.", "after")
      items = items.slice(index + 1)
    }
    const data = items.slice(0, limit)
    return {
      object: "list",
      data,
      first_id: data[0]?.id ?? null,
      last_id: data[data.length - 1]?.id ?? null,
      has_more: items.length > limit,
    }
  }
  private listChats(c: OperationContext): Response {
    const order = c.url.searchParams.get("order") ?? "asc"
    if (order !== "asc" && order !== "desc") bad("Invalid order.", "order")
    const model = c.url.searchParams.get("model")
    const key = this.tokens.find((k) => k.token === bearerToken(c.request))
    let rows = this.state.chats
      .list({ order: "oldest" })
      .map((r) => r.value)
      .filter(
        (r) =>
          r.stored &&
          (!model || r.model === model) &&
          (!key?.models || key.models.includes(r.model)),
      )
    rows.sort((a, b) => a.created - b.created)
    if (order === "desc") rows = rows.reverse()
    const page = this.page(c, rows, 20, 100)
    page.data = (page.data as ChatRecord[]).map((r) => this.state.open(r.sealed, "chat", r.id))
    return Response.json(page)
  }
  private embed(c: OperationContext): Response {
    const b = this.body(c)
    const model = required(b.model, "model")
    const fixture = this.model(c, model, "embedding")
    let inputs: unknown[]
    if (typeof b.input === "string") {
      if (!b.input) bad("Input cannot be empty.", "input")
      inputs = [b.input]
    } else if (Array.isArray(b.input) && b.input.length) {
      const tokens = (v: unknown): v is number[] =>
        Array.isArray(v) &&
        v.length > 0 &&
        v.every((n) => typeof n === "number" && Number.isSafeInteger(n) && n >= 0)
      if (tokens(b.input)) inputs = [b.input]
      else if (b.input.every((v) => typeof v === "string" && v.length > 0) || b.input.every(tokens))
        inputs = b.input
      else bad("Invalid embedding inputs.", "input")
    } else bad("Input is required.", "input")
    const encoding = b.encoding_format ?? "float"
    if (!["float", "base64"].includes(String(encoding)))
      bad("Invalid encoding_format.", "encoding_format")
    const dimensions =
      b.dimensions === undefined ? undefined : integer(b.dimensions, "dimensions", 1)
    if (dimensions !== undefined && dimensions > (fixture.dimensions ?? 3))
      bad("Dimensions exceed the configured fixture model.", "dimensions")
    const meta = this.metadata(c, b, [])
    const raw = this.raw(c, b)
    if (raw) return raw
    const selected = this.select("embedding", b, [])
    const script = selected?.script.kind === "embedding" ? selected.script : undefined
    const width = dimensions ?? fixture.dimensions ?? 3
    const vectors =
      script?.vectors ??
      inputs.map((v) => {
        const digest = fingerprint(v)
        return Array.from(
          { length: width },
          (_, i) => Number.parseInt(digest.slice((i * 4) % 60, ((i * 4) % 60) + 4), 16) / 65535,
        )
      })
    if (
      vectors.length !== inputs.length ||
      vectors.some((v) => dimensions !== undefined && v.length < dimensions)
    )
      bad("Scripted embedding shape does not match the request.", "input")
    const normalized = vectors.map((v) => (dimensions === undefined ? v : v.slice(0, dimensions)))
    const encode = (vector: number[]): number[] | string => {
      if (encoding === "float") return vector
      const data = new Uint8Array(vector.length * 4)
      const view = new DataView(data.buffer)
      vector.forEach((v, i) => {
        view.setFloat32(i * 4, v, true)
      })
      return btoa(Array.from(data, (n) => String.fromCharCode(n)).join(""))
    }
    if (selected)
      this.state.scripts.update(selected.record.id, { ...selected.record, consumed: true })
    this.state.requests.update(meta.id, { ...meta, script_id: selected?.record.id ?? null })
    const prompt =
      script?.usage?.prompt_tokens ??
      Math.max(1, Math.ceil(new TextEncoder().encode(JSON.stringify(inputs)).length / 4))
    return Response.json({
      object: "list",
      model,
      data: normalized.map((v, index) => ({ object: "embedding", index, embedding: encode(v) })),
      usage: { prompt_tokens: prompt, total_tokens: prompt },
    })
  }
  private fileExpiry(purpose: string, value: unknown): number | undefined {
    if (value === undefined)
      return purpose === "batch" ? Math.floor(this.now() / 1000) + 2592000 : undefined
    const policy = object(value)
    if (policy.anchor !== "created_at") bad("Invalid file expiry anchor.", "expires_after.anchor")
    const seconds = integer(policy.seconds, "expires_after.seconds", 3600)
    if (seconds > 2592000) bad("File expiry exceeds 30 days.", "expires_after.seconds")
    return Math.floor(this.now() / 1000) + seconds
  }
  private fileWire(row: FileRecord): Record<string, unknown> {
    const { sealed: _sealed, ...metadata } = row
    return metadata
  }
  seedFile(f: FileFixture): FileRecord {
    const filename = required(f.filename, "filename"),
      purpose = required(f.purpose, "purpose")
    if (!purposes.includes(purpose)) bad("Invalid file purpose.", "purpose")
    let bytes: Uint8Array
    if (typeof f.bytes === "string") bytes = new TextEncoder().encode(f.bytes)
    else {
      if (!Array.isArray(f.bytes) || f.bytes.some((n) => !Number.isInteger(n) || n < 0 || n > 255))
        bad("Invalid file bytes.", "file")
      bytes = Uint8Array.from(f.bytes)
    }
    if (f.expires_at !== undefined) integer(f.expires_at, "expires_at")
    return this.saveFile(
      filename,
      purpose,
      bytes,
      f.expires_at ?? this.fileExpiry(purpose, undefined),
      f.id,
    )
  }
  private saveFile(
    filename: string,
    purpose: string,
    bytes: Uint8Array,
    expires: number | undefined,
    id?: string,
  ): FileRecord {
    if (bytes.length > this.maxFileBytes)
      reject(413, "File exceeds the configured local size limit.", "file", "file_too_large")
    const key = id ?? this.state.ids.next("file-", 24)
    if (this.state.files.has(key)) bad("A file fixture with this id already exists.", "file_id")
    const row: FileRecord = {
      id: key,
      object: "file",
      filename,
      purpose,
      bytes: bytes.length,
      created_at: Math.floor(this.now() / 1000),
      status: "processed",
      ...(expires !== undefined ? { expires_at: expires } : {}),
      sealed: this.state.seal(Array.from(bytes), "file", key),
    }
    this.state.files.insert(key, row)
    return row
  }
  private form(c: OperationContext): FormData {
    const form = this.multipartBodies.get(c.request)
    if (!form) bad("Expected multipart/form-data.")
    return form
  }
  private createFile(c: OperationContext): Response {
    const form = this.form(c)
    const file = form.get("file")
    if (!(file instanceof Blob)) bad("'file' is required.", "file")
    // Body bytes were captured asynchronously before dispatch, with the original Request preserved.
    const data = this.fileBodies.get(c.request)
    if (!data) bad("Invalid file upload.", "file")
    const purpose = required(form.get("purpose"), "purpose")
    if (!purposes.includes(purpose)) bad("Invalid file purpose.", "purpose")
    const expiry = form.has("expires_after[seconds]")
      ? this.fileExpiry(purpose, {
          anchor: form.get("expires_after[anchor]"),
          seconds: Number(form.get("expires_after[seconds]")),
        })
      : this.fileExpiry(purpose, undefined)
    const row = this.saveFile(data.filename, purpose, data.bytes, expiry)
    return annotateResponse(Response.json(this.fileWire(row)), { ids: { file: row.id } })
  }
  private readonly fileBodies = new WeakMap<Request, { filename: string; bytes: Uint8Array }>()
  private activeFile(id: string): FileRecord {
    const row = this.state.files.get(id)
    if (!row || (row.expires_at !== undefined && row.expires_at <= Math.floor(this.now() / 1000)))
      reject(404, "No such File object.", "file_id", "not_found")
    return row
  }
  private getFile(c: OperationContext): Response {
    return Response.json(this.fileWire(this.activeFile(c.params.file_id ?? "")))
  }
  private deleteFile(c: OperationContext): Response {
    const row = this.activeFile(c.params.file_id ?? "")
    this.state.files.delete(row.id)
    return Response.json({ id: row.id, object: "file", deleted: true })
  }
  private listFiles(c: OperationContext): Response {
    const order = c.url.searchParams.get("order") ?? "desc"
    if (order !== "asc" && order !== "desc") bad("Invalid order.", "order")
    const purpose = c.url.searchParams.get("purpose")
    const rows = this.state.files
      .list({ order: "oldest" })
      .map((r) => r.value)
      .filter(
        (r) =>
          (!purpose || r.purpose === purpose) &&
          (r.expires_at === undefined || r.expires_at > Math.floor(this.now() / 1000)),
      )
    rows.sort((a, b) => a.created_at - b.created_at)
    if (order === "desc") rows.reverse()
    const page = this.page(c, rows, 10000, 10000)
    page.data = (page.data as FileRecord[]).map((r) => this.fileWire(r))
    return Response.json(page)
  }
  private downloadFile(c: OperationContext): Response {
    const row = this.activeFile(c.params.file_id ?? "")
    const bytes = Uint8Array.from(this.state.open<number[]>(row.sealed, "file", row.id))
    return new Response(bytes, {
      headers: {
        "content-type": "application/octet-stream",
        "content-length": String(bytes.length),
      },
    })
  }
  private uploadWire(row: UploadRecord): Record<string, unknown> {
    const {
      file_id,
      mime_type: _mime_type,
      file_expires_after: _expiry,
      completed_parts: _parts,
      ...result
    } = row
    return { ...result, ...(file_id ? { file: this.fileWire(this.activeFile(file_id)) } : {}) }
  }
  private upload(c: OperationContext): UploadRecord {
    const row = this.state.uploads.get(c.params.upload_id ?? "")
    if (!row) reject(404, "No such Upload object.", "upload_id", "not_found")
    if (row.status === "pending" && row.expires_at <= Math.floor(this.now() / 1000)) {
      row.status = "expired"
      this.state.uploads.update(row.id, row)
    }
    return row
  }
  private pendingUpload(c: OperationContext): UploadRecord {
    const row = this.upload(c)
    if (row.status !== "pending") bad(`Upload is ${row.status}.`, "upload_id")
    return row
  }
  private createUpload(c: OperationContext): Response {
    const b = this.body(c)
    const filename = required(b.filename, "filename"),
      purpose = required(b.purpose, "purpose"),
      mime_type = required(b.mime_type, "mime_type"),
      bytes = integer(b.bytes, "bytes")
    if (!["assistants", "batch", "fine-tune", "vision"].includes(purpose))
      bad("Invalid upload purpose.", "purpose")
    if (bytes > this.maxFileBytes)
      reject(413, "Upload exceeds the configured local size limit.", "bytes", "file_too_large")
    let seconds: number | undefined
    if (b.expires_after !== undefined) {
      const expiry = this.fileExpiry(purpose, b.expires_after)
      seconds = (expiry ?? 0) - Math.floor(this.now() / 1000)
    }
    const id = this.state.ids.next("upload_", 24)
    const now = Math.floor(this.now() / 1000)
    const row: UploadRecord = {
      id,
      object: "upload",
      filename,
      purpose,
      mime_type,
      bytes,
      created_at: now,
      expires_at: now + 3600,
      status: "pending",
      ...(seconds !== undefined ? { file_expires_after: seconds } : {}),
    }
    this.state.uploads.insert(id, row)
    return annotateResponse(Response.json(this.uploadWire(row)), { ids: { upload: id } })
  }
  private createPart(c: OperationContext): Response {
    const upload = this.pendingUpload(c),
      data = this.fileBodies.get(c.request)
    if (!data) bad("'data' is required.", "data")
    if (data.bytes.length > this.maxFileBytes)
      reject(413, "Part exceeds the configured local size limit.", "data", "file_too_large")
    const id = this.state.ids.next("part_", 24)
    const row = {
      id,
      object: "upload.part" as const,
      upload_id: upload.id,
      created_at: Math.floor(this.now() / 1000),
      bytes: data.bytes.length,
      sealed: this.state.seal(Array.from(data.bytes), "part", id),
    }
    this.state.parts.insert(id, row)
    return annotateResponse(
      Response.json({
        id,
        object: row.object,
        upload_id: row.upload_id,
        created_at: row.created_at,
      }),
      { ids: { part: id, upload: upload.id } },
    )
  }
  private completeUpload(c: OperationContext): Response {
    const upload = this.pendingUpload(c),
      b = this.body(c)
    if (
      !Array.isArray(b.part_ids) ||
      b.part_ids.some((id) => typeof id !== "string") ||
      new Set(b.part_ids).size !== b.part_ids.length
    )
      bad("Invalid ordered part IDs.", "part_ids")
    const rows = b.part_ids.map((id) => {
      const row = this.state.parts.get(id)
      if (!row || row.upload_id !== upload.id) bad("Invalid upload part.", "part_ids")
      return row
    })
    const size = rows.reduce((n, row) => n + row.bytes, 0)
    if (size !== upload.bytes)
      bad("Uploaded bytes do not match the declared upload size.", "part_ids")
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const row of rows) {
      const part = this.state.open<number[]>(row.sealed, "part", row.id)
      bytes.set(part, offset)
      offset += part.length
    }
    if (
      b.md5 !== undefined &&
      (typeof b.md5 !== "string" || b.md5.toLowerCase() !== hex(md5(bytes)))
    )
      bad("MD5 checksum mismatch.", "md5")
    const updated = this.sqlite.transaction(() => {
      const expiry =
        upload.file_expires_after !== undefined
          ? Math.floor(this.now() / 1000) + upload.file_expires_after
          : this.fileExpiry(upload.purpose, undefined)
      const file = this.saveFile(upload.filename, upload.purpose, bytes, expiry)
      const result: UploadRecord = {
        ...upload,
        status: "completed",
        file_id: file.id,
        completed_parts: b.part_ids as string[],
      }
      this.state.uploads.update(upload.id, result)
      return result
    })
    return annotateResponse(Response.json(this.uploadWire(updated)), {
      ids: { upload: upload.id, file: updated.file_id ?? "" },
    })
  }
  private cancelUpload(c: OperationContext): Response {
    const row = this.pendingUpload(c)
    const updated: UploadRecord = { ...row, status: "cancelled" }
    this.state.uploads.update(row.id, updated)
    return Response.json(this.uploadWire(updated))
  }
}
export type { OpenAIRuntime, OpenAIRuntimeOptions } from "./runtime.js"
export { createRuntime, OPENAI_PRESETS } from "./runtime.js"
