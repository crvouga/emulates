/** Portable MD5 for AWS wire checksums (not a security primitive). */
export const awsMd5 = (value: string | Uint8Array) => {
  const source = typeof value === "string" ? new TextEncoder().encode(value) : value
  const length = Math.ceil((source.length + 9) / 64) * 64
  const bytes = new Uint8Array(length)
  bytes.set(source)
  bytes[source.length] = 0x80
  const view = new DataView(bytes.buffer)
  const bits = BigInt(source.length) * 8n
  view.setUint32(length - 8, Number(bits & 0xffffffffn), true)
  view.setUint32(length - 4, Number(bits >> 32n), true)
  let a0 = 0x67452301
  let b0 = 0xefcdab89
  let c0 = 0x98badcfe
  let d0 = 0x10325476
  const shifts = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21]
  const add = (left: number, right: number) => (left + right) >>> 0
  for (let offset = 0; offset < length; offset += 64) {
    let a = a0
    let b = b0
    let c = c0
    let d = d0
    for (let i = 0; i < 64; i++) {
      let f: number
      let g: number
      if (i < 16) {
        f = (b & c) | (~b & d)
        g = i
      } else if (i < 32) {
        f = (d & b) | (~d & c)
        g = (5 * i + 1) % 16
      } else if (i < 48) {
        f = b ^ c ^ d
        g = (3 * i + 5) % 16
      } else {
        f = c ^ (b | ~d)
        g = (7 * i) % 16
      }
      const sum = add(
        add(add(a, f), Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32)),
        view.getUint32(offset + g * 4, true),
      )
      const shift = shifts[Math.floor(i / 16) * 4 + (i % 4)] as number
      ;[a, b, c, d] = [d, add(b, (sum << shift) | (sum >>> (32 - shift))), b, c]
    }
    a0 = add(a0, a)
    b0 = add(b0, b)
    c0 = add(c0, c)
    d0 = add(d0, d)
  }
  return [a0, b0, c0, d0]
    .flatMap((word) => [word & 255, (word >>> 8) & 255, (word >>> 16) & 255, (word >>> 24) & 255])
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
}
