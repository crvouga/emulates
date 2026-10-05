/** Internal Sentry envelope codec. Lengths count bytes, not Unicode characters. */
export type JsonObject = Record<string, unknown>
export type EnvelopeItem = { headers: JsonObject & { type: string }; payload: Uint8Array }
export type Envelope = { headers: JsonObject; items: EnvelopeItem[] }
export const object = (value: unknown): JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as JsonObject) : {}
const utf8 = new TextDecoder("utf-8", { fatal: true })
export const encode = (value: string): Uint8Array => new TextEncoder().encode(value)
export const parseJson = (bytes: Uint8Array): JsonObject => {
  const value: unknown = JSON.parse(utf8.decode(bytes))
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid JSON data")
  return value as JsonObject
}
export const parseEnvelope = (bytes: Uint8Array): Envelope => {
  let offset = 0
  const line = (): Uint8Array => {
    const end = bytes.indexOf(10, offset)
    const value = bytes.slice(offset, end === -1 ? bytes.length : end)
    offset = end === -1 ? bytes.length : end + 1
    return value
  }
  const headers = parseJson(line())
  const items: EnvelopeItem[] = []
  while (offset < bytes.length) {
    const item = parseJson(line())
    if (typeof item.type !== "string" || !item.type) throw new Error("invalid event envelope")
    if (
      item.length !== undefined &&
      (typeof item.length !== "number" || !Number.isSafeInteger(item.length) || item.length < 0)
    )
      throw new Error("invalid event envelope")
    let payload: Uint8Array
    if (typeof item.length === "number") {
      const end = offset + item.length
      if (end > bytes.length) throw new Error("invalid event envelope")
      payload = bytes.slice(offset, end)
      offset = end
      if (offset < bytes.length) {
        if (bytes[offset] !== 10) throw new Error("invalid event envelope")
        offset++
      }
    } else payload = line()
    items.push({ headers: { ...item, type: item.type }, payload })
  }
  return { headers, items }
}

export type SealedBytes = { iv: number[]; ciphertext: number[] }
/** Raw payloads remain recoverable by the test owner, but are never plaintext diagnostics. */
export const seal = async (bytes: Uint8Array, key: CryptoKey): Promise<SealedBytes> => {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, bytes.slice())
  return { iv: [...iv], ciphertext: [...new Uint8Array(encrypted)] }
}
export const unseal = async (value: SealedBytes, key: CryptoKey): Promise<Uint8Array> =>
  new Uint8Array(
    await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: new Uint8Array(value.iv) },
      key,
      new Uint8Array(value.ciphertext),
    ),
  )
export const createCaptureKey = (): Promise<CryptoKey> =>
  crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"])

/** Redact case-insensitive header names, credential fields and configured dot paths. */
export const redact = (value: unknown, sensitivePaths: readonly string[], path = ""): unknown => {
  if (sensitivePaths.includes(path)) return "[Filtered]"
  if (Array.isArray(value)) {
    // Sentry request headers may be [name, value] pairs instead of a JSON object.
    if (
      value.length === 2 &&
      typeof value[0] === "string" &&
      /^(authorization|cookie|set-cookie|x-api-key|x-sentry-auth)$/i.test(value[0])
    )
      return [value[0], "[Filtered]"]
    return value.map((entry, index) => redact(entry, sensitivePaths, `${path}.${index}`))
  }
  if (value === null || typeof value !== "object") return value
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      /^(authorization|cookie|set-cookie|password|secret|access_token|refresh_token|api_key|x-api-key|x-sentry-auth|sentry_key|dsn)$/i.test(
        key,
      )
        ? "[Filtered]"
        : redact(entry, sensitivePaths, path ? `${path}.${key}` : key),
    ]),
  )
}
