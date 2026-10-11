import type { FetchAPI } from "@crvouga/mockingbird-core"
import {
  type APIOptions,
  annotateResponse,
  type BodyIssue,
  bootSqlite,
  codePointLength,
  createService,
  defineOperations,
  jsonRes,
  type OperationContext,
  type Service,
} from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"
import type { Hono } from "hono"
import {
  DEFAULT_OUTPUT_FORMAT,
  describeFormat,
  durationFor,
  isOutputFormat,
  synthesize,
  toneFor,
} from "./audio.js"
import { vendorError } from "./errors.js"
import { document, type SupportedOperationId } from "./generated/openapi.js"
import {
  type CallRecord,
  DEFAULT_API_KEY,
  DEFAULT_MODEL_ID,
  DEFAULT_MODELS,
  DEFAULT_VOICES,
  ElevenLabsState,
  type ModelFixture,
  parseScript,
  type ScriptView,
  type SpeechScript,
  sha256Hex,
  speechFingerprint,
  textFingerprint,
  type VoiceFixture,
} from "./state.js"
import { createVaultKey, Vault } from "./vault.js"

export type { FetchAPI } from "@crvouga/mockingbird-core"
export type { SqliteClient } from "@crvouga/mockingbird-sqlite"
export type { Codec, FormatInfo, OutputFormat } from "./audio.js"
export {
  DEFAULT_OUTPUT_FORMAT,
  describeFormat,
  mp3Audio,
  OUTPUT_FORMATS,
  pcmAudio,
  wavAudio,
} from "./audio.js"
export type { OperationId, SupportedOperationId } from "./generated/openapi.js"
export { document, operationIds, supportedOperationIds } from "./generated/openapi.js"
export type {
  CallRecord,
  ModelFixture,
  ScriptMatch,
  ScriptView,
  SpeechRequest,
  SpeechScript,
  VoiceFixture,
} from "./state.js"
export {
  DEFAULT_API_KEY,
  DEFAULT_MODEL_ID,
  DEFAULT_MODELS,
  DEFAULT_VOICES,
  speechFingerprint,
  textFingerprint,
} from "./state.js"
export { createVaultKey } from "./vault.js"

export const ELEVENLABS_NAMESPACE = "elevenlabs"

/** The header that carries the API key. */
export const API_KEY_HEADER = "xi-api-key"

export type ElevenLabsAPIOptions = APIOptions & {
  /** API keys the namespace accepts. Default: {@link DEFAULT_API_KEY}. Stored as SHA-256 only. */
  keys?: readonly string[]
  /** Voices every namespace starts with and resets to. Default: {@link DEFAULT_VOICES}. */
  voices?: readonly VoiceFixture[]
  /** Models every namespace starts with and resets to. Default: {@link DEFAULT_MODELS}. */
  models?: readonly ModelFixture[]
  /** Replies every namespace starts with and resets to. */
  scripts?: readonly SpeechScript[]
  /** Seals scripted audio at rest. Pass the same key to reopen a persisted database. */
  vaultKey?: Uint8Array
  /** The namespace a request names, when the storage namespace differs from it. */
  publicNamespace?: string
}

/** One entry of a 422 body, as the vendor's request validation writes it. */
type ValidationIssue = {
  type: string
  loc: (string | number)[]
  msg: string
  input: unknown
  ctx?: Record<string, unknown>
}

const MISSING_TEXT: ValidationIssue = {
  type: "missing",
  loc: ["body", "text"],
  msg: "Field required",
  input: null,
}

const notString = (field: string, input: unknown): ValidationIssue => ({
  type: "string_type",
  loc: ["body", field],
  msg: "Input should be a valid string",
  input,
})

/**
 * What the vendor's request validation rejects before it looks at the API key. A body that is
 * not JSON under a JSON `content-type` is `json_invalid`; any other body it cannot read as an
 * object (none, another media type, a JSON scalar) is a missing `text`.
 */
