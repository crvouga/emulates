// Raw-fetch port of the optional forms integration's reported wire surface.
export const client = (
  fetcher: (r: Request) => Promise<Response>,
  base: string,
  token = "mock_airtable_token",
) => ({
  async request(path: string, body?: unknown) {
    return fetcher(
      new Request(`${base}${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    )
  },
  async exchange(body: Record<string, string>) {
    return fetcher(
      new Request(`${base}/oauth2/v1/token`, {
        method: "POST",
        headers: {
          authorization: `Basic ${btoa("mock_client:mock_client_secret")}`,
        },
        body: new URLSearchParams(body),
      }),
    )
  },
})
