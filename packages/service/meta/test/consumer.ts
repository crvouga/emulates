/** A port of the raw-fetch Meta CAPI and Insights calls described in issue #82. */
export type Fetch = (input: string, init?: RequestInit) => Promise<Response>

export type ConversionEvent = {
  event_name: string
  event_time: number
  event_id?: string
  action_source: "website"
  event_source_url?: string
  user_data: Record<string, unknown>
  custom_data?: Record<string, unknown>
}

export class MetaGraphError extends Error {
  constructor(
    readonly status: number,
    readonly code: number,
    readonly transient: boolean,
    message: string,
  ) {
    super(message)
  }
}

const parse = async <T>(response: Response): Promise<T> => {
  const body = (await response.json()) as T & {
    error?: { message?: string; code?: number; is_transient?: boolean }
  }
  if (!response.ok || body.error) {
    throw new MetaGraphError(
      response.status,
      body.error?.code ?? 0,
      body.error?.is_transient === true,
      body.error?.message ?? `Meta request failed (${response.status})`,
    )
  }
  return body
}

export const sendConversionEvents = async (params: {
  baseUrl: string
  version?: string
  pixelId: string
  accessToken: string
  events: ConversionEvent[]
  testEventCode?: string
  fetchImpl: Fetch
}) => {
  const response = await params.fetchImpl(
    `${params.baseUrl}/${params.version ?? "v26.0"}/${params.pixelId}/events?access_token=${encodeURIComponent(params.accessToken)}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        data: params.events,
        ...(params.testEventCode ? { test_event_code: params.testEventCode } : {}),
      }),
    },
  )
  return parse<{ events_received: number; messages: string[]; fbtrace_id: string }>(response)
}

export const listInsights = async (params: {
  baseUrl: string
  accountId: string
  accessToken: string
  since: string
  until: string
  limit?: number
  after?: string
  breakdowns?: string[]
  fetchImpl: Fetch
}) => {
  const query = new URLSearchParams({
    access_token: params.accessToken,
    fields:
      "account_id,campaign_id,campaign_name,date_start,date_stop,impressions,clicks,spend,actions,action_values,website_purchase_roas",
    time_range: JSON.stringify({ since: params.since, until: params.until }),
    limit: String(params.limit ?? 25),
  })
  if (params.after) query.set("after", params.after)
  if (params.breakdowns?.length) query.set("breakdowns", params.breakdowns.join(","))
  const response = await params.fetchImpl(
    `${params.baseUrl}/v26.0/${params.accountId}/insights?${query}`,
    { headers: { authorization: `Bearer ${params.accessToken}` } },
  )
  return parse<{
    data: Array<Record<string, unknown>>
    paging: { cursors: { before: string; after: string }; next?: string }
  }>(response)
}

export const getMarketingObject = async (params: {
  baseUrl: string
  id: string
  accessToken: string
  fetchImpl: Fetch
}) =>
  parse<{ id: string; name: string; status: string }>(
    await params.fetchImpl(`${params.baseUrl}/v26.0/${params.id}?fields=id,name,status`, {
      headers: { authorization: `Bearer ${params.accessToken}` },
    }),
  )
