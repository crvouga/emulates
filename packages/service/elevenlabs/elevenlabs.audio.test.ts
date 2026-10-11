import { describe, expect, test } from "bun:test"
import { fcParameters } from "@crvouga/mockingbird-testing"
import fc from "fast-check"
import {
  describeFormat,
  durationFor,
  OUTPUT_FORMATS,
  synthesize,
  toneFor,
  toneHz,
} from "./src/audio.js"
import { parseMp3 } from "./test/mp3.js"

const params = fcParameters(process.env)
const formats = (codec: string) => OUTPUT_FORMATS.filter((format) => format.startsWith(codec))
const audio = (format: (typeof OUTPUT_FORMATS)[number], durationMs: number, line: number) => {
  const bytes = synthesize(format, durationMs, line)
  if (!bytes) throw new Error(`no audio for ${format}`)
  return bytes
}

/** Signed 16-bit little-endian samples. */
const samplesOf = (bytes: Uint8Array): number[] => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return Array.from({ length: bytes.length / 2 }, (_, i) => view.getInt16(i * 2, true))
}

/** Frequency of a steady tone, from its zero crossings. */
const pitchOf = (samples: number[], sampleRate: number): number => {
  let crossings = 0
  for (let i = 1; i < samples.length; i++) {
    if ((samples[i - 1] as number) < 0 !== (samples[i] as number) < 0) crossings++
  }
  return crossings / 2 / (samples.length / sampleRate)
}

describe("mp3_* answers are whole MPEG Layer III streams", () => {
  test("every byte of every format belongs to a complete frame that says what the format name says", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...formats("mp3")),
        fc.integer({ min: 1, max: 5_000 }),
        fc.integer({ min: 4, max: 15 }),
        (format, durationMs, line) => {
          const info = describeFormat(format)
          const bytes = audio(format, durationMs, line)
          // parseMp3 throws on a lost sync word, a reserved value, a truncated frame, side
          // information that overruns its frame, or Huffman data of the wrong length.
          const frames = parseMp3(bytes)
          expect(frames.length).toBeGreaterThan(0)
          for (const frame of frames) {
            expect(frame.sampleRate).toBe(info.sampleRate)
            expect(frame.bitrate).toBe(info.bitrate as number)
            expect(frame.channels).toBe(1)
            expect(frame.mpeg).toBe(info.sampleRate >= 32_000 ? 1 : 2)
            // One spectral line per granule: a tone, not silence and not noise.
            for (const lines of frame.lines) expect(lines).toEqual([line])
          }
          // Frame lengths add up to the stream, with nothing before, between or after them.
          expect(frames.reduce((sum, frame) => sum + frame.length, 0)).toBe(bytes.length)
          expect(frames[0]?.offset).toBe(0)
          // The frames cover the requested duration, to within one frame.
          const samples = frames.reduce((sum, frame) => sum + frame.samples, 0)
          const wanted = (info.sampleRate * durationMs) / 1000
          expect(samples).toBeGreaterThanOrEqual(wanted)
          expect(samples - wanted).toBeLessThan(frames[0]?.samples as number)
        },
      ),
      params,
    )
  })

  test("mp3_44100_128 is MPEG-1 at 44.1 kHz whose padded frames average 128 kbit/s", () => {
    const frames = parseMp3(audio("mp3_44100_128", 5_000, 11))
    expect(frames).toHaveLength(Math.ceil((44_100 * 5) / 1152))
    // 144 * 128000 / 44100 = 417.96 bytes: frames are 417 or 418, padded ones marked.
    expect(new Set(frames.map((frame) => frame.length))).toEqual(new Set([417, 418]))
    for (const frame of frames) expect(frame.length).toBe(frame.padding ? 418 : 417)
    const seconds = (frames.length * 1152) / 44_100
    const bytes = frames.reduce((sum, frame) => sum + frame.length, 0)
    // Within one byte of the nominal rate over the whole stream.
    expect(Math.abs(bytes - (128_000 / 8) * seconds)).toBeLessThan(1)
  })

  test("a truncated or corrupted stream is rejected by the reader these tests rely on", () => {
    const bytes = audio("mp3_44100_128", 500, 11)
    expect(() => parseMp3(bytes.slice(0, bytes.length - 1))).toThrow(/needs 41[78] bytes/)
    const lostSync = bytes.slice()
    lostSync[417] = 0x00
    expect(() => parseMp3(lostSync)).toThrow()
    // A real header in front of junk, which is what the consumer's old stub returned.
    const junk = new Uint8Array(417).fill(0xaa)
    junk.set(bytes.slice(0, 4))
    expect(() => parseMp3(junk)).toThrow()
  })
})

