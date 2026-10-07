import { expect, test } from "bun:test"
import { createClock } from "@crvouga/mockingbird-service"
import { present, record } from "./src/errors.js"
import {
  createRuntime,
  DEFAULT_ADMIN_KEY,
  DEFAULT_CUSTOMER,
  DEFAULT_TOKEN,
  GoogleAdsAPI,
  type MetricFixture,
} from "./src/index.js"
import { GoogleConsumer, type SearchResult } from "./test/consumer.js"
import { nativeSqlite } from "./test/native-sqlite.js"

const now = 1791072000000
const budget = `customers/${DEFAULT_CUSTOMER}/campaignBudgets/2000000001`
const action = `customers/${DEFAULT_CUSTOMER}/conversionActions/4000000001`
const budgetQuery =
  "SELECT campaign_budget.id, campaign_budget.name, campaign_budget.amount_micros, campaign_budget.resource_name FROM campaign_budget ORDER BY campaign_budget.id"
const runtime = () => createRuntime({ clock: createClock(() => now) })
const consumer = (r: ReturnType<typeof runtime>, ns?: string) =>
  new GoogleConsumer((req) =>
    r.fetch(
      ns
        ? new Request(req, {
            headers: { ...Object.fromEntries(req.headers), "x-mockingbird-namespace": ns },
          })
        : req,
    ),
  )
