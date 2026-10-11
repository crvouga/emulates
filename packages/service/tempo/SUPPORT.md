# Grafana Tempo (Mockingbird subset) — operation support

Generated from `openapi.yaml`; do not edit by hand.

- operations in spec: **4**
- supported by the emulator: **4**
- parity enabled: **4**

| operationId | route | emulator | parity | notes |
| --- | --- | --- | --- | --- |
| `ExportTraces` | `POST /v1/traces` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `Search` | `GET /api/search` | ✅ supported | ✅ |  |
| `GetTrace` | `GET /api/traces/{traceId}` | ✅ supported | ✅ |  |
| `SearchTagsV2` | `GET /api/v2/search/tags` | ✅ supported | ✅ |  |
