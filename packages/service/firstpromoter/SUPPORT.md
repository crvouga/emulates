# FirstPromoter API v2 (Mockingbird subset) — operation support

Generated from `openapi.yaml`; do not edit by hand.

- operations in spec: **9**
- supported by the mock: **9**
- parity enabled: **9**

| operationId | route | mock | parity | notes |
| --- | --- | --- | --- | --- |
| `TrackSignup` | `POST /v2/track/signup` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `ListPromoters` | `GET /v2/company/promoters` | ✅ supported | ✅ |  |
| `CreatePromoter` | `POST /v2/company/promoters` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `ArchivePromoters` | `POST /v2/company/promoters/archive` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `GetPromoter` | `GET /v2/company/promoters/{id}` | ✅ supported | ✅ |  |
| `UpdatePromoter` | `PUT /v2/company/promoters/{id}` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `IframeLogin` | `POST /v2/promoters/iframe_login` | ✅ supported | ✅ |  |
| `ListReferrals` | `GET /v2/company/referrals` | ✅ supported | ✅ |  |
| `GetReferral` | `GET /v2/company/referrals/{id}` | ✅ supported | ✅ |  |
