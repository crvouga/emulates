import { Collection, seedFrom } from "@emulators/service"
import type { SqliteClient } from "@emulators/sqlite-client"
import { base64url, Signer } from "./crypto.js"

/** A caller-supplied RS256 signing key pair. `kid` is published in the JWKS and token headers. */
export type SigningKey = { privateJwk: JsonWebKey; publicJwk: JsonWebKey; kid: string }

/**
 * Opt-in control over every opaque value the provider mints. With none of these set the provider
 * uses cryptographic randomness, exactly as before.
 */
export type CredentialOptions = {
  /**
   * Derive authorization codes, tokens, transaction ids, session ids, CSP nonces and signing keys
   * from `seed` (default 0) instead of `crypto`, so the same seed and the same requests replay
   * byte-for-byte. Test-only: the values are guessable.
   */
  deterministicCredentials?: boolean
  /** Replaces `crypto.getRandomValues` for every minted value, and wins over the seeded source. */
  randomBytes?: (length: number) => Uint8Array
  /** Signing keys used in order: the first is current and each rotation takes the next. */
  signingKeys?: SigningKey[]
}

// sfc32 over a 128-bit state, so distinct draws never collapse onto one 32-bit seed.
const seededBytes = (label: string, length: number): Uint8Array => {
  let a = seedFrom(`${label}:0`)
  let b = seedFrom(`${label}:1`)
  let c = seedFrom(`${label}:2`)
  let d = seedFrom(`${label}:3`)
  const next = () => {
    const t = (((a + b) | 0) + d) | 0
    d = (d + 1) | 0
    a = b ^ (b >>> 9)
    b = (c + (c << 3)) | 0
    c = (((c << 21) | (c >>> 11)) + t) | 0
    return t >>> 0
  }
  for (let i = 0; i < 12; i++) next()
  const out = new Uint8Array(length)
  for (let i = 0; i < length; i += 4) {
    const word = next()
    for (let j = 0; j < 4 && i + j < length; j++) out[i + j] = (word >>> (8 * j)) & 255
  }
  return out
}

const toBigInt = (bytes: Uint8Array) =>
  BigInt(`0x${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}`)
const fromBigInt = (value: bigint) => {
  const hex = value.toString(16)
  const padded = hex.length % 2 ? `0${hex}` : hex
  return Uint8Array.from(padded.match(/../g) ?? [], (h) => Number.parseInt(h, 16))
}
const modPow = (base: bigint, exponent: bigint, modulus: bigint) => {
  let result = 1n
  let b = base % modulus
  for (let e = exponent; e > 0n; e >>= 1n) {
    if (e & 1n) result = (result * b) % modulus
    b = (b * b) % modulus
  }
  return result
}
const modInverse = (value: bigint, modulus: bigint) => {
  let [r0, r1, t0, t1] = [modulus, value % modulus, 0n, 1n]
  while (r1) {
    const q = r0 / r1
    ;[r0, r1] = [r1, r0 - q * r1]
    ;[t0, t1] = [t1, t0 - q * t1]
  }
  return ((t0 % modulus) + modulus) % modulus
}
const SMALL_PRIMES = Array.from({ length: 2000 }, (_, i) => i + 2)
  .filter((n, _, all) => all.every((m) => m * m > n || n % m))
  .map(BigInt)
const probablePrime = (n: bigint) => {
  if (SMALL_PRIMES.some((p) => n % p === 0n)) return false
  let d = n - 1n
  let s = 0
  while (!(d & 1n)) {
    d >>= 1n
    s++
  }
  return SMALL_PRIMES.slice(0, 16).every((a) => {
    let x = modPow(a, d, n)
    if (x === 1n || x === n - 1n) return true
    for (let i = 1; i < s; i++) {
      x = (x * x) % n
      if (x === n - 1n) return true
    }
    return false
  })
}

