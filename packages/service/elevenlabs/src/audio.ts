/**
 * Deterministic synthetic audio standing in for generated speech. Nothing here is speech:
 * every default answer is a single tone whose pitch and length are functions of the request,
 * encoded exactly as the requested `output_format` says.
 *
 * - `mp3_*` is a run of complete MPEG Layer III frames, mono, constant bitrate, with the
 *   padding bit keeping the stream at the nominal rate: MPEG-1 (1152 samples per frame) at
 *   32/44.1/48 kHz and MPEG-2 (576 samples) at 22.05/24 kHz. Each granule Huffman-codes one
 *   spectral line, so a decoder (ffmpeg, mpg123) produces an audible tone, not silence.
 * - `pcm_*` is raw signed 16-bit little-endian mono samples: no container, no header.
 * - `wav_*` is the same samples behind a canonical 44-byte RIFF/WAVE header.
 */

/** Every `output_format` the vendor's API reference lists for text to speech. */
export const OUTPUT_FORMATS = [
  "alaw_8000",
  "mp3_22050_32",
  "mp3_24000_48",
  "mp3_44100_128",
  "mp3_44100_192",
  "mp3_44100_32",
  "mp3_44100_64",
  "mp3_44100_96",
  "opus_48000_128",
  "opus_48000_192",
  "opus_48000_32",
  "opus_48000_64",
  "opus_48000_96",
  "pcm_16000",
  "pcm_22050",
  "pcm_24000",
  "pcm_32000",
  "pcm_44100",
  "pcm_48000",
  "pcm_8000",
  "ulaw_8000",
  "wav_16000",
  "wav_22050",
  "wav_24000",
  "wav_32000",
  "wav_44100",
  "wav_48000",
  "wav_8000",
] as const

export type OutputFormat = (typeof OUTPUT_FORMATS)[number]

/** What the vendor answers with when the query names no format. */
export const DEFAULT_OUTPUT_FORMAT: OutputFormat = "mp3_44100_128"

export type Codec = "mp3" | "pcm" | "wav" | "opus" | "ulaw" | "alaw"

export type FormatInfo = {
  format: OutputFormat
  codec: Codec
  sampleRate: number
  /** kbit/s, for the codecs that carry one in the format name. */
  bitrate?: number
  /** The `content-type` the mock answers with (only `audio/mpeg` is in the vendor's reference). */
  contentType: string
  /** Whether the mock can produce this format itself; the rest need a queued script. */
  synthesized: boolean
}

const CONTENT_TYPES: Record<Codec, string> = {
  mp3: "audio/mpeg",
  pcm: "audio/pcm",
  wav: "audio/wav",
  opus: "audio/opus",
  ulaw: "audio/basic",
  alaw: "audio/x-alaw-basic",
}

export const isOutputFormat = (value: string): value is OutputFormat =>
  (OUTPUT_FORMATS as readonly string[]).includes(value)

/** Codec, sample rate and bitrate a format name encodes (`codec_sampleRate[_bitrate]`). */
export const describeFormat = (format: OutputFormat): FormatInfo => {
  const [codec, sampleRate, bitrate] = format.split("_") as [Codec, string, string | undefined]
  return {
    format,
    codec,
    sampleRate: Number(sampleRate),
    ...(bitrate !== undefined ? { bitrate: Number(bitrate) } : {}),
    contentType: CONTENT_TYPES[codec],
    synthesized: codec === "mp3" || codec === "pcm" || codec === "wav",
  }
}

/** Milliseconds of audio per character of text. */
export const MS_PER_CHARACTER = 50
const MIN_DURATION_MS = 250
const MAX_DURATION_MS = 5_000

/** Length of the audio standing in for a text of `characters` characters (0.25 s to 5 s). */
export const durationFor = (characters: number): number =>
  Math.min(MAX_DURATION_MS, Math.max(MIN_DURATION_MS, characters * MS_PER_CHARACTER))

/** Spectral lines the tone may sit on: all inside the first Layer III subband. */
const FIRST_LINE = 4
const LINES = 12

/** Spacing of Layer III spectral lines at 44.1 kHz: the pitch grid of every default tone. */
const LINE_HZ = 44_100 / 1_152

