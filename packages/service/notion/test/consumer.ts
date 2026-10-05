export const client = (fetchImpl: typeof fetch, base: string, token = "mock_notion_token") => {
  const post = (path: string, body: unknown) =>
    fetchImpl(`${base}${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "notion-version": "2022-06-28",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    })
  return {
    search: (size = 100, cursor?: string) =>
      post("/v1/search", {
        filter: { property: "object", value: "database" },
        page_size: size,
        ...(cursor ? { start_cursor: cursor } : {}),
      }),
    create: (databaseId: string, properties: Record<string, unknown>) =>
      post("/v1/pages", { parent: { database_id: databaseId }, properties }),
  }
}
