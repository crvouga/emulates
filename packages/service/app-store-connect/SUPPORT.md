# App Store Connect scoped mock — operation support

Generated from `openapi.yaml`; do not edit by hand.

- operations in spec: **14**
- supported by the emulator: **14**
- parity enabled: **14**

| operationId | route | emulator | parity | notes |
| --- | --- | --- | --- | --- |
| `ListApps` | `GET /v1/apps` | ✅ supported | ✅ |  |
| `ListUsers` | `GET /v1/users` | ✅ supported | ✅ |  |
| `ListInvitations` | `GET /v1/userInvitations` | ✅ supported | ✅ |  |
| `CreateInvitation` | `POST /v1/userInvitations` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `ListGroups` | `GET /v1/betaGroups` | ✅ supported | ✅ |  |
| `CreateGroup` | `POST /v1/betaGroups` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `ListTesters` | `GET /v1/betaTesters` | ✅ supported | ✅ |  |
| `CreateTester` | `POST /v1/betaTesters` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `ListGroupTesters` | `GET /v1/betaGroups/{id}/betaTesters` | ✅ supported | ✅ |  |
| `AddGroupTesters` | `POST /v1/betaGroups/{id}/relationships/betaTesters` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `RemoveGroupTesters` | `DELETE /v1/betaGroups/{id}/relationships/betaTesters` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `AddVisibleApps` | `POST /v1/users/{id}/relationships/visibleApps` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `DeleteUser` | `DELETE /v1/users/{id}` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `DeleteInvitation` | `DELETE /v1/userInvitations/{id}` | ✅ supported | ⚠️ unsafe (opt-in) |  |