/** The tone a request gets, picked from its fingerprint (a hex digest). */
export const toneFor = (fingerprint: string): number =>
  FIRST_LINE + (Number.parseInt(fingerprint.slice(0, 8), 16) % LINES)

/** Frequency in Hz of tone `line` in the PCM and WAV answers. */
export const toneHz = (line: number): number => (line + 0.5) * LINE_HZ

/** Raw PCM: signed 16-bit little-endian, mono, no header. */
export const pcmAudio = (sampleRate: number, durationMs: number, line: number): Uint8Array => {
  const samples = Math.max(1, Math.round((sampleRate * durationMs) / 1000))
  const out = new Uint8Array(samples * 2)
  const view = new DataView(out.buffer)
  const step = (2 * Math.PI * toneHz(line)) / sampleRate
  for (let i = 0; i < samples; i++) {
    view.setInt16(i * 2, Math.round(Math.sin(step * i) * 0.25 * 32767), true)
  }
  return out
}

/** The PCM samples behind a 44-byte RIFF/WAVE header (format 1, mono, 16 bit). */
export const wavAudio = (sampleRate: number, durationMs: number, line: number): Uint8Array => {
  const pcm = pcmAudio(sampleRate, durationMs, line)
  const out = new Uint8Array(44 + pcm.length)
  const view = new DataView(out.buffer)
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) out[offset + i] = text.charCodeAt(i)
  }
  ascii(0, "RIFF")
  view.setUint32(4, 36 + pcm.length, true)
  ascii(8, "WAVE")
  ascii(12, "fmt ")
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, 1, true) // mono
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true) // byte rate
  view.setUint16(32, 2, true) // block align
  view.setUint16(34, 16, true) // bits per sample
  ascii(36, "data")
  view.setUint32(40, pcm.length, true)
  out.set(pcm, 44)
  return out
}

type Mpeg = {
  /** Header version bits: `11` MPEG-1, `10` MPEG-2. */
  version: number
  sampleRateIndex: number
  /** kbit/s by bitrate index (index 0 is "free format", unused here). */
  bitrates: readonly number[]
  samplesPerFrame: number
  /** Side information bytes for one mono frame. */
  sideInfoBytes: number
  granules: number
}

const MPEG1_BITRATES = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]
const MPEG2_BITRATES = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160]

const mpeg1 = (sampleRateIndex: number): Mpeg => ({
  version: 0b11,
  sampleRateIndex,
  bitrates: MPEG1_BITRATES,
  samplesPerFrame: 1152,
  sideInfoBytes: 17,
  granules: 2,
})
const mpeg2 = (sampleRateIndex: number): Mpeg => ({
  version: 0b10,
  sampleRateIndex,
  bitrates: MPEG2_BITRATES,
  samplesPerFrame: 576,
  sideInfoBytes: 9,
  granules: 1,
})

const MPEG_BY_RATE: Record<number, Mpeg> = {
  44100: mpeg1(0),
  48000: mpeg1(1),
  32000: mpeg1(2),
  22050: mpeg2(0),
  24000: mpeg2(1),
  16000: mpeg2(2),
}

/** Most-significant-bit-first writer over a zeroed buffer. */
const bitWriter = (target: Uint8Array, startByte: number) => {
  let position = startByte * 8
  return (value: number, bits: number) => {
    for (let bit = bits - 1; bit >= 0; bit--) {
      if ((value >> bit) & 1) {
        target[position >> 3] = (target[position >> 3] ?? 0) | (0x80 >> (position & 7))
      }
      position++
    }
  }
}

/**
 * Huffman table 1 codes for a pair of spectral values, each 0 or 1 (ISO/IEC 11172-3 table
 * B.7): `[code, length]` indexed by `x * 2 + y`. A sign bit follows each non-zero value.
 */
const TABLE_1: readonly (readonly [number, number])[] = [
  [0b1, 1],
  [0b001, 3],
  [0b01, 2],
  [0b000, 3],
]

/** `2 ^ ((GAIN - 210) / 4)` scales the one coded line: about a quarter of full scale. */
const GLOBAL_GAIN = 202

/**
 * A stationary tone on line `k` turns by `pi * (k + 0.5)` between granules, so its transform
 * coefficient cycles through these signs: holding the magnitude and following the cycle
 * decodes to a steady tone instead of a warble.
 */
