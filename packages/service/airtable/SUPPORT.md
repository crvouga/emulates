# Airtable mock — operation support

Generated from `openapi.yaml`; do not edit by hand.

- operations in spec: **6**
- supported by the emulator: **6**
- parity enabled: **6**

| operationId | route | emulator | parity | notes |
| --- | --- | --- | --- | --- |
| `Whoami` | `GET /v0/meta/whoami` | ✅ supported | ✅ |  |
| `ListBases` | `GET /v0/meta/bases` | ✅ supported | ✅ |  |
| `ListTables` | `GET /v0/meta/bases/{baseId}/tables` | ✅ supported | ✅ |  |
| `CreateField` | `POST /v0/meta/bases/{baseId}/tables/{tableId}/fields` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `CreateRecords` | `POST /v0/{baseId}/{tableId}` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `OAuthToken` | `POST /oauth2/v1/token` | ✅ supported | ⚠️ unsafe (opt-in) |  |
