import { Collection, fromBase64, IdSequence, toHex } from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"
import { sha256 } from "@noble/hashes/sha2.js"
import { isOutputFormat, type OutputFormat } from "./audio.js"
import type { Sealed, Vault } from "./vault.js"

/** The key every namespace accepts until a suite configures its own. */
export const DEFAULT_API_KEY = "fixture-elevenlabs-key"

/** The model the vendor uses when a request names none. */
export const DEFAULT_MODEL_ID = "eleven_multilingual_v2"

export type VoiceFixture = { voice_id: string; name?: string }

export type ModelFixture = {
  model_id: string
  /** `false` makes the model exist but refuse text to speech. Default `true`. */
  can_do_text_to_speech?: boolean
}

/** The voice id the vendor's own reference uses in its examples. */
export const DEFAULT_VOICES: readonly VoiceFixture[] = [
  { voice_id: "21m00Tcm4TlvDq8ikWAM", name: "Fixture voice" },
]

export const DEFAULT_MODELS: readonly ModelFixture[] = [
  { model_id: DEFAULT_MODEL_ID },
  { model_id: "eleven_flash_v2_5" },
  { model_id: "eleven_turbo_v2_5" },
]

const encoder = new TextEncoder()

/** SHA-256 of bytes or UTF-8 text, hex-encoded. */
export const sha256Hex = (input: string | Uint8Array): string =>
  toHex(sha256(typeof input === "string" ? encoder.encode(input) : input))

/** How a request's text is recorded: its SHA-256, never the text. */
export const textFingerprint = (text: string): string => sha256Hex(text)

export type SpeechRequest = {
  voice_id: string
  /** Default: {@link DEFAULT_MODEL_ID}, as on the vendor. */
  model_id?: string
  /** Default: `mp3_44100_128`, as on the vendor. */
  output_format?: string
  text: string
}

/**
 * One digest identifying a speech request: SHA-256 of the JSON array
 * `[voice_id, model_id, output_format, sha256(text)]` with the vendor's defaults filled in. A
 * suite computes it with this function (or by hand) to match a script or find a call.
 */
export const speechFingerprint = (request: SpeechRequest): string =>
  sha256Hex(
    JSON.stringify([
      request.voice_id,
      request.model_id ?? DEFAULT_MODEL_ID,
      request.output_format ?? "mp3_44100_128",
      textFingerprint(request.text),
    ]),
  )

/** Which requests a script answers. Every field given must match; none given matches all. */
export type ScriptMatch = {
  voice_id?: string
  model_id?: string
  output_format?: OutputFormat
  /** SHA-256 of the exact text ({@link textFingerprint}). */
  text_sha256?: string
  /** The whole request ({@link speechFingerprint}). */
  fingerprint?: string
}

/** A reply to queue: exact bytes for the requests `match` selects. */
export type SpeechScript = {
  match?: ScriptMatch & {
    /** The exact text. Hashed on arrival into `text_sha256`; the text itself is dropped. */
    text?: string
  }
  /** The bytes to answer with. */
  audio?: Uint8Array
  /** The same bytes, base64-encoded (the form `POST /__admin/scripts` takes). */
  audio_base64?: string
  /** Answer with this `content-type` instead of the format's own. */
  content_type?: string
  /** Retire the script after this many answers. Omit to answer every matching request. */
  times?: number
}

/** A stored script. The audio is sealed; everything else is safe to show. */
export type ScriptRecord = {
  id: string
  match: ScriptMatch
  content_type: string | null
  /** Length of the audio in bytes. */
  bytes: number
  /** SHA-256 of the audio. */
  sha256: string
  times: number | null
  remaining: number | null
  hits: number
  sealed: Sealed
}

/** What `GET /__admin/scripts` shows: a script without its audio. */
export type ScriptView = Omit<ScriptRecord, "sealed">

/**
 * What the mock keeps about one text-to-speech request: identifiers, lengths and digests. The
 * text, the API key and the audio are never stored.
 */
export type CallRecord = {
  id: string
  voice_id: string
  model_id: string
  output_format: string
  text_sha256: string
  /** Unicode code points in the text. */
  text_characters: number
  fingerprint: string
  status: number
  /** The error's legacy `status` identifier, or `null` for audio. */
  error: string | null
  /** The script that answered, or `null` for generated audio or an error. */
  script_id: string | null
  audio_bytes: number
  audio_sha256: string | null
  content_type: string | null
  at: string
}

const HEX_64 = /^[a-f0-9]{64}$/

