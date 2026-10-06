# LiveKit Server API (Emulates subset) — operation support

Generated from `openapi.yaml`; do not edit by hand.

- operations in spec: **6**
- supported by the emulator: **6**
- parity enabled: **6**

| operationId | route | emulator | parity | notes |
| --- | --- | --- | --- | --- |
| `CreateDispatch` | `POST /twirp/livekit.AgentDispatchService/CreateDispatch` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `ListDispatch` | `POST /twirp/livekit.AgentDispatchService/ListDispatch` | ✅ supported | ✅ |  |
| `DeleteDispatch` | `POST /twirp/livekit.AgentDispatchService/DeleteDispatch` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `RoomService` | `POST /twirp/livekit.RoomService/{method}` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `EgressService` | `POST /twirp/livekit.Egress/{method}` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `SipService` | `POST /twirp/livekit.SIP/{method}` | ✅ supported | ⚠️ unsafe (opt-in) |  |
