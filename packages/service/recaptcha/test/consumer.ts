export type Verification = {
  success: boolean
  score?: number
  action?: string
  hostname?: string
  challenge_ts?: string
  "error-codes"?: string[]
}
/** Google's documented server-side verification flow; this is not private application source. */
export async function verify(
  fetchImpl: typeof fetch,
  origin: string,
  token: string,
  secret = "mock_secret",
): Promise<Verification> {
  const response = await fetchImpl(`${origin}/recaptcha/api/siteverify`, {
    method: "POST",
    body: new URLSearchParams({ secret, response: token }),
  })
  if (!response.ok) throw new Error(`Verification HTTP ${response.status}`)
  return response.json() as Promise<Verification>
}
export function accepted(
  result: Verification,
  action: string,
  hostname: string,
  threshold = 0.5,
): boolean {
  return (
    result.success &&
    result.action === action &&
    result.hostname === hostname &&
    (result.score ?? -1) >= threshold
  )
}
