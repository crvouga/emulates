# Docker Engine (Mockingbird) — operation support

Generated from `openapi.yaml`; do not edit by hand.

- operations in spec: **13**
- supported by the mock: **9**
- parity enabled: **8**

| operationId | route | mock | parity | notes |
| --- | --- | --- | --- | --- |
| `ContainerList` | `GET /containers/json` | ✅ supported | ✅ |  |
| `ContainerCreate` | `POST /containers/create` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `ContainerInspect` | `GET /containers/{id}/json` | ✅ supported | ✅ |  |
| `ContainerStart` | `POST /containers/{id}/start` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `ContainerStop` | `POST /containers/{id}/stop` | ❌ unsupported | — | Deferred to its implementation story; not available in the scaffold. |
| `ContainerKill` | `POST /containers/{id}/kill` | ❌ unsupported | — | Deferred to its implementation story; not available in the scaffold. |
| `ContainerAttach` | `POST /containers/{id}/attach` | ❌ unsupported | — | Node HTTP upgrade requires protocol-specific verification in US-010/US-011; unavailable in Fetch and scaffold. |
| `ContainerWait` | `POST /containers/{id}/wait` | ✅ supported | ❌ disabled | Requires deterministic completion and cancellation; verified by lifecycle tests instead of unbounded generated waits. |
| `ContainerDelete` | `DELETE /containers/{id}` | ❌ unsupported | — | Deferred to its implementation story; not available in the scaffold. |
| `SystemInfo` | `GET /info` | ✅ supported | ✅ |  |
| `SystemVersion` | `GET /version` | ✅ supported | ✅ |  |
| `SystemPing` | `GET /_ping` | ✅ supported | ✅ |  |
| `SystemPingHead` | `HEAD /_ping` | ✅ supported | ✅ |  |