const admin = (
  r: ReturnType<typeof runtime>,
  path: string,
  method = "GET",
  body?: unknown,
  ns?: string,
) =>
  r.fetch(
    new Request(`http://mock.local/__admin${path}`, {
      method,
      headers: {
        "x-mockingbird-admin-key": DEFAULT_ADMIN_KEY,
        "content-type": "application/json",
        ...(ns ? { "x-mockingbird-namespace": ns } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  )
const json = async (r: Response): Promise<Record<string, unknown>> => record(await r.json())
const array = (v: unknown): Record<string, unknown>[] => (v as unknown[]).map(record)
const first = <T>(values: readonly T[]): T => present(values[0])
const amount = async (c: GoogleConsumer): Promise<unknown> =>
  (await c.search(budgetQuery)).results?.[0]?.campaignBudget?.amountMicros
const errorCode = async (r: Response): Promise<Record<string, unknown>> =>
  record(first(array(first(array(record((await json(r)).error).details)).errors)).errorCode)
const event = (name: string, transaction = "fixture-order", value = 12.75) => ({
  name,
  params: {
    transaction_id: transaction,
    currency: "USD",
    value,
    session_id: 123,
    engagement_time_msec: 700,
    gclid: "fixture-click",
  },
})
const reportBody = {
  dimensions: [{ name: "eventName" }],
  metrics: [{ name: "eventCount" }, { name: "purchaseRevenue" }],
  dateRanges: [{ startDate: "2026-10-04", endDate: "2026-10-04" }],
  orderBys: [{ dimension: { dimensionName: "eventName" } }],
}
const conversion = (orderId = "fixture-conversion-order") => ({
  gclid: `fixture-click-${orderId}`,
  conversionAction: action,
  conversionDateTime: "2026-10-03 12:00:00+00:00",
  conversionValue: 42.75,
  currencyCode: "USD",
  orderId,
})
test("GAQL retains integer precision, decimal metrics, date filtering and conversion categories", async () => {
  const r = runtime(),
    c = consumer(r),
    query =
      "SELECT campaign.id, campaign.name, metrics.cost_micros, metrics.clicks, metrics.impressions, metrics.conversions, metrics.conversions_value, segments.date, segments.conversion_action_category FROM campaign WHERE segments.date BETWEEN '2026-10-04' AND '2026-10-04' AND campaign.status IN ('ENABLED','PAUSED') ORDER BY campaign.id"
  const rows = present((await c.search(query)).results)
  expect(rows).toHaveLength(1)
  expect(rows[0]?.metrics).toEqual({
    costMicros: "12345678",
    clicks: "7",
    impressions: "123",
    conversions: 1.25,
    conversionsValue: 42.75,
  })
  expect(rows[0]?.segments).toEqual({ date: "2026-10-04", conversionActionCategory: "PURCHASE" })
  expect((await c.search(query.replaceAll("2026-10-04", "2026-10-03"))).results).toEqual([])
  const metric = {
    customerId: DEFAULT_CUSTOMER,
    campaignId: "3000000001",
    date: "2026-10-04",
    costMicros: "9007199254740993",
    clicks: "2",
    impressions: "3",
    conversions: 0.5,
    conversionsValue: 0.25,
  }
  expect((await admin(r, "/daily-metrics", "POST", { metrics: [metric] })).status).toBe(201)
  const sum = present(
    await c
      .search(
        "SELECT campaign.id, metrics.cost_micros, metrics.conversions FROM campaign WHERE segments.date DURING TODAY",
      )
      .then((response) => response.results),
  )
  expect(sum[0]?.metrics?.costMicros).toBe("9007199267086671")
  expect(sum[0]?.metrics?.conversions).toBe(1.75)
  for (const bad of [
    "DELETE FROM campaign",
    "SELECT campaign.unrecognised FROM campaign",
    "SELECT campaign.id FROM campaign WHERE campaign.id = '3000000001' OR campaign.id = '1'",
  ])
    expect(
      (await c.request(`/v25/customers/${DEFAULT_CUSTOMER}/googleAds:search`, { query: bad }))
        .status,
    ).toBe(400)
  expect(
    await errorCode(
      await c.request(`/v25/customers/${DEFAULT_CUSTOMER}/googleAds:search`, {
        query,
        pageSize: 2,
      }),
    ),
  ).toEqual({ requestError: "PAGE_SIZE_NOT_SUPPORTED" })
  expect(
    (
      await admin(r, "/daily-metrics", "POST", {
        metrics: [metric, { ...metric, campaignId: "missing" }],
      })
    ).status,
  ).toBe(400)
  expect(r.instance().state.metrics.count()).toBe(2)
})
test(
  "10000-row paging snapshots are stable and tokens bind query, namespace and expiry",
  async () => {
    const metrics: MetricFixture[] = Array.from({ length: 10001 }, (_, i) => ({
      customerId: DEFAULT_CUSTOMER,
      campaignId: String(3000000001 + i),
      date: "2026-10-04",
      costMicros: "1234567",
      clicks: "1",
      impressions: "2",
      conversions: 0.1,
      conversionsValue: 1.01,
    }))
    const sqlite = nativeSqlite()
    const r = createRuntime({
        sqlite,
        clock: createClock(() => now),
        campaigns: metrics.map((m) => ({
          customerId: m.customerId,
          id: m.campaignId,
          name: `Fixture ${m.campaignId}`,
          budgetId: "2000000001",
          status: "ENABLED",
        })),
        metrics,
      }),
      c = consumer(r),
      query =
        "SELECT campaign.id, campaign_budget.amount_micros, metrics.cost_micros FROM campaign ORDER BY campaign.id"
    const first = await c.search(query, { searchSettings: { returnTotalResultsCount: true } })
    expect(first.results).toHaveLength(10000)
    expect(first.totalResultsCount).toBe("10001")
    expect(first.nextPageToken).toBeString()
    expect((await c.updateBudget(budget, "70000000")).status).toBe(200)
    const args = {
        pageToken: first.nextPageToken,
        searchSettings: { returnTotalResultsCount: true },
      },
      last = await c.search(query, args)
    expect(last.results).toHaveLength(1)
    expect(last.nextPageToken).toBeUndefined()
    expect(last.results?.[0]?.campaignBudget?.amountMicros).toBe("25000000")
    expect(await c.search(query, args)).toEqual(last)
    const path = `/v25/customers/${DEFAULT_CUSTOMER}/googleAds:search`
    expect(await errorCode(await c.request(path, { query: `${query} LIMIT 1`, ...args }))).toEqual({
      requestError: "INVALID_PAGE_TOKEN",
    })
    expect(await errorCode(await consumer(r, "other").request(path, { query, ...args }))).toEqual({
      requestError: "INVALID_PAGE_TOKEN",
    })
    expect((await json(await admin(r, "/page-tokens/expire", "POST"))).expired).toBe(1)
    expect(await errorCode(await c.request(path, { query, ...args }))).toEqual({
      requestError: "EXPIRED_PAGE_TOKEN",
    })
    const stream = await c.request(`/v25/customers/${DEFAULT_CUSTOMER}/googleAds:searchStream`, {
        query,
      }),
      batches = (await stream.json()) as SearchResult[]
    expect(batches.map((b) => b.results?.length)).toEqual([10000, 1])
    expect(stream.headers.get("content-type")).toContain("application/json")
    sqlite.close()
  },
  { timeout: 60000 },
)
test("budget preflight leaves IDs untouched; update masks and atomic/partial batches preserve writes", async () => {
  const r = runtime(),
    c = consumer(r),
    path = `/v25/customers/${DEFAULT_CUSTOMER}/campaignBudgets:mutate`,
    create = { operations: [{ create: { name: "Fixture created", amountMicros: "12000000" } }] }
  expect(await json(await c.request(path, { ...create, validateOnly: true }))).toEqual({})
  expect(r.instance().state.budgets.count()).toBe(1)
  const created = await json(
      await c.request(path, { ...create, responseContentType: "MUTABLE_RESOURCE" }),
    ),
    result = first(array(created.results))
  expect(result.resourceName).toBe(`customers/${DEFAULT_CUSTOMER}/campaignBudgets/9000000001`)
  expect(record(result.campaignBudget).amountMicros).toBe("12000000")
  expect((await c.updateBudget(budget, "45678901")).status).toBe(200)
  expect(await amount(c)).toBe("45678901")
  const operations = [
    {
      update: { resourceName: budget, amountMicros: "99000000", name: "unmasked ignored" },
      updateMask: "amount_micros",
    },
    {
      update: {
        resourceName: `customers/${DEFAULT_CUSTOMER}/campaignBudgets/8888888888`,
        amountMicros: "1",
      },
      updateMask: "amount_micros",
    },
  ]
  expect((await c.request(path, { operations })).status).toBe(400)
  expect(await amount(c)).toBe("45678901")
  const partial = await json(await c.request(path, { operations, partialFailure: true }))
  expect(array(partial.results)).toHaveLength(2)
  expect(array(partial.results)[1]).toEqual({})
  expect(partial.partialFailureError).toBeDefined()
  expect(await amount(c)).toBe("99000000")
  expect((await c.search(budgetQuery)).results?.[0]?.campaignBudget?.name).toBe(
    "Fixture shared budget",
  )
  expect(
    (
      await c.request(path, {
        operations: [{ update: { resourceName: budget }, updateMask: "amountMicros" }],
      })
    ).status,
  ).toBe(200)
  expect(await amount(c)).toBeUndefined()
  expect((await c.request(path, { operations: [{ remove: result.resourceName }] })).status).toBe(
    200,
  )
  expect((await c.request(path, { operations: [{ remove: budget }] })).status).toBe(400)
})
test("post-write uncertainty is inspectable without mutation replay; only reporting reads retry quota faults", async () => {
  const r = runtime(),
    c = consumer(r)
  expect((await admin(r, "/faults", "POST", { preset: "ambiguous_budget_write" })).status).toBe(201)
  expect(
    (
      await c.request(`/v25/customers/${DEFAULT_CUSTOMER}/campaignBudgets:mutate`, {
        operations: [
          {
            update: { resourceName: budget, amountMicros: "60000000" },
            updateMask: "amountMicros",
          },
        ],
      })
    ).status,
  ).toBe(503)
  expect(await amount(c)).toBe("60000000")
  expect(array((await json(await admin(r, "/budget-mutations"))).mutations)).toHaveLength(1)
  expect((await admin(r, "/faults", "POST", { preset: "quota_exhausted" })).status).toBe(201)
  expect(await amount(c)).toBe("60000000")
  expect(
    array((await json(await admin(r, "/request-metadata"))).requests).filter(
      (v) => v.operationId === "MutateCampaignBudgets",
    ),
  ).toHaveLength(1)
})
test("conversion uploads persist once and return indexed vendor duplicate/partial failures", async () => {
  const r = runtime(),
    c = consumer(r),
    validation = await json(await c.upload([conversion()], { validateOnly: true }))
  expect(validation.results).toBeUndefined()
  expect(validation.jobId).toBe("2147483648")
  expect(r.instance().state.conversions.count()).toBe(0)
  const firstUpload = await json(await c.upload([conversion()]))
  expect(firstUpload.jobId).toBe("2147483648")
  expect(array(firstUpload.results)[0]?.conversionAction).toBe(action)
  expect(array(firstUpload.results)[0]?.orderId).toBeUndefined()
  const errors = (v: Record<string, unknown>) =>
    array(first(array(record(v.partialFailureError).details)).errors)
  expect(errors(await json(await c.upload([conversion()])))[0]?.errorCode).toEqual({
    conversionUploadError: "ORDER_ID_ALREADY_IN_USE",
  })
  expect(r.instance().state.conversions.count()).toBe(1)
  const mixed = await json(
    await c.upload([
      conversion("new-order"),
      {
        ...conversion("invalid-order"),
        conversionAction: `customers/${DEFAULT_CUSTOMER}/conversionActions/8888888888`,
      },
    ]),
  )
  expect(array(mixed.results)[1]).toEqual({})
  expect(r.instance().state.conversions.count()).toBe(2)
  expect(
    array(
      (await json(await c.upload([conversion("batch-order"), conversion("batch-order")]))).results,
    ),
  ).toEqual([{}, {}])
  expect(r.instance().state.conversions.count()).toBe(2)
  const click = { ...conversion("click-order"), orderId: undefined }
  expect((await c.upload([click])).status).toBe(200)
  expect(errors(await json(await c.upload([click])))[0]?.errorCode).toEqual({
    conversionUploadError: "CLICK_CONVERSION_ALREADY_EXISTS",
  })
  const before = r.instance().state.conversions.count()
  expect(
    (
      await c.upload(
        [conversion("atomic-good"), { ...conversion("atomic-bad"), conversionDateTime: "bad" }],
        { partialFailure: false },
      )
    ).status,
  ).toBe(400)
  expect(r.instance().state.conversions.count()).toBe(before)
})
test("GA4 preserves event families, dedupes only web purchases by user/transaction, and reports paginated metrics", async () => {
  const r = runtime(),
    c = consumer(r),
    body = {
      client_id: "fixture-client",
      user_id: "fixture-user",
      timestamp_micros: now * 1000,
      events: [
        event("purchase"),
        event("refund", "fixture-refund", 2.25),
        event("renewal"),
        event("qualified_purchase"),
      ],
    }
  const response = await c.collect(body)
  expect(response.status).toBe(204)
  expect(await response.text()).toBe("")
  await c.collect(body)
  const events = array((await json(await admin(r, "/events"))).events)
  expect(events).toHaveLength(7)
  expect(record(events[0]?.event).params).toEqual(body.events[0]?.params)
  expect(events[0]?.user_id).toBe("fixture-user")
  expect(events[0]?.timestamp_micros).toBe(now * 1000)
  await c.collect({
    ...body,
    client_id: "fixture-other",
    user_id: "fixture-other-user",
    events: [event("purchase")],
  })
  expect(r.instance().state.events.count()).toBe(8)
  await c.collect({ ...body, events: [event("purchase", ""), event("purchase", "")] })
  expect(r.instance().state.events.count()).toBe(9)
  const report = await json(await c.report(reportBody)),
    rows = array(report.rows)
  expect(report.rowCount).toBe(4)
  expect(rows.map((v) => array(v.dimensionValues)[0]?.value)).toEqual([
    "purchase",
    "qualified_purchase",
    "refund",
    "renewal",
  ])
  expect(array(first(rows).metricValues).map((v) => v.value)).toEqual(["3", "38.25"])
  expect(array(present(rows[2]).metricValues).map((v) => v.value)).toEqual(["2", "-4.5"])
  const page = await json(await c.report({ ...reportBody, limit: "1", offset: "1" }))
  expect(page.rowCount).toBe(4)
  expect(array(page.rows)).toHaveLength(1)
  expect(array(first(array(page.rows)).dimensionValues)[0]?.value).toBe("qualified_purchase")
  expect(
    (
      await json(
        await c.report({
          ...reportBody,
          dimensionFilter: {
            filter: {
              fieldName: "eventName",
              stringFilter: { matchType: "EXACT", value: "purchase" },
            },
          },
        }),
      )
    ).rowCount,
  ).toBe(1)
  const batch = await c.request("/v1beta/properties/1000000001:batchRunReports", {
    requests: [reportBody, { ...reportBody, offset: "99" }],
  })
  expect(array((await json(batch)).reports)).toHaveLength(2)
  expect((await c.report({ ...reportBody, metrics: [{ name: "notAMetric" }] })).status).toBe(400)
})
test("GA4 production stays 204; debug never ingests; old/future timestamp policies and reporting lag are clock-controlled", async () => {
  const r = runtime(),
    c = consumer(r),
    b = { client_id: "fixture-client", events: [event("purchase")] }
  expect((await c.collect(b, false, "invalid-fixture-secret")).status).toBe(204)
  expect(r.instance().state.events.count()).toBe(0)
  expect((await c.collect(b, true, "invalid-fixture-secret")).status).toBe(200)
  expect(r.instance().state.events.count()).toBe(0)
  expect(
    array(
      (await json(await c.collect({ ...b, events: [event("1invalid")] }, true))).validationMessages,
    )[0]?.validationCode,
  ).toBe("NAME_INVALID")
  const malformed = await r.fetch(
    new Request(
      "http://mock.local/mp/collect?measurement_id=G-FIXTURE&api_secret=fixture-ga4-secret",
      { method: "POST", headers: { "content-type": "application/json" }, body: "{" },
    ),
  )
  expect(malformed.status).toBe(204)
  await c.collect({ ...b, timestamp_micros: (now + 60001) * 1000 })
  expect(r.instance().state.events.count()).toBe(0)
  expect(
    array(
      (await json(await c.collect({ ...b, timestamp_micros: (now + 60001) * 1000 }, true)))
        .validationMessages,
    )[0]?.validationCode,
  ).toBe("VALUE_OUT_OF_BOUNDS")
  await c.collect({ ...b, timestamp_micros: (now - 73 * 3600000) * 1000 })
  expect(r.instance().inspectEvents()[0]?.timestamp_micros).toBe((now - 72 * 3600000) * 1000)
  await c.collect({
    ...b,
    timestamp_micros: (now - 73 * 3600000) * 1000,
    validation_behavior: "ENFORCE_RECOMMENDATIONS",
    events: [event("purchase", "strict-old")],
  })
  expect(r.instance().state.events.count()).toBe(1)
  expect(
    (await admin(r, "/settings", "PUT", { reportingLagMs: 1000, futureToleranceMs: null })).status,
  ).toBe(200)
  await c.collect({ ...b, events: [event("renewal")] })
  expect((await json(await c.report(reportBody))).rowCount).toBe(0)
  r.clock.advance(1000)
  expect((await json(await c.report(reportBody))).rowCount).toBe(1)
})
test("OAuth scope and expiry errors coexist with optional ignored legacy developer-token", async () => {
  const r = createRuntime({
      clock: createClock(() => now),
      tokens: [
        { token: DEFAULT_TOKEN },
        { token: "fixture-expired", expiresAt: now },
        { token: "fixture-scoped", customerIds: [] },
        { token: "fixture-test-project", projectAccess: "test" },
      ],
    }),
    path = `/v25/customers/${DEFAULT_CUSTOMER}/googleAds:search`,
    body = { query: budgetQuery }
  for (const [token, code, kind] of [
    ["invalid", "OAUTH_TOKEN_INVALID", "authenticationError"],
    ["fixture-expired", "OAUTH_TOKEN_EXPIRED", "authenticationError"],
    ["fixture-scoped", "USER_PERMISSION_DENIED", "authorizationError"],
    ["fixture-test-project", "CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION", "authorizationError"],
  ] as const)
    expect(
      await errorCode(
        await new GoogleConsumer((req) => r.fetch(req), "http://mock.local", token).request(
          path,
          body,
        ),
      ),
    ).toEqual({ [kind]: code })
  expect(
    (
      await r.fetch(
        new Request(`http://mock.local${path}`, {
          method: "POST",
          headers: { authorization: `Bearer ${DEFAULT_TOKEN}`, "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      )
    ).status,
  ).toBe(200)
  expect(
    (
      await consumer(r).request(path, body, {
        "developer-token": "ignored-value",
        "login-customer-id": "1000000099",
      })
    ).status,
  ).toBe(200)
  expect(
    await errorCode(await consumer(r).request(path, body, { "login-customer-id": "1000000088" })),
  ).toEqual({ authorizationError: "INVALID_LOGIN_CUSTOMER_ID_SERVING_CUSTOMER_ID_COMBINATION" })
})
test("concurrent namespaces, reset, encrypted state and journals preserve isolation and fixtures", async () => {
  const r = runtime(),
    a = consumer(r, "suite-a"),
    b = consumer(r, "suite-b")
  await Promise.all([
    a.updateBudget(budget, "10000000"),
    b.updateBudget(budget, "20000000"),
    a.collect({
      client_id: "private-fixture-client",
      user_id: "private-fixture-user",
      events: [event("purchase")],
    }),
    b.collect({ client_id: "another-fixture-client", events: [event("renewal")] }),
  ])
  expect(await amount(a)).toBe("10000000")
  expect(await amount(b)).toBe("20000000")
  expect(await amount(consumer(r))).toBe("25000000")
  const genericState = await (await admin(r, "/state", "GET", undefined, "suite-a")).text(),
    journal = await (await admin(r, "/requests", "GET", undefined, "suite-a")).text()
  for (const sensitive of [
    "private-fixture-client",
    "private-fixture-user",
    "fixture-ga4-secret",
    "fixture-click",
    "fixture-order",
    DEFAULT_TOKEN,
  ]) {
    expect(genericState).not.toContain(sensitive)
    expect(journal).not.toContain(sensitive)
  }
  expect((await admin(r, "/events", "GET", undefined, "suite-a")).status).toBe(200)
  expect((await r.fetch(new Request("http://mock.local/__admin/events"))).status).toBe(401)
  expect((await admin(r, "/reset", "POST", {}, "suite-a")).status).toBe(200)
  expect(await amount(a)).toBe("25000000")
  expect(r.instance("suite-a").state.events.count()).toBe(0)
  expect(await amount(b)).toBe("20000000")
  const direct = new GoogleAdsAPI({ now: () => now }),
    dc = new GoogleConsumer((req) => direct.fetch(req))
  await dc.updateBudget(budget, "30000000")
  await direct.reset()
  expect(await amount(dc)).toBe("25000000")
})
