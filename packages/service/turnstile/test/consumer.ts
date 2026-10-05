export type Verification = {
  success: boolean
  "error-codes"?: string[]
  hostname?: string
  action?: string
  cdata?: string
  challenge_ts?: string
}
export const verify = async (
  fetchImpl: typeof fetch,
  base: string,
  response: string,
  options: {
    secret?: string
    form?: boolean
    idempotencyKey?: string
    signal?: AbortSignal
  } = {},
): Promise<Verification> => {
  const data = {
    secret: options.secret ?? "mock_secret",
    response,
    ...(options.idempotencyKey ? { idempotency_key: options.idempotencyKey } : {}),
  }
  const result = await fetchImpl(`${base}/turnstile/v0/siteverify`, {
    method: "POST",
    headers: {
      "content-type": options.form ? "application/x-www-form-urlencoded" : "application/json",
    },
    body: options.form ? new URLSearchParams(data) : JSON.stringify(data),
    ...(options.signal ? { signal: options.signal } : {}),
  })
  if (!result.ok) throw new Error(`Verification HTTP ${result.status}`)
  return result.json() as Promise<Verification>
}
export const accepted = async (request: Promise<Verification>): Promise<boolean> => {
  try {
    const result = await request
    return result.success === true
  } catch {
    return false
  }
}