const signOf = (line: number, granule: number): number =>
  (line % 2 === 0 ? [0, 1, 1, 0] : [0, 0, 1, 1])[granule % 4] as number

/** MPEG Layer III frames, mono, constant `bitrate` kbit/s, covering `durationMs`. */
export const mp3Audio = (
  sampleRate: number,
  bitrate: number,
  durationMs: number,
  line: number,
): Uint8Array => {
  const mpeg = MPEG_BY_RATE[sampleRate]
  const bitrateIndex = mpeg ? mpeg.bitrates.indexOf(bitrate) : -1
  if (!mpeg || bitrateIndex < 1) {
    throw new RangeError(`no MPEG Layer III stream at ${sampleRate} Hz, ${bitrate} kbit/s`)
  }
  const frames = Math.max(1, Math.ceil((sampleRate * durationMs) / 1000 / mpeg.samplesPerFrame))
  // Bytes per frame is rarely whole (417.96 at 44.1 kHz, 128 kbit/s): the padding bit adds a
  // byte to just enough frames that the stream keeps its nominal bitrate.
  const numerator = (mpeg.samplesPerFrame / 8) * bitrate * 1000
  const base = Math.floor(numerator / sampleRate)
  const remainder = numerator % sampleRate
  const pair = line >> 1
  const [code, length] = TABLE_1[line % 2 === 0 ? 2 : 1] as readonly [number, number]
  const granuleBits = pair + length + 1
  const chunks: Uint8Array[] = []
  let owed = 0
  let granule = 0
  let total = 0
  for (let index = 0; index < frames; index++) {
    owed += remainder
    const padding = owed >= sampleRate ? 1 : 0
    if (padding) owed -= sampleRate
    const frame = new Uint8Array(base + padding)
    frame[0] = 0xff
    frame[1] = 0xe0 | (mpeg.version << 3) | (0b01 << 1) | 1 // sync, version, Layer III, no CRC
    frame[2] = (bitrateIndex << 4) | (mpeg.sampleRateIndex << 2) | (padding << 1)
    frame[3] = 0b11 << 6 // single channel
    const side = bitWriter(frame, 4)
    // main_data_begin 0: each frame's audio starts right after its own side information.
    if (mpeg.granules === 2) {
      side(0, 9) // main_data_begin
      side(0, 5) // private_bits
      side(0, 4) // scfsi
    } else {
      side(0, 8) // main_data_begin
      side(0, 1) // private_bits
    }
    for (let g = 0; g < mpeg.granules; g++) {
      side(granuleBits, 12) // part2_3_length
      side(pair + 1, 9) // big_values
      side(GLOBAL_GAIN, 8)
      side(0, mpeg.granules === 2 ? 4 : 9) // scalefac_compress: no scale factor bits
      side(0, 1) // window_switching_flag: long blocks
      side(1, 5) // table_select, region 0
      side(1, 5) // region 1
      side(1, 5) // region 2
      side(0, 4) // region0_count
      side(0, 3) // region1_count
      if (mpeg.granules === 2) side(0, 1) // preflag
      side(0, 1) // scalefac_scale
      side(0, 1) // count1table_select
    }
    const main = bitWriter(frame, 4 + mpeg.sideInfoBytes)
    for (let g = 0; g < mpeg.granules; g++) {
      for (let zero = 0; zero < pair; zero++) main(1, 1)
      main(code, length)
      main(signOf(line, granule++), 1)
    }
    chunks.push(frame)
    total += frame.length
  }
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}

/**
 * The default answer for a format, or `undefined` for the codecs the mock does not encode
 * (`opus_*`, `ulaw_8000`, `alaw_8000`).
 */
export const synthesize = (
  format: OutputFormat,
  durationMs: number,
  line: number,
): Uint8Array | undefined => {
  const info = describeFormat(format)
  if (info.codec === "mp3") return mp3Audio(info.sampleRate, info.bitrate ?? 0, durationMs, line)
  if (info.codec === "pcm") return pcmAudio(info.sampleRate, durationMs, line)
  if (info.codec === "wav") return wavAudio(info.sampleRate, durationMs, line)
  return undefined
}