const record = (value: unknown, what: string): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${what} must be an object`)
  }
  return value as Record<string, unknown>
}

const only = (value: Record<string, unknown>, keys: readonly string[], what: string): void => {
  const unknown = Object.keys(value).filter((key) => !keys.includes(key))
  if (unknown.length > 0) throw new Error(`${what} has unknown field ${unknown.join(", ")}`)
}

const optionalString = (value: unknown, what: string): string | undefined => {
  if (value === undefined) return undefined
  if (typeof value !== "string" || value.length === 0) throw new Error(`${what} must be a string`)
  return value
}

const digest = (value: unknown, what: string): string | undefined => {
  if (value === undefined) return undefined
  if (typeof value !== "string" || !HEX_64.test(value)) {
    throw new Error(`${what} must be a lowercase hex SHA-256`)
  }
  return value
}

/** A script checked and reduced to what is stored: a match without text, and the bytes. */
export type ParsedScript = {
  match: ScriptMatch
  audio: Uint8Array
  content_type: string | null
  times: number | null
}

/** Validate a script from `POST /__admin/scripts` or the `scripts` option. Throws on a bad one. */
export const parseScript = (input: unknown): ParsedScript => {
  const script = record(input, "script")
  only(script, ["match", "audio", "audio_base64", "content_type", "times"], "script")
  const raw = script.match === undefined ? {} : record(script.match, "match")
  only(
    raw,
    ["voice_id", "model_id", "output_format", "text", "text_sha256", "fingerprint"],
    "match",
  )
  const format = optionalString(raw.output_format, "match.output_format")
  if (format !== undefined && !isOutputFormat(format)) {
    throw new Error(`match.output_format ${format} is not a vendor output format`)
  }
  if (raw.text !== undefined && typeof raw.text !== "string") {
    throw new Error("match.text must be a string")
  }
  if (raw.text !== undefined && raw.text_sha256 !== undefined) {
    throw new Error("match takes text or text_sha256, not both")
  }
  const voice = optionalString(raw.voice_id, "match.voice_id")
  const model = optionalString(raw.model_id, "match.model_id")
  const text =
    typeof raw.text === "string"
      ? textFingerprint(raw.text)
      : digest(raw.text_sha256, "match.text_sha256")
  const fingerprint = digest(raw.fingerprint, "match.fingerprint")
  const match: ScriptMatch = {
    ...(voice !== undefined ? { voice_id: voice } : {}),
    ...(model !== undefined ? { model_id: model } : {}),
    ...(format !== undefined ? { output_format: format } : {}),
    ...(text !== undefined ? { text_sha256: text } : {}),
    ...(fingerprint !== undefined ? { fingerprint } : {}),
  }
  if ((script.audio === undefined) === (script.audio_base64 === undefined)) {
    throw new Error("script takes exactly one of audio (bytes) or audio_base64")
  }
  let audio: Uint8Array
  if (script.audio instanceof Uint8Array) {
    audio = script.audio.slice()
  } else if (typeof script.audio_base64 === "string") {
    try {
      audio = fromBase64(script.audio_base64)
    } catch {
      throw new Error("audio_base64 is not base64")
    }
  } else {
    throw new Error("audio must be bytes, or audio_base64 a base64 string")
  }
  if (audio.length === 0) throw new Error("script audio is empty")
  const times = script.times
  if (times !== undefined && (typeof times !== "number" || !Number.isInteger(times) || times < 1)) {
    throw new Error("times must be a positive integer")
  }
  return {
    match,
    audio,
    content_type: optionalString(script.content_type, "content_type") ?? null,
    times: times ?? null,
  }
}

/** A list of `{<id>: string, …}` rows from an admin body or an option. Throws on a bad one. */
const fixtures = <T extends Record<string, unknown>>(
  input: unknown,
  id: string,
  what: string,
): T[] => {
  if (!Array.isArray(input)) throw new Error(`${what} must be a list`)
  return input.map((item) => {
    const row = typeof item === "string" ? { [id]: item } : record(item, what)
    if (typeof row[id] !== "string" || (row[id] as string).length === 0) {
      throw new Error(`each of ${what} needs a ${id}`)
    }
    return row as T
  })
}

export const parseVoices = (input: unknown): VoiceFixture[] =>
  fixtures<VoiceFixture>(input, "voice_id", "voices").map((voice) => ({
    voice_id: voice.voice_id,
    ...(typeof voice.name === "string" ? { name: voice.name } : {}),
  }))

export const parseModels = (input: unknown): ModelFixture[] =>
  fixtures<ModelFixture>(input, "model_id", "models").map((model) => ({
    model_id: model.model_id,
    can_do_text_to_speech: model.can_do_text_to_speech !== false,
  }))

export const parseKeys = (input: unknown): string[] => {
  if (!Array.isArray(input) || input.some((key) => typeof key !== "string" || key.length === 0)) {
    throw new Error("keys must be a list of non-empty strings")
  }
  return input as string[]
}

/** What a namespace starts with and returns to on reset. */
export type Seed = {
  keys: readonly string[]
  voices: readonly VoiceFixture[]
  models: readonly ModelFixture[]
  scripts: readonly ParsedScript[]
}

export class ElevenLabsState {
  readonly voices: Collection<VoiceFixture>
  readonly models: Collection<Required<ModelFixture>>
  /** Accepted API keys, by SHA-256: the keys themselves are never stored. */
  readonly keys: Collection<{ sha256: string }>
  readonly scripts: Collection<ScriptRecord>
  readonly calls: Collection<CallRecord>
  readonly settings: Collection<{ seeded: boolean }>
  readonly ids: IdSequence

  constructor(
    sqlite: SqliteClient,
    namespace: string,
    private readonly vault: Vault,
    /** Binds sealed audio to the namespace a request names, not to its storage branch. */
    private readonly publicNamespace: string,
    private readonly seed: Seed,
  ) {
    this.voices = new Collection(sqlite, namespace, "voices")
    this.models = new Collection(sqlite, namespace, "models")
    this.keys = new Collection(sqlite, namespace, "keys")
    this.scripts = new Collection(sqlite, namespace, "scripts")
    this.calls = new Collection(sqlite, namespace, "calls")
    this.settings = new Collection(sqlite, namespace, "settings")
    this.ids = new IdSequence(sqlite, namespace, "elevenlabs")
    this.ensureSeeded()
  }

  /** Load the configured keys, voices, models and scripts into an empty namespace. */
  ensureSeeded(): void {
    if (this.settings.has("settings")) return
    this.settings.insert("settings", { seeded: true })
    this.putKeys(this.seed.keys)
    this.putVoices(this.seed.voices)
    this.putModels(this.seed.models)
    for (const script of this.seed.scripts) this.addScript(script)
  }

  private replace<T>(collection: Collection<T>, rows: readonly (readonly [string, T])[]): number {
    for (const row of collection.list()) collection.delete(row.id)
    for (const [id, value] of rows) collection.insert(id, value)
    return collection.count()
  }

  putKeys(keys: readonly string[]): number {
    return this.replace(
      this.keys,
      keys.map((key) => {
        const hash = sha256Hex(key)
        return [hash, { sha256: hash }] as const
      }),
    )
  }

  hasKey(key: string): boolean {
    return this.keys.has(sha256Hex(key))
  }

  putVoices(voices: readonly VoiceFixture[]): number {
    return this.replace(
      this.voices,
      voices.map((voice) => [voice.voice_id, voice] as const),
    )
  }

  putModels(models: readonly ModelFixture[]): number {
    return this.replace(
      this.models,
      models.map(
        (model) =>
          [
            model.model_id,
            {
              model_id: model.model_id,
              can_do_text_to_speech: model.can_do_text_to_speech !== false,
            },
          ] as const,
      ),
    )
  }

  private context(id: string): string {
    return JSON.stringify([this.publicNamespace, "script", id])
  }

  addScript(script: ParsedScript): ScriptRecord {
    const id = this.ids.next("scr_", 12)
    const stored: ScriptRecord = {
      id,
      match: script.match,
      content_type: script.content_type,
      bytes: script.audio.length,
      sha256: sha256Hex(script.audio),
      times: script.times,
      remaining: script.times,
      hits: 0,
      sealed: this.vault.seal(script.audio, this.context(id)),
    }
    this.scripts.insert(id, stored)
    return stored
  }

  /** The oldest script that matches and still has answers left. */
  findScript(request: Required<ScriptMatch>): ScriptRecord | undefined {
    return this.scripts.list({ order: "oldest" }).find(({ value }) => {
      if (value.remaining === 0) return false
      const match = value.match
      return (Object.keys(match) as (keyof ScriptMatch)[]).every(
        (key) => match[key] === request[key],
      )
    })?.value
  }

  /** The script's audio, counting one answer against it. */
  takeAudio(script: ScriptRecord): Uint8Array {
    this.scripts.update(script.id, {
      ...script,
      hits: script.hits + 1,
      remaining: script.remaining === null ? null : script.remaining - 1,
    })
    return this.vault.open(script.sealed, this.context(script.id))
  }

  scriptViews(): ScriptView[] {
    return this.scripts
      .list({ order: "oldest" })
      .map(({ value: { sealed: _sealed, ...view } }) => view)
  }
}
