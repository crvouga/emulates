export const userMirror = async (
  send: (request: Request) => Promise<Response>,
  origin: string,
  namespace?: string,
) => {
  const users: Record<string, unknown>[] = []
  let cursor: string | null = null
  do {
    const url = new URL("/user_management/users", origin)
    url.searchParams.set("limit", "1")
    if (cursor) url.searchParams.set("after", cursor)
    const response = await send(
      new Request(url, {
        headers: {
          authorization: "Bearer mock_workos_key",
          ...(namespace ? { "x-emulators-namespace": namespace } : {}),
        },
      }),
    )
    if (!response.ok) throw new Error(`WorkOS list failed (${response.status})`)
    const page = (await response.json()) as {
      data: Record<string, unknown>[]
      list_metadata: { after: string | null }
    }
    users.push(...page.data)
    cursor = page.list_metadata.after
  } while (cursor)
  return users
}
export const authorize = async (
  send: (request: Request) => Promise<Response>,
  origin: string,
  namespace = "default",
) => {
  const response = await send(
    new Request(
      `${origin}/user_management/authorize?client_id=client_mock&redirect_uri=${encodeURIComponent("http://localhost:3000/callback")}&response_type=code&provider=authkit&state=synthetic-state`,
      { headers: { "x-emulators-namespace": namespace }, redirect: "manual" },
    ),
  )
  if (response.status !== 302) throw new Error(`Authorization failed (${response.status})`)
  const location = response.headers.get("location")
  if (!location) throw new Error("Missing authorization redirect")
  return new URL(location)
}
export const authenticate = (
  send: (request: Request) => Promise<Response>,
  origin: string,
  body: Record<string, unknown>,
  namespace = "default",
) =>
  send(
    new Request(`${origin}/user_management/authenticate`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-emulators-namespace": namespace },
      body: JSON.stringify({ client_id: "client_mock", client_secret: "mock_workos_key", ...body }),
    }),
  )
