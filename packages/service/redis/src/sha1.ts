/** SHA-1, lowercase hex. Used for EVALSHA / SCRIPT LOAD. No WebAssembly. */

const K = [0x5a827999, 0x6ed9eba1, 0x8f1bbcdc, 0xca62c1d6] as const

function rotl(value: number, bits: number): number {
  return ((value << bits) | (value >>> (32 - bits))) >>> 0
}

export function sha1Hex(data: Uint8Array): string {
  const bitLength = data.length * 8
  const padded = new Uint8Array(((data.length + 9 + 63) & ~63) >>> 0)
  padded.set(data)
  padded[data.length] = 0x80
  const view = new DataView(padded.buffer)
  view.setUint32(padded.length - 8, Math.floor(bitLength / 0x100000000), false)
  view.setUint32(padded.length - 4, bitLength >>> 0, false)

  let h0 = 0x67452301
  let h1 = 0xefcdab89
  let h2 = 0x98badcfe
  let h3 = 0x10325476
  let h4 = 0xc3d2e1f0
  const w = new Uint32Array(80)

  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4, false)
    for (let i = 16; i < 80; i++) {
      w[i] = rotl((w[i - 3] ?? 0) ^ (w[i - 8] ?? 0) ^ (w[i - 14] ?? 0) ^ (w[i - 16] ?? 0), 1)
    }
    let a = h0
    let b = h1
    let c = h2
    let d = h3
    let e = h4
    for (let i = 0; i < 80; i++) {
      const stage = Math.floor(i / 20)
      let f = 0
      if (stage === 0) f = (b & c) | (~b & d)
      else if (stage === 1 || stage === 3) f = b ^ c ^ d
      else f = (b & c) | (b & d) | (c & d)
      const temp = (rotl(a, 5) + f + e + (K[stage] ?? 0) + (w[i] ?? 0)) >>> 0
      e = d
      d = c
      c = rotl(b, 30)
      b = a
      a = temp
    }
    h0 = (h0 + a) >>> 0
    h1 = (h1 + b) >>> 0
    h2 = (h2 + c) >>> 0
    h3 = (h3 + d) >>> 0
    h4 = (h4 + e) >>> 0
  }

  return [h0, h1, h2, h3, h4].map((part) => part.toString(16).padStart(8, "0")).join("")
}
