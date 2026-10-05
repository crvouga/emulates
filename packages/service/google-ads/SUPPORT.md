# Google Ads v25 and GA4 local API subset — operation support

Generated from `openapi.yaml`; do not edit by hand.

- operations in spec: **8**
- supported by the mock: **8**
- parity enabled: **8**

| operationId | route | mock | parity | notes |
| --- | --- | --- | --- | --- |
| `SearchGoogleAds` | `POST /v25/customers/{customerId}/googleAds:search` | ✅ supported | ✅ |  |
| `SearchStreamGoogleAds` | `POST /v25/customers/{customerId}/googleAds:searchStream` | ✅ supported | ✅ |  |
| `MutateCampaignBudgets` | `POST /v25/customers/{customerId}/campaignBudgets:mutate` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `UploadClickConversions` | `POST /v25/customers/{customerId}:uploadClickConversions` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `CollectAnalyticsEvents` | `POST /mp/collect` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `ValidateAnalyticsEvents` | `POST /debug/mp/collect` | ✅ supported | ✅ |  |
| `RunAnalyticsReport` | `POST /v1beta/properties/{propertyId}:runReport` | ✅ supported | ✅ |  |
| `BatchRunAnalyticsReports` | `POST /v1beta/properties/{propertyId}:batchRunReports` | ✅ supported | ✅ |  |
