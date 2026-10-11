/**
 * Live parity: the same random walk against the real ElevenLabs API and a fresh mock,
 * canonicalized and diffed. The credential comes from the environment (`.env.local` locally,
 * repo secrets in the Parity workflow):
 *
 *   ELEVENLABS_API_KEY
 *
 * Two optional settings, read from the environment as they are:
 *
 *   ELEVENLABS_VOICE_ID   a voice the key may use (default: the id in the vendor's examples)
 *   ELEVENLABS_API_URL    default https://api.elevenlabs.io
 *
 * ElevenLabs bills every character it converts, so by default the walk only sends requests
 * the vendor rejects before it synthesizes anything: bodies that fail validation, and
 * well-formed requests for a voice that does not exist. `--include-unsafe` adds real
 * conversions of one short line to MP3 and PCM (a few dozen characters per walk; keep
 * `FC_NUM_RUNS` small). Audio bytes compare as "present"; status, error bodies and the
 * `content-type` and `character-cost` headers are compared exactly.
 */
import { CredentialError, createRedactor, loadCredentials } from "@crvouga/mockingbird-credentials"
import { type JsonValue, listOperations } from "@crvouga/mockingbird-openapi"
import { parity } from "@crvouga/mockingbird-parity"
import { DEFAULT_API_KEY, DEFAULT_VOICES, document, ElevenLabsAPI } from "../src/index.js"

let credentials: Awaited<ReturnType<typeof loadCredentials>>
try {
  credentials = await loadCredentials(
    {
      provider: "elevenlabs",
      fields: {
        ELEVENLABS_API_KEY: "ELEVENLABS_API_KEY",
      },
    },
    { env: process.env },
  )
} catch (error) {
  if (error instanceof CredentialError) {
    console.error(`elevenlabs parity: no API key. ${error.message}`)
    process.exit(2)
  }
  throw error
}

const includeUnsafe = process.argv.includes("--include-unsafe")
const baseUrl = (process.env.ELEVENLABS_API_URL || "https://api.elevenlabs.io").replace(/\/$/, "")
const voice = process.env.ELEVENLABS_VOICE_ID || (DEFAULT_VOICES[0]?.voice_id as string)
const MISSING_VOICE = "mockingbird-parity-missing-voice"
const LINE = "Mockingbird parity."

// Requests no characters are billed for: the body fails validation, or the voice is unknown.
const unbilled: JsonValue[] = [{}, { text: 5 }, { text: LINE, model_id: 7 }, { text: LINE }]
// With a real voice: a conversion, and the rejections that need one to be reached.
const billed: JsonValue[] = [
  { text: LINE },
  { text: "" },
  { text: LINE, model_id: "mockingbird-parity-missing-model" },
]

const spec = structuredClone(document)
for (const operation of listOperations(spec)) {
  operation.operation.requestBody = {
    required: true,
    content: {
      "application/json": { schema: { enum: includeUnsafe ? [...unbilled, ...billed] : unbilled } },
    },
  }
  // With the voice pinned to one that does not exist, the operation has no side effect.
  if (!includeUnsafe) {
    operation.operation["x-mockingbird"] = {
      supported: true,
      parity: { enabled: true, safe: true },
    }
  }
  for (const parameter of operation.operation.parameters ?? []) {
    if (!("schema" in parameter)) continue
    if (parameter.name === "voice_id") {
      parameter.schema = {
        type: "string",
        enum: includeUnsafe ? [voice, MISSING_VOICE] : [MISSING_VOICE],
      }
    }
    if (parameter.name === "output_format") {
      parameter.schema = { type: "string", enum: ["mp3_44100_128", "pcm_44100", "mockingbird"] }
    }
  }
}

try {
  await parity({
    provider: "elevenlabs",
    spec,
    env: process.env,
    includeUnsafe,
    invalidProbability: 0,
    ...(process.env.FC_NUM_RUNS ? {} : { numRuns: 3 }),
    ...(process.env.MOCKINGBIRD_MAX_COMMANDS ? {} : { maxCommands: 6 }),
    real: {
      baseUrl,
      allowedHosts: [new URL(baseUrl).host],
      headers: () => ({ "xi-api-key": credentials.values.ELEVENLABS_API_KEY }),
      minIntervalMs: 500,
    },
    mock: {
      create: () => new ElevenLabsAPI({ voices: [{ voice_id: voice }] }),
      headers: () => ({ "xi-api-key": DEFAULT_API_KEY }),
    },
    redact: createRedactor(credentials.secrets),
  })
} catch (error) {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
