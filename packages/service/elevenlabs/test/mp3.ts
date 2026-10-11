/**
 * An MPEG audio stream reader for the tests, written from the frame layout in ISO/IEC 11172-3
 * and 13818-3 and sharing no code with the generator in `src/audio.ts`. It walks a byte stream
 * frame by frame and throws on anything a decoder would choke on: a lost sync word, a reserved
 * header value, a frame cut short, side information that points outside its frame, or Huffman
 * data that does not end where the side information says it does.
 */

export type Mp3Frame = {
  offset: number
  /** Bytes in the frame, header included. */
  length: number
  mpeg: 1 | 2
  bitrate: number
  sampleRate: number
  padding: boolean
  channels: 1 | 2
  samples: number
  /** Spectral lines the frame's granules code as non-zero, one list per granule. */
  lines: number[][]
}

const BITRATES: Record<1 | 2, readonly number[]> = {
  1: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
}
const SAMPLE_RATES: Record<1 | 2, readonly number[]> = {
  1: [44100, 48000, 32000],
  2: [22050, 24000, 16000],
}

const bitReader = (bytes: Uint8Array, startByte: number) => {
  let position = startByte * 8
  return {
    read(bits: number): number {
      let value = 0
      for (let i = 0; i < bits; i++) {
        const byte = bytes[position >> 3]
        if (byte === undefined) throw new Error("read past the end of the stream")
        value = (value << 1) | ((byte >> (7 - (position & 7))) & 1)
        position++
      }
      return value
    },
    get position() {
      return position
    },
  }
}

/** Decode one granule's `big_values` pairs with Huffman table 1; returns its non-zero lines. */
const decodeGranule = (
  reader: ReturnType<typeof bitReader>,
  bigValues: number,
  bits: number,
): number[] => {
  const end = reader.position + bits
  const lines: number[] = []
  for (let pair = 0; pair < bigValues; pair++) {
    // Table 1: `1` is (0,0), `01` is (1,0), `001` is (0,1), `000` is (1,1).
    let x = 0
    let y = 0
    if (reader.read(1) === 0) {
      if (reader.read(1) === 1) {
        x = 1
      } else {
        y = 1
        x = reader.read(1) === 1 ? 0 : 1
      }
    }
    if (x) {
      reader.read(1) // sign
      lines.push(pair * 2)
    }
    if (y) {
      reader.read(1) // sign
      lines.push(pair * 2 + 1)
    }
  }
  if (reader.position !== end) {
    throw new Error(`granule used ${reader.position - (end - bits)} bits, side info says ${bits}`)
  }
  return lines
}

/** Parse a whole stream. Every byte must belong to a complete, well-formed Layer III frame. */
export const parseMp3 = (bytes: Uint8Array): Mp3Frame[] => {
  const frames: Mp3Frame[] = []
  let offset = 0
  while (offset < bytes.length) {
    const at = `frame ${frames.length} at byte ${offset}`
    if (offset + 4 > bytes.length) throw new Error(`${at}: ${bytes.length - offset} stray bytes`)
    const header = bitReader(bytes, offset)
    if (header.read(11) !== 0x7ff) throw new Error(`${at}: no sync word`)
    const version = header.read(2)
    if (version !== 0b11 && version !== 0b10) throw new Error(`${at}: MPEG version ${version}`)
    const mpeg = version === 0b11 ? 1 : 2
    if (header.read(2) !== 0b01) throw new Error(`${at}: not Layer III`)
    const unprotected = header.read(1)
    const bitrate = BITRATES[mpeg][header.read(4)]
    const sampleRate = SAMPLE_RATES[mpeg][header.read(2)]
    if (!bitrate) throw new Error(`${at}: free-format or reserved bitrate`)
    if (!sampleRate) throw new Error(`${at}: reserved sample rate`)
    const padding = header.read(1) === 1
    header.read(1) // private
    const channels = header.read(2) === 0b11 ? 1 : 2
    header.read(4) // mode extension, copyright, original
    if (header.read(2) === 0b10) throw new Error(`${at}: reserved emphasis`)
    if (unprotected !== 1) throw new Error(`${at}: CRC-protected frames are not expected`)
    if (channels !== 1) throw new Error(`${at}: expected a single channel`)

    const samples = mpeg === 1 ? 1152 : 576
    const length = Math.floor(((samples / 8) * bitrate * 1000) / sampleRate) + (padding ? 1 : 0)
    if (offset + length > bytes.length) {
      throw new Error(`${at}: needs ${length} bytes, ${bytes.length - offset} left`)
    }

    // Side information (mono): 17 bytes in MPEG-1 (two granules), 9 in MPEG-2 (one).
    const sideBytes = mpeg === 1 ? 17 : 9
    const side = bitReader(bytes, offset + 4)
    const mainDataBegin = side.read(mpeg === 1 ? 9 : 8)
    side.read(mpeg === 1 ? 5 + 4 : 1) // private bits (and scfsi)
    if (mainDataBegin !== 0) throw new Error(`${at}: main data starts in an earlier frame`)
    const granules: { bits: number; bigValues: number }[] = []
    for (let g = 0; g < (mpeg === 1 ? 2 : 1); g++) {
      const bits = side.read(12)
      const bigValues = side.read(9)
      if (bigValues > 288) throw new Error(`${at}: big_values ${bigValues} exceeds 288`)
      side.read(8) // global_gain
      const scalefac = side.read(mpeg === 1 ? 4 : 9)
      const switching = side.read(1)
      const tables = [side.read(5), side.read(5), side.read(5)]
      side.read(4 + 3) // region counts
      side.read(mpeg === 1 ? 3 : 2) // (preflag,) scalefac_scale, count1table_select
      if (scalefac !== 0 || switching !== 0 || tables.some((table) => table !== 1)) {
        throw new Error(`${at}: this reader only decodes long blocks coded with table 1`)
      }
      granules.push({ bits, bigValues })
    }
    if (side.position !== (offset + 4 + sideBytes) * 8) throw new Error(`${at}: side info length`)
    const available = (length - 4 - sideBytes) * 8
    if (granules.reduce((sum, granule) => sum + granule.bits, 0) > available) {
      throw new Error(`${at}: main data does not fit in the frame`)
    }
    const main = bitReader(bytes, offset + 4 + sideBytes)
    const lines = granules.map((granule) => decodeGranule(main, granule.bigValues, granule.bits))

    frames.push({ offset, length, mpeg, bitrate, sampleRate, padding, channels, samples, lines })
    offset += length
  }
  return frames
}
