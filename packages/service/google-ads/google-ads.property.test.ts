import { expect, test } from "bun:test"
import { type JsonValue, listOperations } from "@emulators/openapi"
import { operationMetadata } from "@emulators/openapi-metadata"
import { ParityError, parity } from "@emulators/parity"
import { fcParameters } from "@emulators/testing"
import { DEFAULT_TOKEN, document, GoogleAdsAPI } from "./src/index.js"

const headers = () => ({ authorization: `Bearer ${DEFAULT_TOKEN}` })
const now = () => 1791072000000
const params = fcParameters(process.env),
  spec = structuredClone(document)
const query =
  "SELECT campaign.id, metrics.cost_micros, metrics.conversions, segments.date FROM campaign"
const report: JsonValue = {
  dimensions: [{ name: "eventName" }],
  metrics: [{ name: "eventCount" }],
  dateRanges: [{ startDate: "2026-10-04", endDate: "2026-10-04" }],
}
const event: JsonValue = {
  client_id: "fixture-parity-client",
  events: [{ name: "renewal", params: { value: 1.25, currency: "USD" } }],
}
const bodies: Record<string, JsonValue[]> = {
  SearchGoogleAds: [
    { query },
    {
      query: "SELECT campaign_budget.id, campaign_budget.amount_micros FROM campaign_budget",
      validateOnly: true,
    },
  ],
  SearchStreamGoogleAds: [{ query }],
  MutateCampaignBudgets: [
    { operations: [{ create: { name: "Fixture parity budget", amountMicros: "10000000" } }] },
    {
      operations: [
        {
          update: {
            resourceName: "customers/1000000001/campaignBudgets/2000000001",
            amountMicros: "12000000",
          },
          updateMask: "amount_micros",
        },
      ],
      validateOnly: true,
    },
  ],
  UploadClickConversions: [
    {
      partialFailure: true,
      conversions: [
        {
          gclid: "fixture-parity-click",
          conversionAction: "customers/1000000001/conversionActions/4000000001",
          conversionDateTime: "2026-10-03 12:00:00+00:00",
          orderId: "fixture-parity-order",
        },
      ],
    },
  ],
  CollectAnalyticsEvents: [event],
  ValidateAnalyticsEvents: [event],
  RunAnalyticsReport: [report],
  BatchRunAnalyticsReports: [{ requests: [report] }],
}
for (const operation of listOperations(spec)) {
  const values = bodies[operation.operationId ?? ""]
  if (values)
    operation.operation.requestBody = {
      required: true,
      content: { "application/json": { schema: { enum: values } } },
    }
  for (const p of operation.operation.parameters ?? []) {
    if (!("schema" in p)) continue
    const v: Record<string, string> = {
      customerId: "1000000001",
      propertyId: "1000000001",
      measurement_id: "G-FIXTURE",
      api_secret: "fixture-ga4-secret",
    }
    const value = v[p.name]
    if (value) p.schema = { type: "string", enum: [value] }
  }
}
const enabled = listOperations(document)
  .filter((o) => operationMetadata(o.operation).parity.enabled)
  .map((o) => o.operationId)
  .filter((id): id is string => !!id)
const create = () => new GoogleAdsAPI({ now })
test(
  "self-parity exercises all eight operations and validates Google protobuf/analytics schemas",
  async () => {
    const reference = create()
    const report = await parity({
      provider: "google-ads",
      spec,
      includeUnsafe: true,
      real: {
        baseUrl: "http://mock.local",
        allowedHosts: ["mock.local"],
        headers,
        fetch: (r) => reference.fetch(r),
      },
      mock: { baseUrl: "http://mock.local", headers, create },
      cleanup: () => reference.reset(),
      numRuns: params.numRuns ?? 40,
      maxCommands: 30,
      seed: params.seed ?? 0,
      sleep: async () => {},
      log: () => {},
      latencyToleranceMs: 1000,
      env: process.env,
    })
    expect(report.walks).toBeGreaterThan(0)
    expect(Object.keys(report.exercised).sort()).toEqual(enabled.sort())
  },
  { timeout: 60000 },
)
test("a divergent transport fails deterministically for any randomly selected operation", async () => {
  const reference = create()
  const failure = await parity({
    provider: "google-ads",
    spec,
    includeUnsafe: true,
    real: {
      baseUrl: "http://mock.local",
      allowedHosts: ["mock.local"],
      headers,
      fetch: (r) => reference.fetch(r),
    },
    mock: {
      baseUrl: "http://mock.local",
      headers,
      create: () => ({
        fetch: async () =>
          Response.json(
            { error: { code: 503, status: "UNAVAILABLE", message: "Deliberately divergent" } },
            { status: 503 },
          ),
      }),
    },
    numRuns: 10,
    maxCommands: 3,
    seed: 0,
    invalidProbability: 0,
    sleep: async () => {},
    log: () => {},
  }).then(
    () => undefined,
    (e: unknown) => e,
  )
  expect(failure).toBeInstanceOf(ParityError)
})
