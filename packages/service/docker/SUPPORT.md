# Docker Engine (Mockingbird scaffold) — operation support

Generated from `openapi.yaml`; do not edit by hand.

- operations in spec: **13**
- supported by the mock: **2**
- parity enabled: **2**

| operationId | route | mock | parity | notes |
| --- | --- | --- | --- | --- |
| `ContainerList` | `GET /containers/json` | ❌ unsupported | — | Deferred to its implementation story; not available in the scaffold. |
| `ContainerCreate` | `POST /containers/create` | ❌ unsupported | — | Deferred to its implementation story; not available in the scaffold. |
| `ContainerInspect` | `GET /containers/{id}/json` | ❌ unsupported | — | Deferred to its implementation story; not available in the scaffold. |
| `ContainerStart` | `POST /containers/{id}/start` | ❌ unsupported | — | Deferred to its implementation story; not available in the scaffold. |
| `ContainerStop` | `POST /containers/{id}/stop` | ❌ unsupported | — | Deferred to its implementation story; not available in the scaffold. |
| `ContainerKill` | `POST /containers/{id}/kill` | ❌ unsupported | — | Deferred to its implementation story; not available in the scaffold. |
| `ContainerAttach` | `POST /containers/{id}/attach` | ❌ unsupported | — | Node HTTP upgrade requires protocol-specific verification in US-010/US-011; unavailable in Fetch and scaffold. |
| `ContainerWait` | `POST /containers/{id}/wait` | ❌ unsupported | — | Deferred to its implementation story; not available in the scaffold. |
| `ContainerDelete` | `DELETE /containers/{id}` | ❌ unsupported | — | Deferred to its implementation story; not available in the scaffold. |
| `SystemInfo` | `GET /info` | ❌ unsupported | — | Deferred to its implementation story; not available in the scaffold. |
| `SystemVersion` | `GET /version` | ❌ unsupported | — | Deferred to its implementation story; not available in the scaffold. |
| `SystemPing` | `GET /_ping` | ✅ supported | ✅ |  |
| `SystemPingHead` | `HEAD /_ping` | ✅ supported | ✅ |  |