describe("pcm_* answers are headerless samples", () => {
  test("every format is a whole number of 16-bit mono samples at its sample rate", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...formats("pcm")),
        fc.integer({ min: 1, max: 5_000 }),
        fc.integer({ min: 4, max: 15 }),
        (format, durationMs, line) => {
          const { sampleRate } = describeFormat(format)
          const bytes = audio(format, durationMs, line)
          expect(bytes.length % 2).toBe(0)
          expect(bytes.length / 2).toBe(Math.max(1, Math.round((sampleRate * durationMs) / 1000)))
          // Raw samples begin at once: no RIFF, no ID3, no frame sync.
          expect(new TextDecoder().decode(bytes.slice(0, 4))).not.toBe("RIFF")
          expect(samplesOf(bytes)[0]).toBe(0)
        },
      ),
      params,
    )
  })

  test("pcm_44100 holds one second of a quarter-scale tone at the requested pitch", () => {
    const samples = samplesOf(audio("pcm_44100", 1_000, 11))
    expect(samples).toHaveLength(44_100)
    const peak = Math.max(...samples.map(Math.abs))
    expect(peak).toBeGreaterThan(8_000)
    expect(peak).toBeLessThanOrEqual(8_192)
    expect(Math.abs(pitchOf(samples, 44_100) - toneHz(11))).toBeLessThan(2)
  })

  test("wav_* is the same samples behind a 44-byte RIFF header that describes them", () => {
    for (const format of formats("wav")) {
      const { sampleRate } = describeFormat(format)
      const wav = audio(format, 300, 7)
      const pcm = audio(`pcm_${sampleRate}` as (typeof OUTPUT_FORMATS)[number], 300, 7)
      const view = new DataView(wav.buffer)
      const tag = (offset: number) => new TextDecoder().decode(wav.slice(offset, offset + 4))
      expect([tag(0), tag(8), tag(12), tag(36)]).toEqual(["RIFF", "WAVE", "fmt ", "data"])
      expect(view.getUint32(4, true)).toBe(wav.length - 8)
      expect(view.getUint16(20, true)).toBe(1) // PCM
      expect(view.getUint16(22, true)).toBe(1) // mono
      expect(view.getUint32(24, true)).toBe(sampleRate)
      expect(view.getUint32(28, true)).toBe(sampleRate * 2)
      expect(view.getUint16(34, true)).toBe(16)
      expect(view.getUint32(40, true)).toBe(pcm.length)
      expect(wav.slice(44)).toEqual(pcm.slice())
    }
  })
})

describe("what the generator does not cover", () => {
  test("opus, mu-law and A-law have no generated audio; every other vendor format does", () => {
    const missing = OUTPUT_FORMATS.filter((format) => synthesize(format, 250, 4) === undefined)
    expect(missing).toEqual([
      "alaw_8000",
      "opus_48000_128",
      "opus_48000_192",
      "opus_48000_32",
      "opus_48000_64",
      "opus_48000_96",
      "ulaw_8000",
    ])
    for (const format of OUTPUT_FORMATS) {
      expect(describeFormat(format).synthesized).toBe(!missing.includes(format))
    }
  })

  test("duration follows the text length between a quarter second and five seconds", () => {
    expect(durationFor(0)).toBe(250)
    expect(durationFor(20)).toBe(1_000)
    expect(durationFor(10_000)).toBe(5_000)
  })

  test("the tone is a function of the request fingerprint, within the first subband", () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[0-9a-f]{64}$/), (fingerprint) => {
        const line = toneFor(fingerprint)
        expect(line).toBe(toneFor(fingerprint))
        expect(line).toBeGreaterThanOrEqual(4)
        expect(line).toBeLessThanOrEqual(15)
      }),
      params,
    )
  })
})
