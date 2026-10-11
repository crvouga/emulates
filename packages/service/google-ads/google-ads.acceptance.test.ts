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

// The service request's five numbered behaviours, one test each (the fifth is the namespace test
// above), then the exact-contract bullets the earlier tests leave unpinned. Vendor expectations
// follow the pinned v25 protos and Google's guides; the README section "Where Google differs from
// a common assumption" lists where the request assumed otherwise.
const searchPath = `/v25/customers/${DEFAULT_CUSTOMER}/googleAds:search`
const mutatePath = `/v25/customers/${DEFAULT_CUSTOMER}/campaignBudgets:mutate`
const failureType = "type.googleapis.com/google.ads.googleads.v25.errors.GoogleAdsFailure"
const update = (amountMicros: string, resourceName = budget) => ({
  operations: [{ update: { resourceName, amountMicros }, updateMask: "amount_micros" }],
})
const envelope = async (r: Response) => {
  const error = record((await json(r)).error),
    detail = record(array(error.details ?? [])[0])
  return { error, detail, errors: array(detail.errors ?? []) }
}
const metadata = async (r: ReturnType<typeof runtime>, operationId: string) =>
  array((await json(await admin(r, "/request-metadata"))).requests).filter(
    (v) => v.operationId === operationId,
  )
const mutations = async (r: ReturnType<typeof runtime>) =>
  array((await json(await admin(r, "/budget-mutations"))).mutations)

