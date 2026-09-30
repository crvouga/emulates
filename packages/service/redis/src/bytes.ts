/** Byte helpers. Keys and Lua strings are Latin-1 so client bytes round-trip. */

export function latin1(bytes: Uint8Array): string {
  let out = ""
  for (let i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes[i] ?? 0)
  return out
}

export function fromLatin1(value: string): Uint8Array {
  const out = new Uint8Array(value.length)
  for (let i = 0; i < value.length; i++) out[i] = value.charCodeAt(i) & 0xff
  return out
}

export function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value)
}

export function utf8Text(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes)
}

export function eqBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

export function cmpBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0)
    if (d !== 0) return d
  }
  return a.length - b.length
}

const INT64_MAX = 9223372036854775807n
const INT64_MIN = -9223372036854775808n

export function parseI64(bytes: Uint8Array): bigint | null {
  const text = latin1(bytes)
  if (!/^-?\d+$/.test(text)) return null
  try {
    const value = BigInt(text)
    if (value > INT64_MAX || value < INT64_MIN) return null
    return value
  } catch {
    return null
  }
}

export function intReply(value: bigint): number | bigint {
  if (value <= BigInt(Number.MAX_SAFE_INTEGER) && value >= BigInt(Number.MIN_SAFE_INTEGER)) {
    return Number(value)
  }
  return value
}

/** Redis glob: `*`, `?`, `[abc]`, `[a-z]`, `[^a]` / `[!a]`, and backslash escapes. */
export function globMatch(pattern: string, value: string): boolean {
  const match = (p: number, v: number): boolean => {
    if (p === pattern.length) return v === value.length
    const ch = pattern[p]
    if (ch === "\\") {
      if (p + 1 >= pattern.length) return false
      if (v >= value.length || value[v] !== pattern[p + 1]) return false
      return match(p + 2, v + 1)
    }
    if (ch === "*") {
      for (let i = v; i <= value.length; i++) if (match(p + 1, i)) return true
      return false
    }
    if (ch === "?") {
      if (v >= value.length) return false
      return match(p + 1, v + 1)
    }
    if (ch === "[") {
      if (v >= value.length) return false
      let i = p + 1
      let negate = false
      if (pattern[i] === "^" || pattern[i] === "!") {
        negate = true
        i++
      }
      let ok = false
      if (pattern[i] === "]") return false
      while (i < pattern.length && pattern[i] !== "]") {
        if (pattern[i] === "\\" && i + 1 < pattern.length) i++
        const start = pattern[i] ?? ""
        if (pattern[i + 1] === "-" && pattern[i + 2] !== undefined && pattern[i + 2] !== "]") {
          const end = pattern[i + 2] ?? ""
          const cur = value[v] ?? ""
          if (cur >= start && cur <= end) ok = true
          i += 3
        } else {
          if (value[v] === start) ok = true
          i++
        }
      }
      if (pattern[i] !== "]") return false
      if (ok === negate) return false
      return match(i + 1, v + 1)
    }
    if (v >= value.length || value[v] !== ch) return false
    return match(p + 1, v + 1)
  }
  return match(0, 0)
}
