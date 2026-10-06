import { expect, test } from "bun:test"
import { createClock } from "@emulates/service"
import { OAuth2Client } from "google-auth-library"
import { DEFAULT_CUSTOMER, DEFAULT_TOKEN } from "./src/index.js"
import { createServer } from "./src/server.js"
import { GoogleConsumer, type SearchResult } from "./test/consumer.js"

test("unmodified google-auth-library 11.1.0 signs Ads/GA4 Data traffic over Node HTTP; raw collect stays empty 204", async () => {
  const server = await createServer({ clock: createClock(() => 1791072000000) })
  try {
    const client = new OAuth2Client()
    client.setCredentials({ access_token: DEFAULT_TOKEN })
    const query = "SELECT campaign.id, metrics.cost_micros, metrics.conversions_value FROM campaign"
    const result = await client.request<SearchResult>({
      url: `${server.url}/v25/customers/${DEFAULT_CUSTOMER}/googleAds:search`,
      method: "POST",
      data: { query },
      retry: false,
      headers: {
        "developer-token": "ignored-legacy-fixture-token",
        "login-customer-id": "1000000099",
      },
    })
    expect(result.data.results?.[0]?.metrics?.costMicros).toBe("12345678")
    expect(result.data.results?.[0]?.metrics?.conversionsValue).toBe(42.75)
    const c = new GoogleConsumer((r) => fetch(r), server.url)
    expect(
      (await c.updateBudget(`customers/${DEFAULT_CUSTOMER}/campaignBudgets/2000000001`, "40000000"))
        .status,
    ).toBe(200)
    const collected = await c.collect({
      client_id: "fixture-http-client",
      events: [
        {
          name: "purchase",
          params: { transaction_id: "fixture-http-order", currency: "USD", value: 23.75 },
        },
      ],
    })
    expect(collected.status).toBe(204)
    expect(await collected.text()).toBe("")
    const report = await client.request<{
      rowCount: number
      rows: { metricValues: { value: string }[] }[]
    }>({
      url: `${server.url}/v1beta/properties/1000000001:runReport`,
      method: "POST",
      data: {
        dimensions: [{ name: "eventName" }],
        metrics: [{ name: "eventCount" }, { name: "purchaseRevenue" }],
        dateRanges: [{ startDate: "2026-10-04", endDate: "2026-10-04" }],
      },
      retry: false,
    })
    expect(report.data.rowCount).toBe(1)
    expect(report.data.rows[0]?.metricValues.map((v) => v.value)).toEqual(["1", "23.75"])
  } finally {
    await server.close()
  }
})
