export const call = (
  send: (request: Request) => Promise<Response>,
  origin: string,
  path: string,
  body?: unknown,
  method = body === undefined ? "GET" : "POST",
) =>
  send(
    new Request(`${origin}${path}`, {
      method,
      headers: {
        authorization: `Basic ${btoa("mock_checkr_key:")}`,
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  )
export const enumerate = async (
  send: (request: Request) => Promise<Response>,
  origin: string,
  path: string,
) => {
  const rows: Record<string, unknown>[] = []
  let url: string | null = `${origin}${path}`
  const visited = new Set<string>()
  while (url) {
    if (visited.has(url)) throw new Error("Pagination loop")
    visited.add(url)
    const response = await send(
      new Request(url, { headers: { authorization: `Basic ${btoa("mock_checkr_key:")}` } }),
    )
    if (!response.ok) throw new Error(`Checkr list failed (${response.status})`)
    const body = (await response.json()) as {
      data: Record<string, unknown>[]
      next_href: string | null
    }
    rows.push(...body.data)
    url = body.next_href
  }
  return rows
}
