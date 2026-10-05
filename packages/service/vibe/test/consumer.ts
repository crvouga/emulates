export const client = (fetchImpl: typeof fetch, base: string, token = "mock_vibe_token") => {
  const headers = {
    authorization: `Bearer ${token}`,
    "x-vibe-revision": "2026-06-01",
    "content-type": "application/json",
  }
  return {
    create: (body: unknown) =>
      fetchImpl(`${base}/reports`, { method: "POST", headers, body: JSON.stringify(body) }),
    get: (id: string) => fetchImpl(`${base}/reports/${id}`, { headers }),
    download: (url: string) => fetchImpl(url),
    token: (scope = "advertisers:read reporting:read") =>
      fetchImpl(`${base}/oauth2/token`, {
        method: "POST",
        headers: { authorization: `Basic ${btoa("mock_client:mock_client_secret")}` },
        body: new URLSearchParams({ grant_type: "client_credentials", scope }),
      }),
  }
}
