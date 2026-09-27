# Hermes Agent peer runs (Mockingbird) — operation support

Generated from `openapi.yaml`; do not edit by hand.

- operations in spec: **6**
- supported by the mock: **3**
- parity enabled: **0**

| operationId | route | mock | parity | notes |
| --- | --- | --- | --- | --- |
| `RunCreate` | `POST /v1/runs` | ✅ supported | ❌ disabled | Pinned runtime oracle is scheduled for US-022. |
| `RunGet` | `GET /v1/runs/{run_id}` | ✅ supported | ❌ disabled | Pinned runtime oracle is scheduled for US-022. |
| `RunStop` | `POST /v1/runs/{run_id}/stop` | ✅ supported | ❌ disabled | Pinned runtime oracle is scheduled for US-022. |
| `RunEvents` | `GET /v1/runs/{run_id}/events` | ❌ unsupported | — | SSE is outside the public peer-run mock subset. |
| `RunApproval` | `POST /v1/runs/{run_id}/approval` | ❌ unsupported | — | Host tool approval execution is outside this mock. |
| `RunSteer` | `POST /v1/runs/{run_id}/steer` | ❌ unsupported | — | Agent execution and steering are outside this mock. |
