# Manage Vanta consumer subset — operation support

Generated from `openapi.yaml`; do not edit by hand.

- operations in spec: **10**
- supported by the emulator: **10**
- parity enabled: **9**

| operationId | route | emulator | parity | notes |
| --- | --- | --- | --- | --- |
| `ListPeople` | `GET /v1/people` | ✅ supported | ✅ |  |
| `ListTests` | `GET /v1/tests` | ✅ supported | ✅ |  |
| `ListControls` | `GET /v1/controls` | ✅ supported | ✅ |  |
| `ListDocuments` | `GET /v1/documents` | ✅ supported | ✅ |  |
| `GetPerson` | `GET /v1/people/{personId}` | ✅ supported | ✅ |  |
| `GetDocument` | `GET /v1/documents/{documentId}` | ✅ supported | ✅ |  |
| `OAuthToken` | `POST /oauth/token` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `UploadFileForDocument` | `POST /v1/documents/{documentId}/uploads` | ✅ supported | ❌ disabled | Multipart file uploads exercised through raw-fetch acceptance tests. |
| `SubmitDocumentCollection` | `POST /v1/documents/{documentId}/submit` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `OffboardPeople` | `POST /v1/people/offboard` | ✅ supported | ⚠️ unsafe (opt-in) |  |
