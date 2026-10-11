import { fromBase64, toBase64 } from "@crvouga/mockingbird-service"
import { gcm } from "@noble/ciphers/aes.js"

/** Scripted audio at rest: AES-256-GCM under a key that never leaves the process. */
export type Sealed = { nonce: string; ciphertext: string }

/** Supply the same private key when reopening a persisted database. Never serialize it. */
export const createVaultKey = (): Uint8Array => crypto.getRandomValues(new Uint8Array(32))

/**
 * Keeps scripted audio out of every place a record can be read back: state introspection,
 * snapshots and Timeline history hold only the ciphertext. `context` binds a sealed value to
 * the namespace and record it was stored for.
 */
export class Vault {
  private readonly key: Uint8Array

  constructor(key: Uint8Array = createVaultKey()) {
    if (key.length !== 32) throw new Error("vaultKey must contain 32 bytes")
    this.key = key.slice()
  }

  seal(bytes: Uint8Array, context: string): Sealed {
    const nonce = crypto.getRandomValues(new Uint8Array(12))
    const cipher = gcm(this.key, nonce, new TextEncoder().encode(context))
    return { nonce: toBase64(nonce), ciphertext: toBase64(cipher.encrypt(bytes)) }
  }

  open(sealed: Sealed, context: string): Uint8Array {
    const cipher = gcm(this.key, fromBase64(sealed.nonce), new TextEncoder().encode(context))
    return cipher.decrypt(fromBase64(sealed.ciphertext))
  }
}
