export const call = (
  fetcher: (r: Request) => Promise<Response>,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
) =>
  fetcher(
    new Request("http://mock.local" + path, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer mock_tavily_key",
        ...headers,
      },
      body: JSON.stringify(body),
    }),
  )
