# @crvouga/mockingbird-service-google-ads

> Local emulators. Real API contracts. Part of [Mockingbird](https://github.com/crvouga/mockingbird).

A **wip** portable emulator for Google Ads API v25 and Google Analytics 4. It provides deterministic
GAQL reporting, campaign-budget mutations, click-conversion uploads, Measurement Protocol event
collection, and Analytics Data reports using namespaced SQLite state and an injected clock.

## Install

```sh
bun add @crvouga/mockingbird-service-google-ads
```

## Usage

```ts
import {
  createRuntime,
  DEFAULT_CUSTOMER,
  DEFAULT_TOKEN,
} from "@crvouga/mockingbird-service-google-ads"

const emulator = createRuntime()
const response = await emulator.fetch(
  new Request(`http://emulator.local/v25/customers/${DEFAULT_CUSTOMER}/googleAds:search`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${DEFAULT_TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      query: "SELECT campaign.id, campaign.name, metrics.clicks FROM campaign",
    }),
  }),
)

console.log(await response.json())
```

The Ads and Analytics Data routes use OAuth Bearer credentials. Measurement Protocol routes use
the `measurement_id` and `api_secret` query parameters. The exported defaults are synthetic and
safe for tests. Configure `tokens`, customers, campaigns, budgets, conversion actions, metrics,
and Analytics properties through `createRuntime` options when a suite needs different fixtures.

For parallel tests, send `x-mockingbird-namespace`, use the shared `/__admin/ns/{namespace}` path,
or register credentials with the shared admin API. State, pagination snapshots, IDs, clocks,
faults, and resets are isolated by namespace.

## Supported operations

| Operation | Route | Behavior |
| --- | --- | --- |
| SearchGoogleAds | `POST /v25/customers/{customerId}/googleAds:search` | GAQL selection, filtering, ordering, aggregation, summary rows, stable 10,000-row pages and validate-only requests |
| SearchStreamGoogleAds | `POST /v25/customers/{customerId}/googleAds:searchStream` | Deterministic JSON batches and optional summary rows |
| MutateCampaignBudgets | `POST /v25/customers/{customerId}/campaignBudgets:mutate` | Create, update, remove, update masks, validate-only and atomic or partial failure |
| UploadClickConversions | `POST /v25/customers/{customerId}:uploadClickConversions` | Click identifiers, conversion actions, duplicate detection, job IDs and partial failure |
| CollectAnalyticsEvents | `POST /mp/collect` | Production-style empty 204 response with accepted events stored for reporting |
| ValidateAnalyticsEvents | `POST /debug/mp/collect` | Validation messages without ingestion |
| RunAnalyticsReport | `POST /v1beta/properties/{propertyId}:runReport` | Dimensions, metrics, filters, ordering, pagination and reporting lag |
| BatchRunAnalyticsReports | `POST /v1beta/properties/{propertyId}:batchRunReports` | Up to five report requests |

The exact request and response schemas are in [`openapi.yaml`](openapi.yaml), and the generated
support matrix is in [`SUPPORT.md`](SUPPORT.md).

## Controls and failures

Service-specific controls are protected by the shared `x-mockingbird-admin-key` guard and live
beside the shared health, state, clock, journal, fault, reset, and Timeline endpoints.

| Control | Purpose |
| --- | --- |
| `GET /__admin/events` | Inspect stored Analytics events |
| `GET /__admin/conversions` | Inspect uploaded conversions |
| `GET /__admin/budgets` | Inspect campaign budgets |
| `GET /__admin/budget-mutations` | Inspect the mutation audit trail |
| `GET /__admin/request-metadata` | Inspect redacted request metadata |
| `POST /__admin/daily-metrics` | Seed synthetic daily Ads metrics |
| `POST /__admin/page-tokens/expire` | Expire all current GAQL page tokens |
| `GET /__admin/settings` | Read reporting lag, page-token TTL and future-timestamp policy |
| `PUT /__admin/settings` | Update those deterministic test settings |

Fault presets include `quota_exhausted`, `server_error`, `network_reset`, `slow_response`,
`ambiguous_budget_write`, `partial_budget_failure`, and `partial_conversion_failure`. The
ambiguous-write preset commits the mutation before returning 503 so retry logic can be tested
against an uncertain outcome. Sensitive event and conversion payloads are sealed in state;
journals and inspection metadata contain only the fields needed for assertions.

## API

The portable root exports `GoogleAdsAPI`, `createRuntime`, `document`, `supportedOperationIds`,
`GOOGLE_ADS_NAMESPACE`, `GOOGLE_ADS_PRESETS`, `DEFAULT_ADMIN_KEY`, `DEFAULT_TOKEN`,
`DEFAULT_CUSTOMER`, `DEFAULT_CUSTOMERS`, `DEFAULT_BUDGETS`, `DEFAULT_CAMPAIGNS`, `DEFAULT_ACTIONS`,
`DEFAULT_PROPERTY`, `DEFAULT_MEASUREMENT`, `DEFAULT_API_SECRET`, `createVaultKey`, `fingerprint`,
and the public fixture/runtime option types. The Node `./server` entry exports `createServer`,
`DEFAULT_PORT`, and server types. `mockingbird-google-ads serve` starts a listener.

## Verification and scope

Acceptance tests cover GAQL precision and paging, budget preflight and partial writes, conversion
deduplication, GA4 event validation and reporting, OAuth scope/expiry behavior, encrypted state,
namespaces, resets, fault recovery, and the unmodified `google-auth-library` 11.1.0 HTTP signing
path. Property tests exercise every parity-enabled operation and prove that a divergent transport
is detected deterministically.

The emulator intentionally implements a bounded subset. It does not model the complete Google Ads
resource graph, every GAQL function, every Analytics dimension or metric, real Google identity,
production quota allocation, billing, dashboards, attribution processing, or undocumented
backend behavior. Normal operation is local and does not contact Google; only the explicit parity
command uses credentials supplied through `.env.local` or GitHub Actions secrets.
