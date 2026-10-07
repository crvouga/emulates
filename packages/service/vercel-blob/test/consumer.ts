import { DEFAULT_TOKEN } from "../src/index.js"
export type UploadReply = {
  pathname: string
  url: string
  downloadUrl: string
  contentType: string
  contentDisposition: string
  etag: string
}
export const consumer = (
  mock: { fetch: (request: Request) => Promise<Response> },
  namespace?: string,
) => {
  const request = (path: string, init: RequestInit = {}) =>
    mock.fetch(
      new Request(new URL(path, "http://mock.local"), {
        ...init,
        headers: {
          authorization: `Bearer ${DEFAULT_TOKEN}`,
          ...(namespace ? { "x-mockingbird-namespace": namespace } : {}),
          ...Object.fromEntries(new Headers(init.headers)),
        },
      }),
    )
  return {
    request,
    put: (
      pathname: string,
      bytes: string | Uint8Array,
      options: { overwrite?: boolean; type?: string; maxAge?: number } = {},
    ) =>
      request(`/api/blob/?${new URLSearchParams({ pathname })}`, {
        method: "PUT",
        headers: {
          "x-vercel-blob-access": "public",
          "x-allow-overwrite": options.overwrite ? "1" : "0",
          "x-content-type": options.type ?? "application/octet-stream",
          "x-cache-control-max-age": String(options.maxAge ?? 2592000),
        },
        body: bytes as BodyInit,
      }),
    head: (ref: string) => request(`/api/blob?${new URLSearchParams({ url: ref })}`),
    list: (query: Record<string, string> = {}) =>
      request(`/api/blob?${new URLSearchParams(query)}`),
    del: (refs: string[]) =>
      request("/api/blob/delete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ urls: refs }),
      }),
  }
}
