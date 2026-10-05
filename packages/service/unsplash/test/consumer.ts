export const client = (fetchImpl: typeof fetch, baseUrl: string, key = "mock_unsplash_key") => ({
  search: (query: string, page = 1, perPage = 9) => {
    const url = new URL(`${baseUrl}/search/photos`)
    url.search = new URLSearchParams({
      query,
      page: String(page),
      per_page: String(perPage),
      orientation: "landscape",
      client_id: key,
    }).toString()
    return fetchImpl(url)
  },
})