const bodyProblems = (context: OperationContext): ValidationIssue[] => {
  const body = context.body
  if (body.kind === "invalid") {
    return [
      {
        type: "json_invalid",
        loc: ["body", 0],
        msg: "JSON decode error",
        input: {},
        ctx: { error: "Invalid JSON" },
      },
    ]
  }
  if (
    body.kind !== "json" ||
    typeof body.value !== "object" ||
    body.value === null ||
    Array.isArray(body.value)
  ) {
    return [MISSING_TEXT]
  }
  const fields = body.value as Record<string, unknown>
  const issues: ValidationIssue[] = []
  if (fields.text === undefined) issues.push(MISSING_TEXT)
  else if (typeof fields.text !== "string") issues.push(notString("text", fields.text))
  if (fields.model_id !== undefined && typeof fields.model_id !== "string") {
    issues.push(notString("model_id", fields.model_id))
  }
  return issues
}

/** The journal's view of a 422: where and why, never the offending value. */
const journalIssues = (issues: ValidationIssue[]): BodyIssue[] =>
  issues.map((issue) => ({
    path: issue.loc.slice(1).join("."),
    message: issue.msg,
    kind:
      issue.type === "json_invalid" ? "syntax" : issue.type === "missing" ? "required" : "schema",
  }))

const ROUTE = /^\/v1\/text-to-speech\/[^/]+$/

/**
 * Mock of ElevenLabs text to speech.
 *
 * A request is answered by the oldest queued script that matches it, else by generated audio
 * that is a pure function of the request, so the same request always gets the same bytes.
 * Only metadata is kept about a request: the text, the key and the audio are never stored.
 */
export class ElevenLabsAPI implements FetchAPI {
  readonly app: Hono
  readonly sqlite: SqliteClient
  readonly state: ElevenLabsState
  private readonly service: Service
  private readonly now: () => number

  constructor(options: ElevenLabsAPIOptions = {}) {
    const sqlite = bootSqlite(options.sqlite)
    const namespace = options.namespace ?? ELEVENLABS_NAMESPACE
    this.now = options.now ?? (() => Date.now())
    this.state = new ElevenLabsState(
      sqlite,
      namespace,
      new Vault(options.vaultKey ?? createVaultKey()),
      options.publicNamespace ?? namespace,
      {
        keys: options.keys ?? [DEFAULT_API_KEY],
        voices: options.voices ?? DEFAULT_VOICES,
        models: options.models ?? DEFAULT_MODELS,
        scripts: (options.scripts ?? []).map(parseScript),
      },
    )
    this.service = createService({
      document,
      handlers: defineOperations<SupportedOperationId>({
        ConvertTextToSpeech: (context) => this.convert(context),
      }),
      sqlite,
      namespace,
      now: this.now,
      notFound: (request) => {
        const headers = { "x-trace-id": this.nextIds().trace }
        return ROUTE.test(new URL(request.url).pathname)
          ? jsonRes(405, { detail: "Method Not Allowed" }, { ...headers, allow: "POST" })
          : jsonRes(404, { detail: "Not Found" }, headers)
      },
      onError: (error) => {
        throw error
      },
    })
    this.app = this.service.app
    this.sqlite = this.service.sqlite
  }

  fetch(request: Request): Promise<Response> {
    return this.service.fetch(request)
  }

  async reset(): Promise<void> {
    await this.service.reset()
    this.state.ensureSeeded()
  }

  /** Queue a reply. Throws when the script is malformed. */
  queue(script: unknown): ScriptView {
    const { sealed: _sealed, ...view } = this.state.addScript(parseScript(script))
    return view
  }

  /** Every queued script, oldest first, without its audio. */
  scripts(): ScriptView[] {
    return this.state.scriptViews()
  }

  /** Drop every queued script, seeded ones included. Returns how many there were. */
  clearScripts(): number {
    const rows = this.state.scripts.list()
    for (const row of rows) this.state.scripts.delete(row.id)
    return rows.length
  }

  /** What was recorded about each request, oldest first. */
  calls(): CallRecord[] {
    return this.state.calls.list({ order: "oldest" }).map((row) => row.value)
  }

  /** A request id as the vendor's `request-id` header carries it, and its trace id. */
  private nextIds(): { request: string; trace: string } {
    const request = this.state.ids.next("req_", 20).slice(4)
    return { request, trace: sha256Hex(`trace:${request}`).slice(0, 32) }
  }

