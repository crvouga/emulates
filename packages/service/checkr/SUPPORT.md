# Checkr scoped emulator — operation support

Generated from `openapi.yaml`; do not edit by hand.

- operations in spec: **10**
- supported by the emulator: **10**
- parity enabled: **10**

| operationId | route | emulator | parity | notes |
| --- | --- | --- | --- | --- |
| `ListPackages` | `GET /v1/packages` | ✅ supported | ✅ |  |
| `ListNodes` | `GET /v1/nodes` | ✅ supported | ✅ |  |
| `ListCandidates` | `GET /v1/candidates` | ✅ supported | ✅ |  |
| `CreateCandidate` | `POST /v1/candidates` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `ListInvitations` | `GET /v1/invitations` | ✅ supported | ✅ |  |
| `CreateInvitation` | `POST /v1/invitations` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `GetInvitation` | `GET /v1/invitations/{id}` | ✅ supported | ✅ |  |
| `CancelInvitation` | `DELETE /v1/invitations/{id}` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `GetReport` | `GET /v1/reports/{id}` | ✅ supported | ✅ |  |
| `GetReportEta` | `GET /v1/reports/{id}/eta` | ✅ supported | ✅ |  |
