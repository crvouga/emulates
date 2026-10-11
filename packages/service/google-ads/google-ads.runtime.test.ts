import { expect, test } from "bun:test"
import { createClock } from "@crvouga/mockingbird-service"
import { present, record } from "./src/errors.js"
import {
  createRuntime,
  DEFAULT_ADMIN_KEY,
  DEFAULT_API_SECRET,
  DEFAULT_CUSTOMER,
  DEFAULT_TOKEN,
} from "./src/index.js"
import { createServer } from "./src/server.js"
import { GoogleConsumer } from "./test/consumer.js"

// The service request's test controls, each driven over /__admin exactly as a served stack would:
// the shared clock, request journal, fault injection and namespace carriers plus this service's
// own seeding, inspection and settings routes.
const now = 1791072000000
const hour = 3600000
const budget = `customers/${DEFAULT_CUSTOMER}/campaignBudgets/2000000001`
const action = `customers/${DEFAULT_CUSTOMER}/conversionActions/4000000001`
const searchPath = `/v25/customers/${DEFAULT_CUSTOMER}/googleAds:search`
const mutatePath = `/v25/customers/${DEFAULT_CUSTOMER}/campaignBudgets:mutate`
const dailyQuery = (range: string) =>
  `SELECT campaign.id, metrics.cost_micros, segments.date FROM campaign WHERE segments.date DURING ${range} ORDER BY segments.date`
const budgetQuery =
  "SELECT campaign_budget.id, campaign_budget.amount_micros FROM campaign_budget ORDER BY campaign_budget.id"
const runtime = () => createRuntime({ clock: createClock(() => now) })
type Runtime = ReturnType<typeof runtime>
const consumer = (r: Runtime, ns?: string) =>
  new GoogleConsumer((req) =>
    r.fetch(
      ns
        ? new Request(req, {
            headers: { ...Object.fromEntries(req.headers), "x-mockingbird-namespace": ns },
          })
        : req,
    ),
  )
const admin = (r: Runtime, path: string, method = "GET", body?: unknown, ns?: string) =>
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
const preset = async (r: Runtime, name: string, ns?: string) =>
  expect((await admin(r, "/faults", "POST", { preset: name }, ns)).status).toBe(201)
const failure = async (r: Response) => {
  const error = record((await json(r)).error),
    detail = record(array(error.details ?? [])[0])
  return { error, detail, errors: array(detail.errors ?? []) }
}
const amount = async (c: GoogleConsumer): Promise<unknown> =>
  (await c.search(budgetQuery)).results?.[0]?.campaignBudget?.amountMicros
const metric = (date: string, costMicros: string, extra: Record<string, unknown> = {}) => ({
  customerId: DEFAULT_CUSTOMER,
  campaignId: "3000000001",
  date,
  costMicros,
  clicks: "1",
  impressions: "10",
  conversions: 0.5,
  conversionsValue: 9.95,
  ...extra,
})
const renewal = (transaction: string) => ({
  name: "renewal",
  params: { transaction_id: transaction, currency: "USD", value: 4.5, session_id: 7 },
})
const conversion = (orderId: string) => ({
  gclid: `fixture-click-${orderId}`,
  conversionAction: action,
  conversionDateTime: "2026-10-03 12:00:00+00:00",
  conversionValue: 42.75,
  currencyCode: "USD",
  orderId,
})
const dates = async (c: GoogleConsumer, range: string) =>
  (await c.search(dailyQuery(range))).results?.map((row) => [
    row.segments?.date,
    row.metrics?.costMicros,
  ])
const eventCount = async (c: GoogleConsumer, startDate: string, endDate = startDate) =>
  (
    await json(
      await c.report({ metrics: [{ name: "eventCount" }], dateRanges: [{ startDate, endDate }] }),
    )
  ).rowCount