test("behaviour 1: writes answer with the vendor status, body and headers and the matching read returns the persisted resource", async () => {
  const r = runtime(),
    c = consumer(r),
    name = `customers/${DEFAULT_CUSTOMER}/campaignBudgets/9000000001`
  const created = await c.request(mutatePath, {
    operations: [{ create: { name: "Fixture launch budget", amountMicros: "12340000" } }],
    responseContentType: "MUTABLE_RESOURCE",
  })
  expect(created.status).toBe(200)
  expect(created.headers.get("content-type")).toContain("application/json")
  expect(created.headers.get("request-id")).toBeString()
  expect(await json(created)).toEqual({
    results: [
      {
        resourceName: name,
        campaignBudget: {
          resourceName: name,
          name: "Fixture launch budget",
          amountMicros: "12340000",
          explicitlyShared: true,
          deliveryMethod: "STANDARD",
        },
      },
    ],
  })
  const read = (id: string) =>
    c.search(
      `SELECT campaign_budget.resource_name, campaign_budget.name, campaign_budget.amount_micros, campaign_budget.status FROM campaign_budget WHERE campaign_budget.id = ${id}`,
    )
  expect((await read("9000000001")).results).toEqual([
    {
      campaignBudget: {
        resourceName: name,
        name: "Fixture launch budget",
        amountMicros: "12340000",
        status: "ENABLED",
      },
    },
  ])
  // RESOURCE_NAME_ONLY is the default response content type.
  expect(await json(await c.request(mutatePath, update("31000000")))).toEqual({
    results: [{ resourceName: budget }],
  })
  expect((await read("2000000001")).results?.[0]?.campaignBudget?.amountMicros).toBe("31000000")
  const uploaded = await c.upload([conversion()])
  expect(uploaded.status).toBe(200)
  expect(uploaded.headers.get("request-id")).toBeString()
  expect(await json(uploaded)).toEqual({
    jobId: "2147483648",
    results: [
      {
        gclid: "fixture-click-fixture-conversion-order",
        conversionAction: action,
        conversionDateTime: "2026-10-03 12:00:00+00:00",
      },
    ],
  })
  expect(array((await json(await admin(r, "/conversions"))).conversions)).toMatchObject([
    { ...conversion(), customerId: DEFAULT_CUSTOMER },
  ])
  const collected = await c.collect({
    client_id: "fixture-client",
    user_id: "fixture-user",
    events: [event("purchase")],
  })
  expect(collected.status).toBe(204)
  expect(await collected.text()).toBe("")
  expect(array((await json(await c.report(reportBody))).rows)).toEqual([
    {
      dimensionValues: [{ value: "purchase" }],
      metricValues: [{ value: "1" }, { value: "12.75" }],
    },
  ])
})
test("behaviour 2: repeating a write under the same vendor dedupe field has no second side effect", async () => {
  const r = runtime(),
    c = consumer(r),
    create = {
      operations: [{ create: { name: "Fixture dedupe budget", amountMicros: "5000000" } }],
    }
  expect((await c.request(mutatePath, create)).status).toBe(200)
  // Google Ads mutates take no idempotency key: a shared budget's name is the duplicate guard.
  const repeated = await envelope(await c.request(mutatePath, create))
  expect(repeated.errors[0]?.errorCode).toEqual({ campaignBudgetError: "DUPLICATE_NAME" })
  expect(repeated.errors[0]?.location).toEqual({
    fieldPathElements: [{ fieldName: "operations", index: 0 }],
  })
  expect(r.instance().state.budgets.count()).toBe(2)
  expect(await mutations(r)).toHaveLength(1)
  expect((await c.upload([conversion("dedupe-order")])).status).toBe(200)
  const again = await json(await c.upload([conversion("dedupe-order")]))
  expect(array(again.results)).toEqual([{}])
  expect(
    array(first(array(record(again.partialFailureError).details)).errors)[0]?.errorCode,
  ).toEqual({ conversionUploadError: "ORDER_ID_ALREADY_IN_USE" })
  expect(array((await json(await admin(r, "/conversions"))).conversions)).toHaveLength(1)
  const purchase = {
    client_id: "fixture-client",
    user_id: "fixture-user",
    events: [event("purchase", "dedupe-transaction")],
  }
  expect((await c.collect(purchase)).status).toBe(204)
  expect((await c.collect(purchase)).status).toBe(204)
  expect(array((await json(await admin(r, "/events"))).events)).toHaveLength(1)
  expect(
    (await metadata(r, "CollectAnalyticsEvents")).map((v) => [v.accepted, v.duplicate]),
  ).toEqual([
    [1, 0],
    [0, 1],
  ])
})
test("behaviour 3: missing, malformed and unauthorized input return Google's error status, code, message and request id", async () => {
  const r = runtime(),
    c = consumer(r),
    raw = (path: string, body: string, headers: Record<string, string> = {}) =>
      r.fetch(
        new Request(`http://mock.local${path}`, {
          method: "POST",
          headers: { "content-type": "application/json", ...headers },
          body,
        }),
      ),
    bearer = { authorization: `Bearer ${DEFAULT_TOKEN}` }
  const unauthenticated = await raw(searchPath, JSON.stringify({ query: budgetQuery }))
  expect(unauthenticated.status).toBe(401)
  const missing = await envelope(unauthenticated)
  expect(missing.error).toMatchObject({ code: 401, status: "UNAUTHENTICATED" })
  expect(missing.detail["@type"]).toBe(failureType)
  expect(missing.errors).toEqual([
    {
      errorCode: { authenticationError: "OAUTH_TOKEN_INVALID" },
      message: "Invalid OAuth bearer token",
    },
  ])
  // The failure's requestId is the request-id response header.
  expect(missing.detail.requestId).toBeString()
  expect(missing.detail.requestId).toBe(unauthenticated.headers.get("request-id"))
  const unparsable = await raw(searchPath, "{", bearer)
  expect(unparsable.status).toBe(400)
  expect(unparsable.headers.get("request-id")).toBeString()
  expect((await envelope(unparsable)).error).toEqual({
    code: 400,
    message: "Invalid JSON payload received.",
    status: "INVALID_ARGUMENT",
  })
  const noQuery = await envelope(await c.request(searchPath, {}))
  // The top-level message is the canonical status text; the specific reason is per error.
  expect(noQuery.error).toMatchObject({
    code: 400,
    status: "INVALID_ARGUMENT",
    message: "Request contains an invalid argument.",
  })
  expect(noQuery.errors[0]).toMatchObject({
    message: "Missing or invalid query",
    location: { fieldPathElements: [{ fieldName: "query" }] },
  })
  for (const [query, code] of [
    ["DELETE FROM campaign", "EXPECTED_SELECT"],
    ["SELECT campaign.unrecognised FROM campaign", "UNRECOGNIZED_FIELD"],
    ["SELECT campaign.id FROM keyword_view", "BAD_RESOURCE_TYPE_IN_FROM_CLAUSE"],
    ["SELECT campaign.id FROM campaign LIMIT 0", "BAD_LIMIT_VALUE"],
    ["SELECT campaign.id FROM campaign trailing", "UNEXPECTED_INPUT"],
  ] as const) {
    const response = await c.request(searchPath, { query }),
      invalidQuery = await envelope(response)
    expect(response.status).toBe(400)
    expect(invalidQuery.errors[0]?.errorCode).toEqual({ queryError: code })
    expect(invalidQuery.detail.requestId).toBe(response.headers.get("request-id"))
  }
  const errorOf = async (body: unknown) =>
    (await envelope(await c.request(mutatePath, body))).errors[0]
  expect(
    (await errorOf(update("1", `customers/${DEFAULT_CUSTOMER}/campaignBudgets/8888888888`)))
      ?.errorCode,
  ).toEqual({ mutateError: "RESOURCE_NOT_FOUND" })
  expect((await errorOf(update("1", "campaignBudgets/2000000001")))?.errorCode).toEqual({
    requestError: "RESOURCE_NAME_MALFORMED",
  })
  expect(
    await errorOf({ operations: [{ update: { resourceName: budget, amountMicros: "1" } }] }),
  ).toMatchObject({
    errorCode: { fieldMaskError: "FIELD_MASK_MISSING" },
    location: {
      fieldPathElements: [{ fieldName: "operations", index: 0 }, { fieldName: "updateMask" }],
    },
  })
  expect((await errorOf(update("not-a-number")))?.errorCode).toEqual({
    fieldError: "INVALID_VALUE",
  })
  expect(await amount(c)).toBe("25000000")
  // Measurement Protocol credentials and payload problems never surface as an HTTP error.
  const wrongSecret = await c.collect(
    { client_id: "fixture-client", events: [event("purchase")] },
    false,
    "wrong-fixture-secret",
  )
  expect(wrongSecret.status).toBe(204)
  expect(r.instance().state.events.count()).toBe(0)
  expect((await metadata(r, "CollectAnalyticsEvents")).at(-1)).toMatchObject({
    accepted: 0,
    rejected: 1,
    reasons: ["INVALID_MEASUREMENT_CREDENTIALS"],
  })
  expect(
    array((await json(await c.collect({ events: [event("purchase")] }, true))).validationMessages),
  ).toEqual([
    {
      fieldPath: "client_id",
      description: "client_id is required",
      validationCode: "VALUE_REQUIRED",
    },
  ])
  // The Analytics Data API is a different Google service: a plain google.rpc error, no Ads
  // failure detail and no request-id header.
  const report = "/v1beta/properties/1000000001:runReport"
  for (const [response, status, code] of [
    [await raw(report, JSON.stringify(reportBody)), 401, "UNAUTHENTICATED"],
    [
      await raw("/v1beta/properties/42:runReport", JSON.stringify(reportBody), bearer),
      403,
      "PERMISSION_DENIED",
    ],
    [await raw(report, "{", bearer), 400, "INVALID_ARGUMENT"],
    [
      await raw(report, JSON.stringify({ metrics: [{ name: "notAMetric" }] }), bearer),
      400,
      "INVALID_ARGUMENT",
    ],
  ] as const) {
    expect(response.status).toBe(status)
    expect(response.headers.get("request-id")).toBeNull()
    const body = record((await json(response)).error)
    expect(body).toMatchObject({ code: status, status: code })
    expect(body.message).toBeString()
    expect(body.details).toBeUndefined()
  }
})
test(
  "behaviour 4: every row is reachable exactly once, in query order, across fixed 10000-row pages",
  async () => {
    const ids = Array.from({ length: 20001 }, (_, i) => String(3000000001 + i))
    const sqlite = nativeSqlite()
    const r = createRuntime({
        sqlite,
        clock: createClock(() => now),
        campaigns: ids.map((id) => ({
          customerId: DEFAULT_CUSTOMER,
          id,
          name: `Fixture ${id}`,
          budgetId: "2000000001",
          status: "ENABLED",
        })),
        metrics: [],
      }),
      c = consumer(r),
      query = "SELECT campaign.id FROM campaign ORDER BY campaign.id DESC"
    const pages: SearchResult[] = []
    let token: string | undefined
    do {
      const page = await c.search(query, token ? { pageToken: token } : {})
      pages.push(page)
      token = page.nextPageToken
    } while (token)
    expect(pages.map((p) => p.results?.length)).toEqual([10000, 10000, 1])
    expect(new Set(pages.map((p) => p.nextPageToken)).size).toBe(3)
    expect(pages[2]?.nextPageToken).toBeUndefined()
    expect(pages.flatMap((p) => p.results ?? []).map((row) => row.campaign?.id)).toEqual(
      [...ids].reverse(),
    )
    expect((await c.all(`${query} LIMIT 10001`)).length).toBe(10001)
    sqlite.close()
    // The Analytics Data API pages by offset and limit over a stable order.
    const analytics = runtime(),
      a = consumer(analytics)
    await a.collect({
      client_id: "fixture-client",
      events: ["purchase", "refund", "renewal", "qualified_purchase"].map((n) => event(n, n)),
    })
    const names: unknown[] = []
    for (let offset = 0; ; offset += 3) {
      const page = await json(await a.report({ ...reportBody, limit: "3", offset: String(offset) }))
      expect(page.rowCount).toBe(4)
      const rows = array(page.rows)
      names.push(...rows.map((row) => array(row.dimensionValues)[0]?.value))
      if (rows.length < 3) break
    }
    expect(names).toEqual(["purchase", "qualified_purchase", "refund", "renewal"])
  },
  { timeout: 60000 },
)
test("GA4 timestamp rejections are inspectable through the debug endpoint and request metadata while collect stays 204", async () => {
  const r = runtime(),
    c = consumer(r),
    hour = 3600000,
    body = (extra: Record<string, unknown>) => ({
      client_id: "fixture-client",
      events: [event("renewal")],
      ...extra,
    }),
    last = async () => present((await metadata(r, "CollectAnalyticsEvents")).at(-1)),
    messages = async (extra: Record<string, unknown>) =>
      array((await json(await c.collect(body(extra), true))).validationMessages)
  // More than the configured minute ahead: dropped, never an HTTP error.
  const future = { timestamp_micros: (now + 60001) * 1000 }
  const ahead = await c.collect(body(future))
  expect(ahead.status).toBe(204)
  expect(await ahead.text()).toBe("")
  expect(r.instance().state.events.count()).toBe(0)
  expect(await last()).toMatchObject({
    eventCount: 1,
    accepted: 0,
    rejected: 1,
    reasons: ["VALUE_OUT_OF_BOUNDS"],
  })
  expect(await messages(future)).toEqual([
    {
      fieldPath: "events[0].timestamp_micros",
      description: "Timestamp exceeds the configured local future tolerance",
      validationCode: "VALUE_OUT_OF_BOUNDS",
    },
  ])
  expect(await messages({ timestamp_micros: (now + 60000) * 1000 })).toEqual([])
  await c.collect(body({ timestamp_micros: (now + 60000) * 1000 }))
  expect(await last()).toMatchObject({ accepted: 1, rejected: 0, reasons: [] })
  // Older than 72 hours: default (RELAXED) validation accepts and overrides the timestamp.
  const stale = { timestamp_micros: (now - 72 * hour - 1) * 1000 }
  expect(await messages(stale)).toEqual([])
  await c.collect(body(stale))
  expect(await last()).toMatchObject({ accepted: 1, rejected: 0 })
  expect(r.instance().inspectEvents().at(-1)?.timestamp_micros).toBe((now - 72 * hour) * 1000)
  await c.collect(body({ timestamp_micros: (now - 72 * hour) * 1000 + 1 }))
  expect(r.instance().inspectEvents().at(-1)?.timestamp_micros).toBe((now - 72 * hour) * 1000 + 1)
  // ENFORCE_RECOMMENDATIONS rejects it instead.
  const strict = { ...stale, validation_behavior: "ENFORCE_RECOMMENDATIONS" }
  expect((await c.collect(body(strict))).status).toBe(204)
  expect(await last()).toMatchObject({ accepted: 0, rejected: 1, reasons: ["VALUE_OUT_OF_BOUNDS"] })
  expect(await messages(strict)).toEqual([
    {
      fieldPath: "events[0].timestamp_micros",
      description: "Timestamp is older than 72 hours",
      validationCode: "VALUE_OUT_OF_BOUNDS",
    },
  ])
  expect(r.instance().state.events.count()).toBe(3)
  // The debug endpoint validates only: nothing it saw was stored.
  expect((await metadata(r, "ValidateAnalyticsEvents")).every((v) => v.accepted === 0)).toBe(true)
  // A request carries at most 25 events.
  const many = (count: number) => ({
    events: Array.from({ length: count }, () => event("renewal")),
  })
  expect(await messages(many(25))).toEqual([])
  expect((await messages(many(26)))[0]?.validationCode).toBe("EXCEEDED_MAX_ENTITIES")
})
test("budget validate-only preflight returns no results and changes nothing; the real mutation persists once with before and after state", async () => {
  const r = runtime(),
    c = consumer(r),
    budgets = async () => array((await json(await admin(r, "/budgets"))).budgets)
  expect((await budgets()).map((b) => b.amountMicros)).toEqual(["25000000"])
  const preflight = await c.request(mutatePath, { ...update("31000000"), validateOnly: true })
  expect(preflight.status).toBe(200)
  expect(await json(preflight)).toEqual({})
  expect(await amount(c)).toBe("25000000")
  expect(await mutations(r)).toEqual([])
  // A preflight still reports what the real call would reject.
  const rejected = await c.request(mutatePath, {
    ...update("31000000", `customers/${DEFAULT_CUSTOMER}/campaignBudgets/8888888888`),
    validateOnly: true,
  })
  expect(rejected.status).toBe(400)
  expect((await envelope(rejected)).errors[0]?.errorCode).toEqual({
    mutateError: "RESOURCE_NOT_FOUND",
  })
  const real = await c.updateBudget(budget, "31000000")
  expect(await json(real)).toEqual({ results: [{ resourceName: budget }] })
  expect(await amount(c)).toBe("31000000")
  expect(await mutations(r)).toMatchObject([
    {
      requestId: real.headers.get("request-id"),
      resourceName: budget,
      before: { amountMicros: "25000000" },
      after: { amountMicros: "31000000" },
      createdAt: now,
    },
  ])
  expect((await budgets()).map((b) => b.amountMicros)).toEqual(["31000000"])
  expect((await metadata(r, "MutateCampaignBudgets")).map((v) => v.validateOnly)).toEqual([
    true,
    true,
    true,
    undefined,
  ])
})
test("an ambiguous failure after the real mutation of a preflight + real pair is inspectable and a retry cannot duplicate it", async () => {
  const r = runtime(),
    c = consumer(r)
  expect((await admin(r, "/faults", "POST", { preset: "ambiguous_budget_write" })).status).toBe(201)
  // The preflight executes nothing, so the fault waits for the real call that follows it.
  const uncertain = await c.updateBudget(budget, "61000000")
  expect(uncertain.status).toBe(503)
  expect(record((await json(uncertain)).error)).toMatchObject({ code: 503, status: "UNAVAILABLE" })
  const requests = await metadata(r, "MutateCampaignBudgets")
  expect(requests.map((v) => v.validateOnly)).toEqual([true, undefined])
  // Reconcile instead of replaying: the audit trail names the request that was applied.
  expect(await mutations(r)).toMatchObject([
    {
      requestId: uncertain.headers.get("request-id"),
      before: { amountMicros: "25000000" },
      after: { amountMicros: "61000000" },
    },
  ])
  expect(await amount(c)).toBe("61000000")
  expect(await metadata(r, "MutateCampaignBudgets")).toHaveLength(2)
  expect((await c.updateBudget(budget, "62000000")).status).toBe(200)
  // An uncertain create that is blindly replayed is refused by the duplicate-name rule.
  const create = {
    operations: [{ create: { name: "Fixture uncertain budget", amountMicros: "7000000" } }],
  }
  expect((await admin(r, "/faults", "POST", { preset: "ambiguous_budget_write" })).status).toBe(201)
  expect((await c.request(mutatePath, create)).status).toBe(503)
  expect((await envelope(await c.request(mutatePath, create))).errors[0]?.errorCode).toEqual({
    campaignBudgetError: "DUPLICATE_NAME",
  })
  const named = (await c.search(budgetQuery)).results?.filter(
    (row) => row.campaignBudget?.name === "Fixture uncertain budget",
  )
  expect(named).toHaveLength(1)
  expect(await mutations(r)).toHaveLength(3)
})
test("fixtures cover multi-page campaign results, no-data ranges, decimal conversion values and budget state", async () => {
  const campaigns = ["3000000001", "3000000002", "3000000003", "3000000004", "3000000005"]
  const r = createRuntime({
      clock: createClock(() => now),
      campaigns: campaigns.map((id) => ({
        customerId: DEFAULT_CUSTOMER,
        id,
        name: `Fixture ${id}`,
        budgetId: "2000000001",
        status: "ENABLED",
      })),
      metrics: campaigns.map((campaignId, i) => ({
        customerId: DEFAULT_CUSTOMER,
        campaignId,
        date: "2026-10-04",
        costMicros: String(1000000 * (i + 1)),
        clicks: String(i),
        impressions: String(10 * i),
        conversions: 0.25 * (i + 1),
        conversionsValue: 19.99,
        conversionActionId: "4000000001",
      })),
    }),
    c = consumer(r),
    query =
      "SELECT campaign.id, campaign.name, metrics.cost_micros, metrics.conversions, metrics.conversions_value, segments.date, segments.conversion_action_category FROM campaign WHERE segments.date BETWEEN '2026-10-01' AND '2026-10-31' ORDER BY campaign.id"
  // Google fixes the page at 10000 rows; the admin setting shrinks it so a small fixture pages.
  expect((await c.search(query)).nextPageToken).toBeUndefined()
  expect((await json(await admin(r, "/settings"))).searchPageSize).toBe(10000)
  expect((await admin(r, "/settings", "PUT", { searchPageSize: 2 })).status).toBe(200)
  const firstPage = await c.search(query)
  expect(firstPage.results).toHaveLength(2)
  expect(firstPage.nextPageToken).toBeString()
  const rows = await c.all(query)
  expect(rows.map((row) => row.campaign?.id)).toEqual(campaigns)
  expect(rows.map((row) => row.metrics?.conversions)).toEqual([0.25, 0.5, 0.75, 1, 1.25])
  expect(rows.every((row) => row.metrics?.conversionsValue === 19.99)).toBe(true)
  expect(rows[4]).toEqual({
    campaign: { id: "3000000005", name: "Fixture 3000000005" },
    metrics: { costMicros: "5000000", conversions: 1.25, conversionsValue: 19.99 },
    segments: { date: "2026-10-04", conversionActionCategory: "PURCHASE" },
  })
  // The request still cannot choose a page size.
  expect(await errorCode(await c.request(searchPath, { query, pageSize: 2 }))).toEqual({
    requestError: "PAGE_SIZE_NOT_SUPPORTED",
  })
  for (const bad of [0, 10001, "2"])
    expect((await admin(r, "/settings", "PUT", { searchPageSize: bad })).status).toBe(400)
  const empty = await c.search(query.replaceAll("2026-10", "2026-09"))
  expect(empty.results).toEqual([])
  expect(empty.nextPageToken).toBeUndefined()
  expect(
    await json(
      await c.report({
        ...reportBody,
        dateRanges: [{ startDate: "2026-09-01", endDate: "2026-09-30" }],
      }),
    ),
  ).toMatchObject({ rows: [], rowCount: 0 })
  expect(array((await json(await admin(r, "/budgets"))).budgets)).toMatchObject([
    { id: "2000000001", amountMicros: "25000000", status: "ENABLED" },
  ])
  expect((await c.updateBudget(budget, "26500000")).status).toBe(200)
  expect(array((await json(await admin(r, "/budgets"))).budgets)).toMatchObject([
    { id: "2000000001", amountMicros: "26500000", status: "ENABLED" },
  ])
})
