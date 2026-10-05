import { gcm } from "@noble/ciphers/aes.js"
export type Sealed = { nonce: number[]; ciphertext: number[] }
/** Supply the same private key when reopening a persisted database. Never serialize it. */
export const createVaultKey = (): Uint8Array => crypto.getRandomValues(new Uint8Array(32))
export class Vault {
  private readonly key: Uint8Array
  constructor(key: Uint8Array = createVaultKey()) {
    if (key.length !== 32) throw new Error("vaultKey must contain 32 bytes")
    this.key = key.slice()
  }
  seal(value: unknown, context: string): Sealed {
    const nonce = crypto.getRandomValues(new Uint8Array(12))
    return {
      nonce: [...nonce],
      ciphertext: [
        ...gcm(this.key, nonce, new TextEncoder().encode(context)).encrypt(
          new TextEncoder().encode(JSON.stringify(value)),
        ),
      ],
    }
  }
  open<T>(sealed: Sealed, context: string): T {
    return JSON.parse(
      new TextDecoder().decode(
        gcm(this.key, Uint8Array.from(sealed.nonce), new TextEncoder().encode(context)).decrypt(
          Uint8Array.from(sealed.ciphertext),
        ),
      ),
    ) as T
  }
}
