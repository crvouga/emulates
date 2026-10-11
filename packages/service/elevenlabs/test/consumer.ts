/**
 * The consumer's ElevenLabs adapter, as the service request describes it: raw `fetch` (no
 * SDK), an injectable `fetch` and base URL, the key in `xi-api-key`, and two calls.
 *
 *   mp3: POST {baseUrl}/text-to-speech/{voice_id}?output_format=mp3_44100_128
 *        Content-Type: application/json, Accept: audio/mpeg, body {text, model_id}
 *   pcm: the same with output_format=pcm_44100 and Accept: audio/wav
 *
 * It reads the HTTP status and the exact response bytes, and on a failure the error body.
 * The `Accept: audio/wav` on the PCM call is the consumer's, kept as it is: the vendor
 * answers `pcm_44100` with headerless samples whatever the request accepts, and the tests
 * pin that the mock does the same.
 */

export type Fetch = (request: Request) => Promise<Response>

export type TtsFormat = "mp3" | "pcm"

const WIRE: Record<TtsFormat, { outputFormat: string; accept: string }> = {
  mp3: { outputFormat: "mp3_44100_128", accept: "audio/mpeg" },
  pcm: { outputFormat: "pcm_44100", accept: "audio/wav" },
}

export type TtsRequest = {
  voiceId: string
  modelId: string
  text: string
  format: TtsFormat
  signal?: AbortSignal
}

export type TtsAudio = { bytes: Uint8Array; contentType: string | null }

/** A non-2xx answer: the status and whatever the vendor said about it. */
export class TtsHttpError extends Error {
  constructor(
    readonly status: number,
    /** `detail.status` of the vendor's envelope, or the first validation error's `type`. */
    readonly code: string | undefined,
    readonly body: unknown,
  ) {
    super(`ElevenLabs answered ${status}${code ? ` (${code})` : ""}`)
    this.name = "TtsHttpError"
  }
}

/** The identifier in either error body: `{detail: {status}}` or `{detail: [{type}]}`. */
const errorCode = (body: unknown): string | undefined => {
  const detail = (body as { detail?: unknown } | null)?.detail
  if (Array.isArray(detail)) return (detail[0] as { type?: string } | undefined)?.type
  if (typeof detail === "object" && detail !== null) return (detail as { status?: string }).status
  return undefined
}

export class ElevenLabsTtsAdapter {
  constructor(
    private readonly config: {
      /** Includes the version: `https://api.elevenlabs.io/v1`. */
      baseUrl: string
      apiKey: string | undefined
      fetch: Fetch
      /** Extra headers on every call (the suite's namespace carrier, when it uses one). */
      headers?: Record<string, string>
    },
  ) {}

  async synthesize(request: TtsRequest): Promise<TtsAudio> {
    const wire = WIRE[request.format]
    const url = `${this.config.baseUrl}/text-to-speech/${encodeURIComponent(request.voiceId)}?output_format=${wire.outputFormat}`
    const response = await this.config.fetch(
      new Request(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: wire.accept,
          ...(this.config.apiKey !== undefined ? { "xi-api-key": this.config.apiKey } : {}),
          ...this.config.headers,
        },
        body: JSON.stringify({ text: request.text, model_id: request.modelId }),
        ...(request.signal ? { signal: request.signal } : {}),
      }),
    )
    if (!response.ok) {
      const raw = await response.text()
      let body: unknown = raw
      try {
        body = JSON.parse(raw)
      } catch {
        // Not JSON: keep the text.
      }
      throw new TtsHttpError(response.status, errorCode(body), body)
    }
    return {
      bytes: new Uint8Array(await response.arrayBuffer()),
      contentType: response.headers.get("content-type"),
    }
  }
}

/**
 * The retry a suite wraps around the adapter to exercise failure handling: a dropped
 * connection, a 429 and a 5xx are retried, any other 4xx is not. This is the test's own
 * policy, not a claim about the consumer's.
 */
export const withRetry = async <T>(attempt: () => Promise<T>, retries = 1): Promise<T> => {
  for (let tries = 0; ; tries++) {
    try {
      return await attempt()
    } catch (error) {
      const retryable =
        !(error instanceof TtsHttpError) || error.status === 429 || error.status >= 500
      if (!retryable || tries >= retries) throw error
    }
  }
}

/** A read-through audio cache keyed by the whole request, as a caching layer would keep. */
export class CachedTts {
  private readonly cache = new Map<string, TtsAudio>()

  constructor(private readonly adapter: ElevenLabsTtsAdapter) {}

  async synthesize(request: TtsRequest): Promise<TtsAudio> {
    const key = JSON.stringify([request.voiceId, request.modelId, request.format, request.text])
    const cached = this.cache.get(key)
    if (cached) return cached
    const audio = await this.adapter.synthesize(request)
    this.cache.set(key, audio)
    return audio
  }
}
