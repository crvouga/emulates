# Sentry transport and event API — operation support

Generated from `openapi.yaml`; do not edit by hand.

- operations in spec: **12**
- supported by the emulator: **12**
- parity enabled: **10**

| operationId | route | emulator | parity | notes |
| --- | --- | --- | --- | --- |
| `IngestEnvelope` | `POST /api/{project}/envelope/` | ✅ supported | ❌ disabled | Envelope byte lengths and mixed binary items require the dedicated official SDK and codec acceptance tests. |
| `StoreEvent` | `POST /api/{project}/store/` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `IngestMinidump` | `POST /api/{project}/minidump/` | ✅ supported | ❌ disabled | Native minidump and multipart bodies require the dedicated served binary tests. |
| `ListProjectEvents` | `GET /api/0/projects/{organization}/{project}/events/` | ✅ supported | ✅ |  |
| `GetProjectEvent` | `GET /api/0/projects/{organization}/{project}/events/{event}/` | ✅ supported | ✅ |  |
| `ListProjectIssues` | `GET /api/0/projects/{organization}/{project}/issues/` | ✅ supported | ✅ |  |
| `GetIssue` | `GET /api/0/issues/{issue}/` | ✅ supported | ✅ |  |
| `UpdateIssue` | `PUT /api/0/issues/{issue}/` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `GetOrganizationIssue` | `GET /api/0/organizations/{organization}/issues/{issue}/` | ✅ supported | ✅ |  |
| `UpdateOrganizationIssue` | `PUT /api/0/organizations/{organization}/issues/{issue}/` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `ListEventAttachments` | `GET /api/0/projects/{organization}/{project}/events/{event}/attachments/` | ✅ supported | ✅ |  |
| `GetEventAttachment` | `GET /api/0/projects/{organization}/{project}/events/{event}/attachments/{attachment}/` | ✅ supported | ✅ |  |
