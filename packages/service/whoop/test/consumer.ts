// HTTP port of the issue's requests/httpx adapter: preserve provider envelopes and cursors.
export const synchronize = async (
  fetcher: (request: Request) => Promise<Response>,
  base: string,
  collection: string,
  token: string,
  window: Record<string, string>,
) => {
  const records: Record<string, unknown>[] = []
  let next: string | null = null
  do {
    const query = new URLSearchParams(window)
    if (next) query.set("nextToken", next)
    const response = await fetcher(
      new Request(
        `${base}/developer/v2/${collection === "sleep" || collection === "workout" ? "activity/" : ""}${collection}?${query}`,
        {
          headers: { authorization: `Bearer ${token}` },
        },
      ),
    )
    if (!response.ok) return { status: response.status, error: await response.json(), records }
    const body = (await response.json()) as {
      records: Record<string, unknown>[]
      next_token: string | null
    }
    records.push(...body.records)
    next = body.next_token
  } while (next)
  return { status: 200, records }
}
export const refresh = (
  fetcher: (request: Request) => Promise<Response>,
  base: string,
  refreshToken: string,
) =>
  fetcher(
    new Request(`${base}/oauth/oauth2/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: "mock_client",
        client_secret: "mock_client_secret",
        scope: "offline",
      }),
    }),
  )
