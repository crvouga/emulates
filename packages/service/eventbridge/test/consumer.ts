export const call = async (
  fetcher: (request: Request) => Promise<Response>,
  target: string,
  body: Record<string, unknown> = {},
  headers: Record<string, string> = {},
) =>
  fetcher(
    new Request("http://mock.local/", {
      method: "POST",
      headers: {
        "content-type": "application/x-amz-json-1.1",
        "x-amz-target": `AWSEvents.${target}`,
        ...headers,
      },
      body: JSON.stringify(body),
    }),
  )
