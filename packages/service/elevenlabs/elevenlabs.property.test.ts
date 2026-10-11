import { describe, expect, test } from "bun:test"
import { type JsonValue, listOperations } from "@crvouga/mockingbird-openapi"
import { ParityError, parity } from "@crvouga/mockingbird-parity"
import { fcParameters } from "@crvouga/mockingbird-testing"
import fc from "fast-check"
import {
  DEFAULT_API_KEY,
  DEFAULT_VOICES,
  document,
  ElevenLabsAPI,
  supportedOperationIds,
} from "./src/index.js"

const params = fcParameters(process.env)
const MOCK_HOST = "mock.elevenlabs.local"
const now = () => 1_700_000_000_000
const headers = () => ({ "xi-api-key": DEFAULT_API_KEY })

/**
 * The contract leaves the voice and the model as free strings, so a random walk would only
 * ever meet 404. Narrow them to the configured fixtures plus one unknown of each, and give
 * the walk bodies that reach every answer the operation declares.
 */
const narrowed = (bodies: JsonValue[], voices: string[], formats: string[]) => {
  const spec = structuredClone(document)
  for (const operation of listOperations(spec)) {
    operation.operation.requestBody = {
      required: true,
      content: { "application/json": { schema: { enum: bodies } } },
    }
    for (const parameter of operation.operation.parameters ?? []) {
      if (!("schema" in parameter)) continue
      if (parameter.name === "voice_id") parameter.schema = { type: "string", enum: voices }
      if (parameter.name === "output_format") parameter.schema = { type: "string", enum: formats }
    }
  }
  return spec
}
const VOICE = DEFAULT_VOICES[0]?.voice_id as string
const spec = narrowed(
  [
    { text: "fixture line" },
    { text: "another fixture line", model_id: "eleven_flash_v2_5" },
    { text: "fixture line", model_id: "fixture-missing-model" },
    { text: "fixture line", model_id: "fixture-mute-model" },
    { text: "" },
    { text: 7 },
    {},
  ],
  [VOICE, "fixture-missing-voice"],
  ["mp3_44100_128", "pcm_44100", "wav_44100", "mp3_22050_32", "opus_48000_64", "mp3"],
)
/** Every request this contract generates is answered with audio. */
const audioOnly = narrowed([{ text: "fixture line" }], [VOICE], ["mp3_44100_128", "pcm_44100"])

const create = () =>
  new ElevenLabsAPI({
    now,
    models: [
      { model_id: "eleven_multilingual_v2" },
      { model_id: "eleven_flash_v2_5" },
      { model_id: "fixture-mute-model", can_do_text_to_speech: false },
    ],
  })

describe("ElevenLabsAPI", () => {
  test(
    "self-parity: independent instances agree on every random walk and conform to the spec",
    async () => {
      const reference = create()
      const statuses = new Set<number>()
      const report = await parity({
        provider: "elevenlabs",
        spec,
        real: {
          baseUrl: `https://${MOCK_HOST}`,
          allowedHosts: [MOCK_HOST],
          headers,
          fetch: async (request) => {
            const response = await reference.fetch(request)
            statuses.add(response.status)
            return response
          },
        },
        mock: { create, baseUrl: `https://${MOCK_HOST}`, headers },
        cleanup: async () => {
          await reference.reset()
        },
        includeUnsafe: true,
        numRuns: params.numRuns ?? 25,
        maxCommands: 20,
        latencyToleranceMs: 1_000,
        ...(params.seed === undefined ? {} : { seed: params.seed }),
        env: process.env,
        sleep: async () => {},
        log: () => {},
      })
      expect(report.walks).toBeGreaterThan(0)
      expect(Object.keys(report.exercised).sort()).toEqual([...supportedOperationIds].sort())
      // At the default size the walks reach audio and each kind of rejection, not one corner
      // of the contract. A replay with FC_NUM_RUNS may be too short to promise that.
      if (params.numRuns === undefined) {
        expect([...statuses]).toEqual(expect.arrayContaining([200, 400, 404, 422]))
      }
    },
    { timeout: 120_000 },
  )

  test(
    "a deliberately divergent instance is caught and shrunk",
    async () => {
      await fc.assert(
        fc.asyncProperty(fc.integer(), async (seed) => {
          const reference = create()
          const faulty = () => {
            const api = create()
            return {
              fetch: async (request: Request) => {
                const response = await api.fetch(request)
                if (response.status !== 200) return response
                // Diverge: audio comes back under another content type.
                return new Response(await response.arrayBuffer(), {
                  status: 200,
                  headers: { "content-type": "audio/wav" },
                })
              },
            }
          }
          const failure = await parity({
            provider: "elevenlabs",
            spec: audioOnly,
            real: {
              baseUrl: `https://${MOCK_HOST}`,
              allowedHosts: [MOCK_HOST],
              headers,
              fetch: (request) => reference.fetch(request),
            },
            mock: { create: faulty, baseUrl: `https://${MOCK_HOST}`, headers },
            cleanup: async () => {
              await reference.reset()
            },
            includeUnsafe: true,
            numRuns: 20,
            maxCommands: 5,
            seed,
            invalidProbability: 0,
            // Both sides are in-process: only the content type may fail this walk.
            latencyToleranceMs: 1_000,
            sleep: async () => {},
            log: () => {},
          }).then(
            () => undefined,
            (error: unknown) => error,
          )
          expect(failure).toBeInstanceOf(ParityError)
          expect((failure as ParityError).details.kind).toBe("mismatch")
        }),
        { ...params, numRuns: 3 },
      )
    },
    { timeout: 60_000 },
  )
})
