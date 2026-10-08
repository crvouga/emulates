# Resend API (Mockingbird subset) — operation support

Generated from `openapi.yaml`; do not edit by hand.

- operations in spec: **25**
- supported by the emulator: **25**
- parity enabled: **7**

| operationId | route | emulator | parity | notes |
| --- | --- | --- | --- | --- |
| `ListEmails` | `GET /emails` | ✅ supported | ✅ |  |
| `SendEmail` | `POST /emails` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `GetEmail` | `GET /emails/{email_id}` | ✅ supported | ✅ |  |
| `ListReceivedEmails` | `GET /emails/receiving` | ✅ supported | ✅ |  |
| `GetReceivedEmail` | `GET /emails/receiving/{email_id}` | ✅ supported | ✅ |  |
| `ListReceivedEmailAttachments` | `GET /emails/receiving/{email_id}/attachments` | ✅ supported | ✅ |  |
| `DownloadReceivedAttachment` | `GET /downloads/inbound/{attachment_id}` | ✅ supported | ✅ |  |
| `DELETE /api-keys/:id` | `DELETE /api-keys/{id}` | ✅ supported | ❌ disabled | Verified against a pinned package oracle; independent live vendor evidence is not available. |
| `DELETE /audiences/:audience_id/contacts/:id` | `DELETE /audiences/{audience_id}/contacts/{id}` | ✅ supported | ❌ disabled | Verified against a pinned package oracle; independent live vendor evidence is not available. |
| `DELETE /audiences/:id` | `DELETE /audiences/{id}` | ✅ supported | ❌ disabled | Verified against a pinned package oracle; independent live vendor evidence is not available. |
| `GET /domains/:id` | `GET /domains/{id}` | ✅ supported | ❌ disabled | Verified against a pinned package oracle; independent live vendor evidence is not available. |
| `DELETE /domains/:id` | `DELETE /domains/{id}` | ✅ supported | ❌ disabled | Verified against a pinned package oracle; independent live vendor evidence is not available. |
| `GET /api-keys` | `GET /api-keys` | ✅ supported | ❌ disabled | Verified against a pinned package oracle; independent live vendor evidence is not available. |
| `POST /api-keys` | `POST /api-keys` | ✅ supported | ❌ disabled | Verified against a pinned package oracle; independent live vendor evidence is not available. |
| `GET /audiences` | `GET /audiences` | ✅ supported | ❌ disabled | Verified against a pinned package oracle; independent live vendor evidence is not available. |
| `POST /audiences` | `POST /audiences` | ✅ supported | ❌ disabled | Verified against a pinned package oracle; independent live vendor evidence is not available. |
| `GET /audiences/:audience_id/contacts` | `GET /audiences/{audience_id}/contacts` | ✅ supported | ❌ disabled | Verified against a pinned package oracle; independent live vendor evidence is not available. |
| `POST /audiences/:audience_id/contacts` | `POST /audiences/{audience_id}/contacts` | ✅ supported | ❌ disabled | Verified against a pinned package oracle; independent live vendor evidence is not available. |
| `GET /domains` | `GET /domains` | ✅ supported | ❌ disabled | Verified against a pinned package oracle; independent live vendor evidence is not available. |
| `POST /domains` | `POST /domains` | ✅ supported | ❌ disabled | Verified against a pinned package oracle; independent live vendor evidence is not available. |
| `GET /inbox` | `GET /inbox` | ✅ supported | ❌ disabled | Verified against a pinned package oracle; independent live vendor evidence is not available. |
| `GET /inbox/:id` | `GET /inbox/{id}` | ✅ supported | ❌ disabled | Verified against a pinned package oracle; independent live vendor evidence is not available. |
| `POST /domains/:id/verify` | `POST /domains/{id}/verify` | ✅ supported | ❌ disabled | Verified against a pinned package oracle; independent live vendor evidence is not available. |
| `POST /emails/:id/cancel` | `POST /emails/{id}/cancel` | ✅ supported | ❌ disabled | Verified against a pinned package oracle; independent live vendor evidence is not available. |
| `POST /emails/batch` | `POST /emails/batch` | ✅ supported | ❌ disabled | Verified against a pinned package oracle; independent live vendor evidence is not available. |
