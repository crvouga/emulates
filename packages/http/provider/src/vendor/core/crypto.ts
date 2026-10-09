import { hmac } from "@noble/hashes/hmac.js"
import { sha1 } from "@noble/hashes/legacy.js"
import { md5 } from "@noble/hashes/legacy.js"
import { sha256 } from "@noble/hashes/sha2.js"
import { Buffer } from "buffer"

const digest = (algorithm: string) => {
  if (algorithm === "sha256") return sha256
  if (algorithm === "sha1") return sha1
  if (algorithm === "md5") return md5
  throw new Error(`Unsupported digest ${algorithm}`)
}
const bytes = (input: string | Uint8Array) => typeof input === "string" ? new TextEncoder().encode(input) : input
interface Hash {
  update(input: string | Uint8Array): Hash
  digest(): Buffer
  digest(encoding: string): string
}
export function createHash(algorithm: string): Hash {
  const parts: Uint8Array[] = []
  const hash = {
    update(input: string | Uint8Array) { parts.push(bytes(input)); return hash },
    digest(encoding?: string): Buffer | string {
      const result = Buffer.from(digest(algorithm)(Buffer.concat(parts)))
      return encoding === "base64url" ? result.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") : encoding ? result.toString(encoding as BufferEncoding) : result
    },
  }
  return hash as Hash
}
export function createHmac(algorithm: string, key: string | Uint8Array): Hash {
  const parts: Uint8Array[] = []
  const hash = {
    update(input: string | Uint8Array) { parts.push(bytes(input)); return hash },
    digest(encoding?: string): Buffer | string {
      const result = Buffer.from(hmac(digest(algorithm), bytes(key), Buffer.concat(parts)))
      return encoding === "base64url" ? result.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") : encoding ? result.toString(encoding as BufferEncoding) : result
    },
  }
  return hash as Hash
}
export function randomBytes(length: number): Buffer {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(length)))
}
export function randomUUID(): string { return crypto.randomUUID() }
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) throw new Error("Buffers must have equal lengths")
  let difference = 0
  for (let i = 0; i < a.length; i++) difference |= a[i] ^ b[i]
  return difference === 0
}
