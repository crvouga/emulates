export const client = (fetchImpl: typeof fetch, base: string, token = "mock_vanta_token") => {
  const headers = { authorization: `Bearer ${token}` }
  return {
    token: (write = false) =>
      fetchImpl(`${base}/oauth/token`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_id: write ? "mock_write" : "mock_read",
          client_secret: write ? "mock_write_secret" : "mock_read_secret",
          grant_type: "client_credentials",
          scope: write
            ? "vanta-api.all:read vanta-api.all:write vanta-api.documents:upload"
            : "vanta-api.all:read",
        }),
      }),
    list: (kind = "people", size = 100, cursor?: string) =>
      fetchImpl(
        `${base}/v1/${kind}?pageSize=${size}${cursor ? `&pageCursor=${encodeURIComponent(cursor)}` : ""}`,
        { headers },
      ),
    get: (kind: string, id: string) => fetchImpl(`${base}/v1/${kind}/${id}`, { headers }),
    upload: (id: string, text = "Synthetic evidence bytes") => {
      const form = new FormData()
      form.set("file", new Blob([text], { type: "text/plain" }), "synthetic.txt")
      form.set("description", "Synthetic attachment")
      return fetchImpl(`${base}/v1/documents/${id}/uploads`, {
        method: "POST",
        headers,
        body: form,
      })
    },
    submit: (id: string) =>
      fetchImpl(`${base}/v1/documents/${id}/submit`, { method: "POST", headers }),
    offboard: (updates: { id: string; acknowledgerId: string }[]) =>
      fetchImpl(`${base}/v1/people/offboard`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ updates }),
      }),
  }
}
