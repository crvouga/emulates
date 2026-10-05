const encode = (input: Uint8Array) =>
  btoa(String.fromCharCode(...input))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "")
const bytes = new TextEncoder()
export const digest = async (input: string) =>
  encode(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes.encode(input))))
/** Ephemeral mock-only keys. Private material never enters durable state or journals. */
export class Signer {
  private pair: Promise<CryptoKeyPair> | undefined
  private keys() {
    this.pair ??= crypto.subtle.generateKey(
      {
        name: "RSASSA-PKCS1-v1_5",
        hash: "SHA-256",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
      },
      true,
      ["sign", "verify"],
    )
    return this.pair
  }
  async jwks() {
    return {
      keys: [
        {
          ...(await crypto.subtle.exportKey("jwk", (await this.keys()).publicKey)),
          kid: "mock-workos",
          alg: "RS256",
          use: "sig",
        },
      ],
    }
  }
  async sign(payload: Record<string, unknown>) {
    const input = `${encode(bytes.encode(JSON.stringify({ alg: "RS256", kid: "mock-workos", typ: "JWT" })))}.${encode(bytes.encode(JSON.stringify(payload)))}`
    return `${input}.${encode(new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", (await this.keys()).privateKey, bytes.encode(input))))}`
  }
}