test("seeded daily metrics follow the shared clock: advancing the reporting date moves the Ads and GA4 relative ranges", async () => {
  const r = runtime(),
    c = consumer(r)
  const seeded = await admin(r, "/daily-metrics", "POST", {
    metrics: [metric("2026-10-05", "2000000"), metric("2026-10-06", "3000000")],
  })
  expect(seeded.status).toBe(201)
  expect(await json(seeded)).toEqual({ inserted: 2 })
  expect(await dates(c, "TODAY")).toEqual([["2026-10-04", "12345678"]])
  expect(await dates(c, "YESTERDAY")).toEqual([])
  expect(await json(await admin(r, "/clock", "POST", { advance: "1d" }))).toMatchObject({
    now: now + 24 * hour,
  })
  expect(await dates(c, "TODAY")).toEqual([["2026-10-05", "2000000"]])
  expect(await dates(c, "YESTERDAY")).toEqual([["2026-10-04", "12345678"]])
  await c.collect({ client_id: "fixture-client", events: [renewal("clock-a")] })
  expect(await eventCount(c, "today")).toBe(1)
  expect(await eventCount(c, "yesterday")).toBe(0)
  expect(
    (await admin(r, "/clock", "POST", { set: "2026-10-06T12:00:00.000Z", freeze: true })).status,
  ).toBe(200)
  expect(await json(await admin(r, "/clock"))).toMatchObject({
    now: Date.parse("2026-10-06T12:00:00.000Z"),
    frozen: true,
  })
  expect(await dates(c, "TODAY")).toEqual([["2026-10-06", "3000000"]])
  expect(await dates(c, "LAST_7_DAYS")).toEqual([
    ["2026-10-04", "12345678"],
    ["2026-10-05", "2000000"],
  ])
  expect(await eventCount(c, "today")).toBe(0)
  expect(await eventCount(c, "yesterday")).toBe(1)
  expect(await eventCount(c, "1daysAgo", "today")).toBe(1)
  // A rejected seed inserts nothing.
  expect(
    (await admin(r, "/daily-metrics", "POST", { metrics: [metric("2026-13-01", "1")] })).status,
  ).toBe(400)
  expect(r.instance().state.metrics.count()).toBe(3)
})
test("uploaded conversions and collected events are inspectable in arrival order behind the admin key", async () => {
  const r = runtime(),
    c = consumer(r)
  expect((await c.upload([conversion("inspect-a"), conversion("inspect-b")])).status).toBe(200)
  const conversions = array((await json(await admin(r, "/conversions"))).conversions)
  expect(conversions).toMatchObject([
    { ...conversion("inspect-a"), customerId: DEFAULT_CUSTOMER, availableAt: now },
    { ...conversion("inspect-b"), customerId: DEFAULT_CUSTOMER, availableAt: now },
  ])
  await c.collect({
    client_id: "fixture-client",
    user_id: "fixture-user",
    timestamp_micros: (now - hour) * 1000,
    events: [renewal("inspect-a"), { name: "refund", params: { transaction_id: "inspect-a" } }],
  })
  const events = array((await json(await admin(r, "/events"))).events)
  expect(events).toMatchObject([
    {
      client_id: "fixture-client",
      user_id: "fixture-user",
      timestamp_micros: (now - hour) * 1000,
      event: renewal("inspect-a"),
      propertyId: "1000000001",
      createdAt: now,
    },
    { event: { name: "refund", params: { transaction_id: "inspect-a" } } },
  ])
  for (const path of ["/events", "/conversions", "/budgets", "/budget-mutations", "/settings"])
    expect((await r.fetch(new Request(`http://mock.local/__admin${path}`))).status).toBe(401)
})
test("partial-failure presets fail the last item of one batch and apply the rest", async () => {
  const r = runtime(),
    c = consumer(r),
    create = (name: string) => ({ create: { name, amountMicros: "1000000" } })
  await preset(r, "partial_budget_failure")
  const budgets = await json(
    await c.request(mutatePath, {
      partialFailure: true,
      operations: [create("Fixture partial a"), create("Fixture partial b")],
    }),
  )
  expect(budgets.results).toEqual([
    { resourceName: `customers/${DEFAULT_CUSTOMER}/campaignBudgets/9000000001` },
    {},
  ])
  const budgetError = record(budgets.partialFailureError)
  expect(budgetError.code).toBe(3)
  expect(record(array(budgetError.details)[0]).errors).toMatchObject([
    {
      errorCode: { mutateError: "RESOURCE_NOT_FOUND" },
      location: { fieldPathElements: [{ fieldName: "operations", index: 1 }] },
    },
  ])
  expect(r.instance().state.budgets.count()).toBe(2)
  // One shot: the same batch item succeeds on the next request.
  expect(
    await json(
      await c.request(mutatePath, {
        partialFailure: true,
        operations: [create("Fixture partial b")],
      }),
    ),
  ).toEqual({
    results: [{ resourceName: `customers/${DEFAULT_CUSTOMER}/campaignBudgets/9000000002` }],
  })
  // Without partialFailure the batch is atomic: the injected failure rejects all of it.
  await preset(r, "partial_budget_failure")
  expect(
    (
      await c.request(mutatePath, {
        operations: [create("Fixture partial c"), create("Fixture partial d")],
      })
    ).status,
  ).toBe(400)
  expect(r.instance().state.budgets.count()).toBe(3)
  await preset(r, "partial_conversion_failure")
  const uploads = await json(await c.upload([conversion("partial-a"), conversion("partial-b")]))
  expect(array(uploads.results)[0]?.gclid).toBe("fixture-click-partial-a")
  expect(array(uploads.results)[1]).toEqual({})
  expect(record(array(record(uploads.partialFailureError).details)[0]).errors).toMatchObject([
    {
      errorCode: { conversionUploadError: "NO_CONVERSION_ACTION_FOUND" },
      location: { fieldPathElements: [{ fieldName: "conversions", index: 1 }] },
    },
  ])
  expect(array((await json(await admin(r, "/conversions"))).conversions)).toMatchObject([
    { orderId: "partial-a" },
  ])
  expect(array((await json(await c.upload([conversion("partial-b")]))).results)).toHaveLength(1)
})
test("quota and rate-limit presets answer one request with Google's 429 quota failure before any mutation", async () => {
  const r = runtime(),
    c = consumer(r)
  for (const [name, code] of [
    ["quota_exhausted", "RESOURCE_EXHAUSTED"],
    ["rate_limited", "RESOURCE_TEMPORARILY_EXHAUSTED"],
  ] as const) {
    await preset(r, name)
    const limited = await c.request(mutatePath, {
      operations: [
        { update: { resourceName: budget, amountMicros: "1" }, updateMask: "amount_micros" },
      ],
    })
    expect(limited.status).toBe(429)
    expect(limited.headers.get("request-id")).toBeString()
    const { error, detail, errors } = await failure(limited)
    expect(error).toMatchObject({ code: 429, status: "RESOURCE_EXHAUSTED" })
    expect(detail["@type"]).toBe(
      "type.googleapis.com/google.ads.googleads.v25.errors.GoogleAdsFailure",
    )
    expect(detail.requestId).toBe(limited.headers.get("request-id"))
    // The backoff is carried in QuotaErrorDetails, as a protobuf JSON Duration.
    expect(errors).toMatchObject([
      {
        errorCode: { quotaError: code },
        details: { quotaErrorDetails: { rateScope: "ACCOUNT", retryDelay: "1s" } },
      },
    ])
    expect(record(record(errors[0]?.details).quotaErrorDetails).rateName).toBeString()
    expect(await amount(c)).toBe("25000000")
    expect(r.instance().state.mutations.count()).toBe(0)
  }
  // The ported reader retries a throttled search; the journal shows both attempts.
  await preset(r, "rate_limited")
  expect(await amount(c)).toBe("25000000")
  const statuses = array(
    (await json(await admin(r, "/requests?operationId=SearchGoogleAds"))).requests,
  ).map((entry) => entry.status)
  expect(statuses.slice(-2)).toEqual([429, 200])
  // A sustained limit: the shared rule's count is the number of throttled requests.
  expect((await admin(r, "/faults", "POST", { preset: "rate_limited", count: 3 })).status).toBe(201)
  const attempts: number[] = []
  for (let i = 0; i < 4; i++)
    attempts.push((await c.request(searchPath, { query: budgetQuery })).status)
  expect(attempts).toEqual([429, 429, 429, 200])
})
test("reporting lag hides fresh events and not-yet-available metrics until the clock passes it", async () => {
  const r = runtime(),
    c = consumer(r)
  expect(await json(await admin(r, "/settings", "PUT", { reportingLagMs: hour }))).toMatchObject({
    reportingLagMs: hour,
  })
  await c.collect({ client_id: "fixture-client", events: [renewal("lag-a")] })
  expect(array((await json(await admin(r, "/events"))).events)).toMatchObject([
    { createdAt: now, availableAt: now + hour },
  ])
  expect(await eventCount(c, "2026-10-04")).toBe(0)
  expect(
    (
      await admin(r, "/daily-metrics", "POST", {
        metrics: [metric("2026-10-04", "1000000", { availableAt: now + hour })],
      })
    ).status,
  ).toBe(201)
  expect(await dates(c, "TODAY")).toEqual([["2026-10-04", "12345678"]])
  await admin(r, "/clock", "POST", { advance: hour - 1 })
  expect(await eventCount(c, "2026-10-04")).toBe(0)
  expect(await dates(c, "TODAY")).toEqual([["2026-10-04", "12345678"]])
  await admin(r, "/clock", "POST", { advance: 1 })
  expect(await eventCount(c, "2026-10-04")).toBe(1)
  expect(await dates(c, "TODAY")).toEqual([["2026-10-04", "13345678"]])
  for (const bad of [{ reportingLagMs: -1 }, { reportingLagMs: "soon" }, { unknownSetting: 1 }])
    expect((await admin(r, "/settings", "PUT", bad)).status).toBe(400)
  expect((await json(await admin(r, "/settings"))).reportingLagMs).toBe(hour)
})
test("latency, one-shot failure and connection-drop controls leave state untouched and clear after one request", async () => {
  const r = runtime(),
    c = consumer(r),
    timed = async () => {
      const started = performance.now(),
        response = await c.request(searchPath, { query: budgetQuery })
      return { status: response.status, elapsed: performance.now() - started }
    }
  await preset(r, "slow_response")
  const slow = await timed()
  expect(slow.status).toBe(200)
  expect(slow.elapsed).toBeGreaterThanOrEqual(45)
  expect(
    (await admin(r, "/faults", "POST", { operationId: "SearchGoogleAds", latencyMs: 30, count: 1 }))
      .status,
  ).toBe(201)
  expect((await timed()).elapsed).toBeGreaterThanOrEqual(25)
  await preset(r, "server_error")
  const failed = await c.request(mutatePath, {
    operations: [
      { update: { resourceName: budget, amountMicros: "1" }, updateMask: "amount_micros" },
    ],
  })
  expect(failed.status).toBe(500)
  const { error, errors } = await failure(failed)
  expect(error).toMatchObject({ code: 500, status: "INTERNAL" })
  expect(errors[0]?.errorCode).toEqual({ internalError: "INTERNAL_ERROR" })
  expect(await amount(c)).toBe("25000000")
  await preset(r, "network_reset")
  await expect(c.updateBudget(budget, "2")).rejects.toBeInstanceOf(TypeError)
  expect(await amount(c)).toBe("25000000")
  expect(r.instance().state.mutations.count()).toBe(0)
  expect(
    array((await json(await admin(r, "/faults"))).faults).filter((f) => f.remaining !== 0),
  ).toEqual([])
})
test("request inspection: the journal and request metadata record what arrived without bodies or credentials", async () => {
  const r = runtime(),
    c = consumer(r)
  await c.request(searchPath, { query: budgetQuery }, { "login-customer-id": "1000000099" })
  await c.request(searchPath, { query: "SELECT campaign.unrecognised FROM campaign" })
  await c.updateBudget(budget, "33000000")
  await c.collect({
    client_id: "private-fixture-client",
    events: [renewal("journal-a"), { name: "1invalid" }],
  })
  const journal = await admin(r, "/requests"),
    entries = array((await json(journal.clone())).requests)
  expect(
    entries.map((entry) => [entry.operationId, entry.method, entry.path, entry.status]),
  ).toEqual([
    ["SearchGoogleAds", "POST", searchPath, 200],
    ["SearchGoogleAds", "POST", searchPath, 400],
    ["MutateCampaignBudgets", "POST", mutatePath, 200],
    ["MutateCampaignBudgets", "POST", mutatePath, 200],
    ["CollectAnalyticsEvents", "POST", "/mp/collect", 204],
  ])
  expect(entries.every((entry) => entry.at === "2026-10-04T00:00:00.000Z")).toBe(true)
  expect(entries[2]?.ids).toEqual({ customer: DEFAULT_CUSTOMER })
  expect(
    array(
      (await json(await admin(r, "/requests?operationId=SearchGoogleAds&status=400"))).requests,
    ),
  ).toHaveLength(1)
  const requests = await admin(r, "/request-metadata"),
    rows = array((await json(requests.clone())).requests)
  expect(rows).toMatchObject([
    {
      operationId: "SearchGoogleAds",
      customerId: DEFAULT_CUSTOMER,
      developerTokenPresent: true,
      loginCustomerPresent: true,
      createdAt: now,
    },
    { operationId: "SearchGoogleAds", loginCustomerPresent: false },
    { operationId: "MutateCampaignBudgets", validateOnly: true },
    { operationId: "MutateCampaignBudgets" },
    {
      operationId: "CollectAnalyticsEvents",
      propertyId: "1000000001",
      eventCount: 2,
      accepted: 1,
      rejected: 1,
      duplicate: 0,
      reasons: ["NAME_INVALID"],
    },
  ])
  expect(rows.every((row) => /^[0-9a-f]{64}$/.test(String(row.bodyHash)))).toBe(true)
  expect(rows[3]?.validateOnly).toBeUndefined()
  for (const text of [await journal.text(), await requests.text()])
    for (const sensitive of [
      DEFAULT_TOKEN,
      DEFAULT_API_SECRET,
      "legacy-fixture-developer-token",
      "private-fixture-client",
      "journal-a",
      "campaign_budget.amount_micros",
    ])
      expect(text).not.toContain(sensitive)
  expect((await admin(r, "/requests", "DELETE")).status).toBe(200)
  expect(array((await json(await admin(r, "/requests"))).requests)).toEqual([])
})
test("page tokens live for two hours on the shared clock and the page-size setting never reaches the wire", async () => {
  const r = runtime(),
    c = consumer(r),
    query = "SELECT campaign.id, segments.date FROM campaign ORDER BY segments.date"
  expect(await json(await admin(r, "/settings"))).toEqual({
    reportingLagMs: 0,
    pageTokenTtlMs: 2 * hour,
    futureToleranceMs: 60000,
    searchPageSize: 10000,
  })
  await admin(r, "/daily-metrics", "POST", {
    metrics: [metric("2026-10-02", "1"), metric("2026-10-03", "2")],
  })
  expect((await admin(r, "/settings", "PUT", { searchPageSize: 1 })).status).toBe(200)
  const page = await c.search(query),
    next = { query, pageToken: present(page.nextPageToken) }
  expect(page.results).toEqual([
    { campaign: { id: "3000000001" }, segments: { date: "2026-10-02" } },
  ])
  await admin(r, "/clock", "POST", { advance: 2 * hour - 1 })
  const second = await json(await c.request(searchPath, next))
  expect(second.results).toEqual([
    { campaign: { id: "3000000001" }, segments: { date: "2026-10-03" } },
  ])
  await admin(r, "/clock", "POST", { advance: 1 })
  const expired = await c.request(searchPath, next)
  expect(expired.status).toBe(400)
  expect((await failure(expired)).errors[0]?.errorCode).toEqual({
    requestError: "EXPIRED_PAGE_TOKEN",
  })
  // A fresh query starts a new snapshot and walks every row exactly once.
  expect((await c.all(query)).map((row) => row.segments?.date)).toEqual([
    "2026-10-02",
    "2026-10-03",
    "2026-10-04",
  ])
})
test("faults, settings and seeded data are scoped to the calling namespace and restored by reset", async () => {
  const r = runtime(),
    a = consumer(r, "suite-a"),
    b = consumer(r, "suite-b")
  await preset(r, "rate_limited", "suite-a")
  expect((await b.request(searchPath, { query: budgetQuery })).status).toBe(200)
  expect((await a.request(searchPath, { query: budgetQuery })).status).toBe(429)
  await admin(r, "/settings", "PUT", { reportingLagMs: hour, searchPageSize: 1 }, "suite-a")
  await admin(r, "/daily-metrics", "POST", { metrics: [metric("2026-10-03", "5")] }, "suite-a")
  expect(await json(await admin(r, "/settings", "GET", undefined, "suite-b"))).toMatchObject({
    reportingLagMs: 0,
    searchPageSize: 10000,
  })
  expect(await dates(b, "LAST_7_DAYS")).toEqual([])
  expect(await dates(a, "LAST_7_DAYS")).toEqual([["2026-10-03", "5"]])
  // The path carrier selects the same namespace as the header.
  expect(
    await json(
      await r.fetch(
        new Request("http://mock.local/__admin/ns/suite-a/__admin/settings", {
          headers: { "x-mockingbird-admin-key": DEFAULT_ADMIN_KEY },
        }),
      ),
    ),
  ).toMatchObject({ searchPageSize: 1 })
  expect((await admin(r, "/reset", "POST", {}, "suite-a")).status).toBe(200)
  expect(await json(await admin(r, "/settings", "GET", undefined, "suite-a"))).toMatchObject({
    reportingLagMs: 0,
    searchPageSize: 10000,
  })
  expect(await dates(a, "LAST_7_DAYS")).toEqual([])
})
test("served over HTTP, the ported wire flow sends events, reads every page, preflights then mutates a budget and reconciles an ambiguous write without a duplicate", async () => {
  const server = await createServer({ clock: createClock(() => now) })
  try {
    // test/consumer.ts ports the request's wire description; it is not the requesting client.
    const c = new GoogleConsumer((request) => fetch(request), server.url),
      control = async (path: string, method = "GET", body?: unknown) =>
        record(
          await (
            await fetch(`${server.url}/__admin${path}`, {
              method,
              headers: {
                "x-mockingbird-admin-key": DEFAULT_ADMIN_KEY,
                "content-type": "application/json",
              },
              ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            })
          ).json(),
        )
    const sent = await c.collect({
      client_id: "fixture-client",
      user_id: "fixture-user",
      timestamp_micros: now * 1000,
      events: ["purchase", "refund", "renewal", "qualified_purchase"].map((name) => ({
        name,
        params: {
          transaction_id: `flow-${name}`,
          currency: "USD",
          value: 19.99,
          session_id: 7,
          engagement_time_msec: 100,
          gclid: "fixture-click",
        },
      })),
    })
    expect(sent.status).toBe(204)
    expect(await sent.text()).toBe("")
    expect(array((await control("/events")).events).map((e) => record(e.event).name)).toEqual([
      "purchase",
      "refund",
      "renewal",
      "qualified_purchase",
    ])
    await control("/daily-metrics", "POST", {
      metrics: ["2026-10-01", "2026-10-02", "2026-10-03"].map((date) => metric(date, "1000000")),
    })
    await control("/settings", "PUT", { searchPageSize: 2 })
    const rows = await c.all(
      "SELECT campaign.id, campaign.name, metrics.cost_micros, metrics.conversions_value, segments.date FROM campaign ORDER BY segments.date",
    )
    expect(rows.map((row) => row.segments?.date)).toEqual([
      "2026-10-01",
      "2026-10-02",
      "2026-10-03",
      "2026-10-04",
    ])
    expect(rows[0]?.metrics).toEqual({ costMicros: "1000000", conversionsValue: 9.95 })
    await control("/faults", "POST", { preset: "ambiguous_budget_write" })
    const uncertain = await c.updateBudget(budget, "48000000")
    expect(uncertain.status).toBe(503)
    // Reconcile by reading instead of replaying: the write landed exactly once.
    expect(await amount(c)).toBe("48000000")
    const applied = array((await control("/budget-mutations")).mutations)
    expect(applied).toMatchObject([
      {
        requestId: uncertain.headers.get("request-id"),
        before: { amountMicros: "25000000" },
        after: { amountMicros: "48000000" },
      },
    ])
    const writes = array(
      (await control("/requests?operationId=MutateCampaignBudgets")).requests,
    ).map((entry) => entry.status)
    expect(writes).toEqual([200, 503])
  } finally {
    await server.close()
  }
})
