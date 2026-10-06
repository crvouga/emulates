# Daily.co REST API (Emulators subset) — operation support

Generated from `openapi.yaml`; do not edit by hand.

- operations in spec: **9**
- supported by the emulator: **9**
- parity enabled: **9**

| operationId | route | emulator | parity | notes |
| --- | --- | --- | --- | --- |
| `ListRooms` | `GET /v1/rooms` | ✅ supported | ✅ |  |
| `CreateRoom` | `POST /v1/rooms` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `GetRoom` | `GET /v1/rooms/{name}` | ✅ supported | ✅ |  |
| `UpdateRoom` | `POST /v1/rooms/{name}` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `DeleteRoom` | `DELETE /v1/rooms/{name}` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `GetRoomPresence` | `GET /v1/rooms/{name}/presence` | ✅ supported | ✅ |  |
| `EjectParticipants` | `POST /v1/rooms/{name}/eject` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `CreateMeetingToken` | `POST /v1/meeting-tokens` | ✅ supported | ✅ |  |
| `ValidateMeetingToken` | `GET /v1/meeting-tokens/{token}` | ✅ supported | ✅ |  |
