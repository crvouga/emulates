import { Collection, IdSequence } from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"
import { sha256 } from "@noble/hashes/sha2.js"
import type { Sealed, Vault } from "./vault.js"
export const DEFAULT_TOKEN = "fixture-openai-token"
export type ModelFixture = {
  id: string
  kind: "chat" | "embedding"
  dimensions?: number
  created?: number
  owned_by?: string
}
export const DEFAULT_MODELS: readonly ModelFixture[] = [
  { id: "fixture-chat", kind: "chat" },
  { id: "fixture-embedding", kind: "embedding", dimensions: 3 },
]
export type ToolCall = {
  id?: string
  type: "function"
  function: { name: string; arguments: string }
}
export type AssistantMessage = {
  role: "assistant"
  content: string | null
  tool_calls?: ToolCall[]
  refusal?: string | null
}
export type ScriptMatch = {
  model?: string
  lastRole?: string
  contentIncludes?: string
  toolCallId?: string
}
export type ScriptUsage = {
  prompt_tokens: number
  completion_tokens?: number
  cached_tokens?: number
}
export type ChatScript = {
  kind: "chat"
  match?: ScriptMatch
  message: AssistantMessage
  finish_reason?: "stop" | "tool_calls" | "length" | "content_filter"
  usage?: ScriptUsage
  chunk_size?: number
  stream_delay_ms?: number
}
export type EmbeddingScript = {
  kind: "embedding"
  match?: ScriptMatch
  vectors: number[][]
  usage?: ScriptUsage
}
export type Script = ChatScript | EmbeddingScript
export type ScriptRecord = { id: string; kind: Script["kind"]; consumed: boolean; sealed: Sealed }
export type ChatRecord = {
  id: string
  model: string
  created: number
  stored: boolean
  requestId: string
  sealed: Sealed
}
export type FileFixture = {
  id?: string
  filename: string
  purpose: string
  bytes: string | readonly number[]
  expires_at?: number
}
export type FileRecord = {
  id: string
  object: "file"
  filename: string
  purpose: string
  bytes: number
  created_at: number
  status: "processed"
  expires_at?: number
  sealed: Sealed
}
export type UploadRecord = {
  id: string
  object: "upload"
  filename: string
  purpose: string
  bytes: number
  mime_type: string
  created_at: number
  expires_at: number
  status: "pending" | "completed" | "cancelled" | "expired"
  file_id?: string
  file_expires_after?: number
  completed_parts?: string[]
}
export type PartRecord = {
  id: string
  object: "upload.part"
  upload_id: string
  created_at: number
  bytes: number
  sealed: Sealed
}
export type RawFault = {
  id: string
  model?: string
  sealed: Sealed
  status: number
  content_type: "application/json" | "text/event-stream"
}
export type RequestMetadata = {
  id: string
  operationId: string
  model: string | null
  message_count: number
  roles: string[]
  content_bytes: number
  tool_count: number
  fingerprint: string
  cache_key_hash: string | null
  script_id: string | null
  response_id: string | null
  created_at: number
}
export type StreamMetadata = { id: string; status: "open" | "closed" | "aborted"; chunks: number }
export const hex = (bytes: Uint8Array): string =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")
export const fingerprint = (value: unknown): string =>
  hex(sha256(new TextEncoder().encode(JSON.stringify(value))))