  private convert(context: OperationContext): Response {
    context.request.signal.throwIfAborted()
    const ids = this.nextIds()
    const problems = bodyProblems(context)
    if (problems.length > 0) {
      return annotateResponse(jsonRes(422, { detail: problems }, { "x-trace-id": ids.trace }), {
        issues: journalIssues(problems),
      })
    }
    const body = (context.body as { value: { text: string; model_id?: string } }).value
    const voiceId = context.params.voice_id ?? ""
    const modelId = body.model_id ?? DEFAULT_MODEL_ID
    const format = context.url.searchParams.get("output_format") ?? DEFAULT_OUTPUT_FORMAT
    const text = body.text
    const fingerprint = speechFingerprint({
      voice_id: voiceId,
      model_id: modelId,
      output_format: format,
      text,
    })
    const call: CallRecord = {
      id: ids.request,
      voice_id: voiceId,
      model_id: modelId,
      output_format: format,
      text_sha256: textFingerprint(text),
      text_characters: codePointLength(text),
      fingerprint,
      status: 0,
      error: null,
      script_id: null,
      audio_bytes: 0,
      audio_sha256: null,
      content_type: null,
      at: new Date(this.now()).toISOString(),
    }
    const notes = { ids: { call: call.id, voice: voiceId } }
    const fail = (
      httpStatus: number,
      type: string,
      code: string,
      message: string,
      extra: { status?: string; param?: string } = {},
    ): Response => {
      const status = extra.status ?? code
      this.state.calls.insert(call.id, { ...call, status: httpStatus, error: status })
      return annotateResponse(
        vendorError(httpStatus, {
          type,
          code,
          message,
          status,
          request_id: ids.trace,
          ...(extra.param !== undefined ? { param: extra.param } : {}),
        }),
        notes,
      )
    }

    const key = context.request.headers.get(API_KEY_HEADER)
    if (key === null || key === "") {
      return fail(
        401,
        "authentication_error",
        "unauthorized",
        "Neither authorization header nor xi-api-key received, please provide one.",
        { status: "needs_authorization" },
      )
    }
    if (!this.state.hasKey(key)) {
      return fail(401, "authentication_error", "unauthorized", "Invalid API key", {
        status: "invalid_api_key",
      })
    }
    if (!isOutputFormat(format)) {
      return fail(
        400,
        "validation_error",
        "invalid_output_format",
        "The requested output format is not supported.",
        { param: "output_format" },
      )
    }
    if (text.length === 0) {
      return fail(400, "validation_error", "empty_text", "The text field cannot be empty.", {
        param: "text",
      })
    }
    if (!this.state.voices.has(voiceId)) {
      return fail(
        404,
        "not_found",
        "voice_not_found",
        "The specified voice ID does not exist. Verify the voice ID and try again.",
        { param: "voice_id" },
      )
    }
    const model = this.state.models.get(modelId)
    if (!model) {
      return fail(404, "not_found", "model_not_found", "The specified model does not exist.", {
        param: "model_id",
      })
    }
    if (!model.can_do_text_to_speech) {
      return fail(
        400,
        "validation_error",
        "unsupported_model",
        "The specified model is not supported for this operation.",
        { param: "model_id" },
      )
    }

    const info = describeFormat(format)
    const script = this.state.findScript({
      voice_id: voiceId,
      model_id: modelId,
      output_format: format,
      text_sha256: call.text_sha256,
      fingerprint,
    })
    const audio = script
      ? this.state.takeAudio(script)
      : synthesize(format, durationFor(call.text_characters), toneFor(fingerprint))
    if (!audio) {
      return fail(
        501,
        "mockingbird_not_modelled",
        "no_fixture_for_output_format",
        `Mockingbird does not generate ${format} audio. Queue a script for it: POST /__admin/scripts {"match": {"output_format": "${format}"}, "audio_base64": "…"}.`,
        { param: "output_format" },
      )
    }
    const contentType = script?.content_type ?? info.contentType
    this.state.calls.insert(call.id, {
      ...call,
      status: 200,
      script_id: script?.id ?? null,
      audio_bytes: audio.length,
      audio_sha256: sha256Hex(audio),
      content_type: contentType,
    })
    return annotateResponse(
      new Response(audio as BodyInit, {
        status: 200,
        headers: {
          "content-type": contentType,
          "content-length": String(audio.length),
          "character-cost": String(call.text_characters),
          "request-id": ids.request,
          "x-trace-id": ids.trace,
        },
      }),
      { ids: { ...notes.ids, ...(script ? { script: script.id } : {}) } },
    )
  }
}

export type { ElevenLabsRuntime, ElevenLabsRuntimeOptions } from "./runtime.js"
export { createRuntime, ELEVENLABS_PRESETS } from "./runtime.js"
