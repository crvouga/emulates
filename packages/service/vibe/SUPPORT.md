# Vibe Public API — operation support

Generated from `openapi.yaml`; do not edit by hand.

- operations in spec: **4**
- supported by the emulator: **4**
- parity enabled: **3**

| operationId | route | emulator | parity | notes |
| --- | --- | --- | --- | --- |
| `CreateReport` | `POST /reports` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `GetReport` | `GET /reports/{report_id}` | ✅ supported | ✅ |  |
| `OAuthToken` | `POST /oauth2/token` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `DownloadReport` | `GET /__admin/blobs/{id}` | ✅ supported | ❌ disabled | Emulator-only capability URL; exercised by acceptance tests. |