export const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
export class OpenAIState {
  readonly models: Collection<ModelFixture>
  readonly scripts: Collection<ScriptRecord>
  readonly chats: Collection<ChatRecord>
  readonly files: Collection<FileRecord>
  readonly uploads: Collection<UploadRecord>
  readonly parts: Collection<PartRecord>
  readonly requests: Collection<RequestMetadata>
  readonly streams: Collection<StreamMetadata>
  readonly rawFaults: Collection<RawFault>
  readonly settings: Collection<{ initialized: boolean }>
  readonly ids: IdSequence
  constructor(
    readonly sqlite: SqliteClient,
    readonly namespace: string,
    private readonly vault: Vault,
    private readonly publicNamespace = namespace,
  ) {
    this.models = new Collection(sqlite, namespace, "models")
    this.scripts = new Collection(sqlite, namespace, "scripts")
    this.chats = new Collection(sqlite, namespace, "chats")
    this.files = new Collection(sqlite, namespace, "files")
    this.uploads = new Collection(sqlite, namespace, "uploads")
    this.parts = new Collection(sqlite, namespace, "upload_parts")
    this.requests = new Collection(sqlite, namespace, "request_metadata")
    this.streams = new Collection(sqlite, namespace, "stream_metadata")
    this.rawFaults = new Collection(sqlite, namespace, "raw_faults")
    this.settings = new Collection(sqlite, namespace, "settings")
    this.ids = new IdSequence(sqlite, namespace)
  }
  seal(value: unknown, kind: string, id: string): Sealed {
    return this.vault.seal(value, JSON.stringify([this.publicNamespace, kind, id]))
  }
  open<T>(value: Sealed, kind: string, id: string): T {
    return this.vault.open<T>(value, JSON.stringify([this.publicNamespace, kind, id]))
  }
}
const allowed = (value: Record<string, unknown>, keys: readonly string[]): void => {
  if (Object.keys(value).some((k) => !keys.includes(k))) throw new Error("Unknown script field")
}
const nonnegative = (v: unknown): boolean =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0
/** Normal scripts are strict. Malformed vendor replies belong only in the explicit raw control. */
export function validateScript(input: unknown): Script {
  const data = structuredClone(object(input))
  if (data.kind !== "chat" && data.kind !== "embedding")
    throw new Error("Script kind must be chat or embedding")
  allowed(
    data,
    data.kind === "chat"
      ? ["kind", "match", "message", "finish_reason", "usage", "chunk_size", "stream_delay_ms"]
      : ["kind", "match", "vectors", "usage"],
  )
  if (data.match !== undefined) {
    const m = object(data.match)
    allowed(m, ["model", "lastRole", "contentIncludes", "toolCallId"])
    if (Object.values(m).some((v) => typeof v !== "string"))
      throw new Error("Invalid script predicate")
    if (data.match === null || typeof data.match !== "object" || Array.isArray(data.match))
      throw new Error("Invalid script predicate")
  }
  if (data.usage !== undefined) {
    const u = object(data.usage)
    allowed(u, ["prompt_tokens", "completion_tokens", "cached_tokens"])
    if (
      !nonnegative(u.prompt_tokens) ||
      (u.completion_tokens !== undefined && !nonnegative(u.completion_tokens)) ||
      (u.cached_tokens !== undefined &&
        (!nonnegative(u.cached_tokens) || Number(u.cached_tokens) > Number(u.prompt_tokens)))
    )
      throw new Error("Invalid script usage")
  }
  if (data.kind === "embedding") {
    if (
      !Array.isArray(data.vectors) ||
      !data.vectors.length ||
      data.vectors.some(
        (v) =>
          !Array.isArray(v) ||
          !v.length ||
          v.some((n) => typeof n !== "number" || !Number.isFinite(n)),
      )
    )
      throw new Error("Invalid embedding vectors")
  } else {
    const m = object(data.message)
    allowed(m, ["role", "content", "tool_calls", "refusal"])
    if (
      m.role !== "assistant" ||
      !(typeof m.content === "string" || m.content === null) ||
      (m.refusal !== undefined && typeof m.refusal !== "string" && m.refusal !== null)
    )
      throw new Error("Invalid assistant message")
    if (m.tool_calls !== undefined) {
      if (!Array.isArray(m.tool_calls) || !m.tool_calls.length)
        throw new Error("Invalid tool calls")
      const seen = new Set<string>()
      for (const value of m.tool_calls) {
        const t = object(value)
        allowed(t, ["id", "type", "function"])
        const f = object(t.function)
        allowed(f, ["name", "arguments"])
        if (
          t.type !== "function" ||
          typeof f.name !== "string" ||
          !f.name ||
          typeof f.arguments !== "string" ||
          (t.id !== undefined && (typeof t.id !== "string" || !t.id || seen.has(t.id)))
        )
          throw new Error("Invalid tool call")
        try {
          JSON.parse(f.arguments)
        } catch {
          throw new Error("Tool arguments must be a JSON string")
        }
        if (typeof t.id === "string") seen.add(t.id)
      }
    }
    if (
      m.content === null &&
      !m.tool_calls &&
      !m.refusal &&
      data.finish_reason !== "content_filter"
    )
      throw new Error("Null content needs a tool call or refusal")
    if (
      data.finish_reason !== undefined &&
      !["stop", "tool_calls", "length", "content_filter"].includes(String(data.finish_reason))
    )
      throw new Error("Invalid finish reason")
    if (data.chunk_size !== undefined && (!nonnegative(data.chunk_size) || data.chunk_size === 0))
      throw new Error("Invalid chunk size")
    if (data.stream_delay_ms !== undefined && !nonnegative(data.stream_delay_ms))
      throw new Error("Invalid stream delay")
  }
  return data as unknown as Script
}