const E = 65537n
const seededPrime = (label: string) => {
  for (let attempt = 0; ; attempt++) {
    const candidate = toBigInt(seededBytes(`${label}:${attempt}`, 128)) | (3n << 1022n) | 1n
    if ((candidate - 1n) % E !== 0n && probablePrime(candidate)) return candidate
  }
}

type KeyPair = { privateJwk: JsonWebKey; publicJwk: JsonWebKey }
const keyCache = new Map<string, KeyPair>()
/** A 2048-bit RSA key pair that is a pure function of `label`; WebCrypto cannot generate one. */
const seededRsa = (label: string): KeyPair => {
  const cached = keyCache.get(label)
  if (cached) return cached
  let p = seededPrime(`${label}:p`)
  let q = seededPrime(`${label}:q`)
  for (let i = 0; q === p; i++) q = seededPrime(`${label}:q${i}`)
  if (p < q) [p, q] = [q, p]
  const d = modInverse(E, (p - 1n) * (q - 1n))
  const enc = (v: bigint) => base64url(fromBigInt(v))
  const publicJwk: JsonWebKey = { kty: "RSA", n: enc(p * q), e: enc(E) }
  const privateJwk: JsonWebKey = {
    ...publicJwk,
    d: enc(d),
    p: enc(p),
    q: enc(q),
    dp: enc(d % (p - 1n)),
    dq: enc(d % (q - 1n)),
    qi: enc(modInverse(q, p)),
  }
  const pair = { privateJwk, publicJwk }
  keyCache.set(label, pair)
  return pair
}

/**
 * Mints every opaque credential. The draw counter lives in the namespace, so it is snapshotted
 * and cleared with the rest of the state and a reset replays the same values.
 */
export class Credentials {
  private readonly draws: Collection<never>
  private readonly seed: string
  private keyIndex = 0
  constructor(
    sqlite: SqliteClient,
    namespace: string,
    seed: number | string | undefined,
    private readonly options: CredentialOptions,
  ) {
    this.draws = new Collection(sqlite, namespace, "oauth_credential_draws")
    this.seed = String(seed ?? 0)
  }
  private bytes(length: number): Uint8Array {
    if (this.options.randomBytes) return this.options.randomBytes(length)
    if (this.options.deterministicCredentials)
      return seededBytes(`${this.seed}:${this.draws.nextSequence()}`, length)
    return crypto.getRandomValues(new Uint8Array(length))
  }
  /** Codes, access/refresh tokens, transaction ids, session ids and grant families. */
  token(): string {
    return base64url(this.bytes(32))
  }
  /** CSP nonce for interaction pages; a UUID unless credentials are controlled. */
  nonce(): string {
    return this.options.randomBytes || this.options.deterministicCredentials
      ? base64url(this.bytes(16))
      : crypto.randomUUID()
  }
  /** The next signing key: injected, else derived from the seed, else freshly generated. */
  signer(): Signer {
    const index = this.keyIndex++
    const injected = this.options.signingKeys?.[index]
    if (injected) return new Signer(injected)
    if (!this.options.deterministicCredentials || this.options.randomBytes)
      return new Signer(undefined, this.token())
    const kid = this.token()
    return new Signer({ ...seededRsa(`${this.seed}:key:${index}`), kid })
  }
  /**
   * The key that signs ID tokens but is never published. Never taken from `signingKeys` (those are
   * published); under a seed it is derived without touching the draw counter.
   */
  unpublishedSigner(): Signer {
    if (!this.options.deterministicCredentials || this.options.randomBytes)
      return new Signer(undefined, this.token())
    const label = `${this.seed}:unpublished`
    return new Signer({ ...seededRsa(label), kid: base64url(seededBytes(`${label}:kid`, 32)) })
  }
  /** Start the signing-key sequence over; the draw counter is cleared with the namespace. */
  restart(): void {
    this.keyIndex = 0
  }
}

export const controlled = (options: CredentialOptions): boolean =>
  !!(options.deterministicCredentials || options.randomBytes || options.signingKeys)
