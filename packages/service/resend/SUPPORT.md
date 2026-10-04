# Resend API (Mockingbird subset) — operation support

Generated from `openapi.yaml`; do not edit by hand.

- operations in spec: **7**
- supported by the mock: **7**
- parity enabled: **7**

| operationId | route | mock | parity | notes |
| --- | --- | --- | --- | --- |
| `ListEmails` | `GET /emails` | ✅ supported | ✅ |  |
| `SendEmail` | `POST /emails` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `GetEmail` | `GET /emails/{email_id}` | ✅ supported | ✅ |  |
| `ListReceivedEmails` | `GET /emails/receiving` | ✅ supported | ✅ |  |
| `GetReceivedEmail` | `GET /emails/receiving/{email_id}` | ✅ supported | ✅ |  |
| `ListReceivedEmailAttachments` | `GET /emails/receiving/{email_id}/attachments` | ✅ supported | ✅ |  |
| `DownloadReceivedAttachment` | `GET /downloads/inbound/{attachment_id}` | ✅ supported | ✅ |  |
