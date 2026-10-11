import {
  DEFAULT_API_SECRET,
  DEFAULT_CUSTOMER,
  DEFAULT_MEASUREMENT,
  DEFAULT_PROPERTY,
  DEFAULT_TOKEN,
} from "../src/index.js"
export type Transport = (request: Request) => Promise<Response>
export type SearchResult = {
  results?: Record<string, Record<string, unknown>>[]
  nextPageToken?: string
  fieldMask?: string
  totalResultsCount?: string
  summaryRow?: Record<string, Record<string, unknown>>
}
/**
 * Port of the raw-fetch traffic the service request describes on the wire. The consuming
 * application's own client source is not in this repository, so this is not that client.
 */
export class GoogleConsumer {
  constructor(
    private readonly fetch: Transport,
    readonly baseUrl = "http://mock.local",
    readonly token = DEFAULT_TOKEN,
    readonly customer = DEFAULT_CUSTOMER,
  ) {}
  request(path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
    return this.fetch(
      new Request(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.token}`,
          "developer-token": "legacy-fixture-developer-token",
          ...headers,
        },
        body: JSON.stringify(body),
      }),
    )
  }
  async search(query: string, extra: Record<string, unknown> = {}): Promise<SearchResult> {
    let response: Response | undefined
    for (let attempt = 0; attempt < 3; attempt++) {
      response = await this.request(`/v25/customers/${this.customer}/googleAds:search`, {
        query,
        ...extra,
      })
      if (![429, 500, 503].includes(response.status)) break
    }
    if (!response) throw new Error("Search did not produce a response")
    if (!response.ok) throw new Error(JSON.stringify(await response.json()))
    return (await response.json()) as SearchResult
  }
  async all(query: string): Promise<NonNullable<SearchResult["results"]>> {
    const rows: NonNullable<SearchResult["results"]> = []
    let token: string | undefined
    do {
      const page = await this.search(query, token ? { pageToken: token } : {})
      rows.push(...(page.results ?? []))
      token = page.nextPageToken
    } while (token)
    return rows
  }
  async updateBudget(resourceName: string, amountMicros: string): Promise<Response> {
    const body = {
      operations: [{ update: { resourceName, amountMicros }, updateMask: "amount_micros" }],
    }
    const validation = await this.request(
      `/v25/customers/${this.customer}/campaignBudgets:mutate`,
      { ...body, validateOnly: true },
    )
    if (!validation.ok) return validation
    return this.request(`/v25/customers/${this.customer}/campaignBudgets:mutate`, body)
  }
  collect(body: unknown, debug = false, secret = DEFAULT_API_SECRET): Promise<Response> {
    return this.request(
      `${debug ? "/debug" : ""}/mp/collect?measurement_id=${DEFAULT_MEASUREMENT}&api_secret=${encodeURIComponent(secret)}`,
      body,
    )
  }
  report(body: unknown, property = DEFAULT_PROPERTY): Promise<Response> {
    return this.request(`/v1beta/properties/${property}:runReport`, body)
  }
  upload(conversions: unknown[], extra: Record<string, unknown> = {}): Promise<Response> {
    return this.request(`/v25/customers/${this.customer}:uploadClickConversions`, {
      conversions,
      partialFailure: true,
      ...extra,
    })
  }
}
