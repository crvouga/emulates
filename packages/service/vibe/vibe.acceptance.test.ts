import { expect, test } from "bun:test"
import { createClock } from "@crvouga/mockingbird-service"
import { createRuntime, DEFAULT_ADVERTISER, VIBE_PRESETS } from "./src/index.js"
import { createServer } from "./src/server.js"
import { client } from "./test/consumer.js"

const body = {
  start_date: "2026-01-01",
  end_date: "2026-01-03",
  advertiser_ids: [DEFAULT_ADVERTISER],
  dimensions: ["impression_date", "campaign_id", "campaign_name"],
  metrics: [
    "spend",
    "impressions",
    "number_of_purchases",
    "number_of_leads",
    "amount_of_purchases",
  ],
  granularity: "DAY",
  format: "JSON",
}
const setup = (adminPrefix = "/__admin") => {
  const clock = createClock(() => Date.UTC(2026, 0, 1)),
    runtime = createRuntime({
      clock,
      adminPrefix,
      rows: [
        {
          advertiser_id: DEFAULT_ADVERTISER,
          impression_date: "2026-01-02",
          campaign_id: "synthetic",
          campaign_name: "Synthetic campaign",
          spend: "12.50",
          impressions: 120,
          number_of_purchases: 1,
          number_of_leads: 2,
          amount_of_purchases: "25.00",
        },
        { advertiser_id: DEFAULT_ADVERTISER, impression_date: "2025-12-31", spend: 999 },
      ],
    })
  const fetchImpl = ((input: RequestInfo | URL, init?: RequestInit) =>
    runtime.fetch(new Request(input, init))) as typeof fetch
  return { clock, runtime, fetchImpl, consumer: client(fetchImpl, "http://vibe.test") }
}
test("accepted reports progress with clock and expose deterministic local rows", async () => {
  const { clock, consumer } = setup(),
    response = await consumer.create(body)
  expect(response.status).toBe(201)
  const created = await response.json()
  expect(created.id).toMatch(/^[0-9a-f-]{36}$/)
  expect(created.status).toBe("CREATED")
  expect(created.download_url).toBeNull()
  clock.advance(1000)
  expect((await (await consumer.get(created.id)).json()).status).toBe("PROCESSING")
  clock.advance(1000)
  const ready = await (await consumer.get(created.id)).json()
  expect(ready.status).toBe("READY")
  expect(new URL(ready.download_url).origin).toBe("http://vibe.test")
  expect(await (await consumer.download(ready.download_url)).json()).toEqual([
    {
      impression_date: "2026-01-02",
      campaign_id: "synthetic",
      campaign_name: "Synthetic campaign",
      spend: "12.50",
      impressions: 120,
      number_of_purchases: 1,
      number_of_leads: 2,
      amount_of_purchases: "25.00",
    },
  ])
  clock.advance(86400000)
  expect((await consumer.download(ready.download_url)).status).toBe(403)
})
test("scripted report failure preserves structured failure metadata", async () => {
  const { runtime, clock, consumer } = setup()
  runtime.applyPreset("report_failed", "default", { count: 1 })
  const created = await (await consumer.create(body)).json()
  clock.advance(2000)
  expect(await (await consumer.get(created.id)).json()).toMatchObject({
    status: "FAILED",
    download_url: null,
    failure_reason: { code: "mock_report_failed" },
  })
})
test("stuck processing never spontaneously becomes ready after a polling deadline", async () => {
  const { runtime, clock, consumer } = setup()
  runtime.applyPreset("report_stuck", "default", { count: 1 })
  const created = await (await consumer.create(body)).json()
  clock.advance(30 * 60000)
  expect(await (await consumer.get(created.id)).json()).toMatchObject({
    status: "PROCESSING",
    download_url: null,
  })
})
test("invalid credentials, revision, windows and quota never create reports", async () => {
  const { runtime, fetchImpl, consumer } = setup()
  expect((await client(fetchImpl, "http://vibe.test", "invalid").create(body)).status).toBe(401)
  const wrongRevision = await fetchImpl("http://vibe.test/reports", {
    method: "POST",
    headers: {
      authorization: "Bearer mock_vibe_token",
      "x-vibe-revision": "invalid",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  })
  expect(await wrongRevision.json()).toMatchObject({
    error: { type: "unknown_revision", status: 400 },
  })
  expect((await consumer.create({ ...body, end_date: body.start_date })).status).toBe(400)
  runtime.applyPreset("rate_limited", "default", { count: 1 })
  const rate = await consumer.create(body)
  expect(rate.status).toBe(429)
  expect(rate.headers.get("retry-after")).toBe("1")
  expect(runtime.instance().reports.count()).toBe(0)
})
test("OAuth scope and expiry enforce permissions without consuming state", async () => {
  const { runtime, clock, fetchImpl, consumer } = setup()
  const issued = await (await consumer.token()).json()
  expect(issued.expires_in).toBe(3600)
  expect(
    (await client(fetchImpl, "http://vibe.test", issued.access_token).create(body)).status,
  ).toBe(201)
  const readOnly = await (await consumer.token("advertisers:read")).json()
  expect(
    (await client(fetchImpl, "http://vibe.test", readOnly.access_token).create(body)).status,
  ).toBe(403)
  expect((await consumer.token("unknown:scope")).status).toBe(400)
  clock.advance(3600000)
  expect(
    (await client(fetchImpl, "http://vibe.test", issued.access_token).create(body)).status,
  ).toBe(401)
  expect(runtime.instance().reports.count()).toBe(1)
})
test("custom admin prefix, namespace links, resets and journals stay isolated", async () => {
  const { runtime, clock, fetchImpl, consumer } = setup("/_control/mock")
  const other = client(fetchImpl, "http://vibe.test/_control/mock/ns/other")
  const created = await (await other.create(body)).json()
  clock.advance(2000)
  const ready = await (await other.get(created.id)).json()
  expect(new URL(ready.download_url).pathname).toContain(
    "/_control/mock/ns/other/_control/mock/blobs/",
  )
  expect((await other.download(ready.download_url)).status).toBe(200)
  expect((await consumer.get(created.id)).status).toBe(404)
  await runtime.reset("default")
  expect((await other.get(created.id)).status).toBe(200)
  const report = runtime.instance("other").reports.get(created.id)
  if (!report) throw new Error("Missing report")
  runtime.instance("other").reports.insert(report.id, { ...report, missingArtifact: true })
  expect((await other.download(ready.download_url)).status).toBe(404)
  await runtime.reset("other")
  expect(runtime.instance("other").reports.count()).toBe(0)
  const journal = await (await fetchImpl("http://vibe.test/_control/mock/requests")).text()
  expect(journal).not.toContain("mock_vibe_token")
  expect(journal).not.toContain("Synthetic campaign")
})
test("served HTTP exposes every preset and transport failures", async () => {
  const server = await createServer()
  try {
    const consumer = client(fetch, server.url)
    expect((await consumer.create(body)).status).toBe(201)
    server.runtime.applyPreset("server_error", "default", { count: 1 })
    expect((await consumer.create(body)).status).toBe(500)
    server.runtime.applyPreset("connection_drop", "default", { count: 1 })
    await expect(consumer.create(body)).rejects.toBeInstanceOf(TypeError)
    expect(Object.keys(VIBE_PRESETS)).toHaveLength(5)
  } finally {
    await server.close()
  }
})
