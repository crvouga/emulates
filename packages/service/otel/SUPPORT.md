# OTLP/HTTP collector and OpenObserve search (Mockingbird subset) — operation support

Generated from `openapi.yaml`; do not edit by hand.

- operations in spec: **10**
- supported by the emulator: **10**
- parity enabled: **10**

| operationId | route | emulator | parity | notes |
| --- | --- | --- | --- | --- |
| `ExportTraces` | `POST /v1/traces` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `PreflightTraces` | `OPTIONS /v1/traces` | ✅ supported | ✅ |  |
| `ExportLogs` | `POST /v1/logs` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `PreflightLogs` | `OPTIONS /v1/logs` | ✅ supported | ✅ |  |
| `ExportMetrics` | `POST /v1/metrics` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `PreflightMetrics` | `OPTIONS /v1/metrics` | ✅ supported | ✅ |  |
| `ListOrganizations` | `GET /api/organizations` | ✅ supported | ✅ |  |
| `ListStreams` | `GET /api/{org}/streams` | ✅ supported | ✅ |  |
| `GetStreamSchema` | `GET /api/{org}/streams/{stream}/schema` | ✅ supported | ✅ |  |
| `Search` | `POST /api/{org}/_search` | ✅ supported | ✅ |  |
