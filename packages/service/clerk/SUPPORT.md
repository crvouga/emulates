# Clerk API API — operation support

Generated from `openapi.yaml`; do not edit by hand.

- operations in spec: **44**
- supported by the emulator: **44**
- parity enabled: **0**

| operationId | route | emulator | parity | notes |
| --- | --- | --- | --- | --- |
| `GET /v1/email_addresses/:emailId` | `GET /v1/email_addresses/{emailId}` | ✅ supported | ❌ disabled | Verified against a pinned package oracle; independent live vendor evidence is not available. |
| `DELETE /v1/email_addresses/:emailId` | `DELETE /v1/email_addresses/{emailId}` | ✅ supported | ❌ disabled | Verified against a pinned package oracle; independent live vendor evidence is not available. |
| `PATCH /v1/email_addresses/:emailId` | `PATCH /v1/email_addresses/{emailId}` | ✅ supported | ❌ disabled | Verified against a pinned package oracle; independent live vendor evidence is not available. |
| `GET /v1/organizations/:orgId` | `GET /v1/organizations/{orgId}` | ✅ supported | ❌ disabled | Verified against a pinned package oracle; independent live vendor evidence is not available. |
| `DELETE /v1/organizations/:orgId` | `DELETE /v1/organizations/{orgId}` | ✅ supported | ❌ disabled | Verified against a pinned package oracle; independent live vendor evidence is not available. |
| `PATCH /v1/organizations/:orgId` | `PATCH /v1/organizations/{orgId}` | ✅ supported | ❌ disabled | Verified against a pinned package oracle; independent live vendor evidence is not available. |
| `DELETE /v1/organizations/:orgId/memberships/:userId` | `DELETE /v1/organizations/{orgId}/memberships/{userId}` | ✅ supported | ❌ disabled | Verified against a pinned package oracle; independent live vendor evidence is not available. |
| `PATCH /v1/organizations/:orgId/memberships/:userId` | `PATCH /v1/organizations/{orgId}/memberships/{userId}` | ✅ supported | ❌ disabled | Verified against a pinned package oracle; independent live vendor evidence is not available. |
| `GET /v1/users/:userId` | `GET /v1/users/{userId}` | ✅ supported | ❌ disabled | Verified against a pinned package oracle; independent live vendor evidence is not available. |
| `DELETE /v1/users/:userId` | `DELETE /v1/users/{userId}` | ✅ supported | ❌ disabled | Verified against a pinned package oracle; independent live vendor evidence is not available. |
| `PATCH /v1/users/:userId` | `PATCH /v1/users/{userId}` | ✅ supported | ❌ disabled | Verified against a pinned package oracle; independent live vendor evidence is not available. |
| `GET /.well-known/openid-configuration` | `GET /.well-known/openid-configuration` | ✅ supported | ❌ disabled | Verified against a pinned package oracle; independent live vendor evidence is not available. |
| `GET /oauth/authorize` | `GET /oauth/authorize` | ✅ supported | ❌ disabled | Verified against a pinned package oracle; independent live vendor evidence is not available. |
| `GET /oauth/userinfo` | `GET /oauth/userinfo` | ✅ supported | ❌ disabled | Verified against a pinned package oracle; independent live vendor evidence is not available. |
| `GET /v1/jwks` | `GET /v1/jwks` | ✅ supported | ❌ disabled | Verified against a pinned package oracle; independent live vendor evidence is not available. |
| `GET /v1/organizations` | `GET /v1/organizations` | ✅ supported | ❌ disabled | Verified against a pinned package oracle; independent live vendor evidence is not available. |
| `POST /v1/organizations` | `POST /v1/organizations` | ✅ supported | ❌ disabled | Verified against a pinned package oracle; independent live vendor evidence is not available. |
| `GET /v1/organizations/:orgId/invitations` | `GET /v1/organizations/{orgId}/invitations` | ✅ supported | ❌ disabled | Verified against a pinned package oracle; independent live vendor evidence is not available. |
| `POST /v1/organizations/:orgId/invitations` | `POST /v1/organizations/{orgId}/invitations` | ✅ supported | ❌ disabled | Verified against a pinned package oracle; independent live vendor evidence is not available. |
| `GET /v1/organizations/:orgId/invitations/:invitationId` | `GET /v1/organizations/{orgId}/invitations/{invitationId}` | ✅ supported | ❌ disabled | Verified against a pinned package oracle; independent live vendor evidence is not available. |
| `GET /v1/organizations/:orgId/memberships` | `GET /v1/organizations/{orgId}/memberships` | ✅ supported | ❌ disabled | Verified against a pinned package oracle; independent live vendor evidence is not available. |
| `POST /v1/organizations/:orgId/memberships` | `POST /v1/organizations/{orgId}/memberships` | ✅ supported | ❌ disabled | Verified against a pinned package oracle; independent live vendor evidence is not available. |
| `GET /v1/sessions` | `GET /v1/sessions` | ✅ supported | ❌ disabled | Verified against a pinned package oracle; independent live vendor evidence is not available. |
| `POST /v1/sessions` | `POST /v1/sessions` | ✅ supported | ❌ disabled | Verified against a pinned package oracle; independent live vendor evidence is not available. |
| `GET /v1/sessions/:sessionId` | `GET /v1/sessions/{sessionId}` | ✅ supported | ❌ disabled | Verified against a pinned package oracle; independent live vendor evidence is not available. |
| `GET /v1/users` | `GET /v1/users` | ✅ supported | ❌ disabled | Verified against a pinned package oracle; independent live vendor evidence is not available. |
| `POST /v1/users` | `POST /v1/users` | ✅ supported | ❌ disabled | Verified against a pinned package oracle; independent live vendor evidence is not available. |
| `GET /v1/users/count` | `GET /v1/users/count` | ✅ supported | ❌ disabled | Verified against a pinned package oracle; independent live vendor evidence is not available. |
| `PATCH /v1/organizations/:orgId/memberships/:userId/metadata` | `PATCH /v1/organizations/{orgId}/memberships/{userId}/metadata` | ✅ supported | ❌ disabled | Verified against a pinned package oracle; independent live vendor evidence is not available. |
| `PATCH /v1/organizations/:orgId/metadata` | `PATCH /v1/organizations/{orgId}/metadata` | ✅ supported | ❌ disabled | Verified against a pinned package oracle; independent live vendor evidence is not available. |
| `PATCH /v1/users/:userId/metadata` | `PATCH /v1/users/{userId}/metadata` | ✅ supported | ❌ disabled | Verified against a pinned package oracle; independent live vendor evidence is not available. |
| `POST /oauth/authorize/callback` | `POST /oauth/authorize/callback` | ✅ supported | ❌ disabled | Verified against a pinned package oracle; independent live vendor evidence is not available. |
| `POST /oauth/token` | `POST /oauth/token` | ✅ supported | ❌ disabled | Verified against a pinned package oracle; independent live vendor evidence is not available. |
| `POST /v1/email_addresses` | `POST /v1/email_addresses` | ✅ supported | ❌ disabled | Verified against a pinned package oracle; independent live vendor evidence is not available. |
| `POST /v1/organizations/:orgId/invitations/:invitationId/revoke` | `POST /v1/organizations/{orgId}/invitations/{invitationId}/revoke` | ✅ supported | ❌ disabled | Verified against a pinned package oracle; independent live vendor evidence is not available. |
| `POST /v1/organizations/:orgId/invitations/bulk` | `POST /v1/organizations/{orgId}/invitations/bulk` | ✅ supported | ❌ disabled | Verified against a pinned package oracle; independent live vendor evidence is not available. |
| `POST /v1/sessions/:sessionId/revoke` | `POST /v1/sessions/{sessionId}/revoke` | ✅ supported | ❌ disabled | Verified against a pinned package oracle; independent live vendor evidence is not available. |
| `POST /v1/sessions/:sessionId/tokens` | `POST /v1/sessions/{sessionId}/tokens` | ✅ supported | ❌ disabled | Verified against a pinned package oracle; independent live vendor evidence is not available. |
| `POST /v1/sessions/:sessionId/tokens/:template` | `POST /v1/sessions/{sessionId}/tokens/{template}` | ✅ supported | ❌ disabled | Verified against a pinned package oracle; independent live vendor evidence is not available. |
| `POST /v1/users/:userId/ban` | `POST /v1/users/{userId}/ban` | ✅ supported | ❌ disabled | Verified against a pinned package oracle; independent live vendor evidence is not available. |
| `POST /v1/users/:userId/lock` | `POST /v1/users/{userId}/lock` | ✅ supported | ❌ disabled | Verified against a pinned package oracle; independent live vendor evidence is not available. |
| `POST /v1/users/:userId/unban` | `POST /v1/users/{userId}/unban` | ✅ supported | ❌ disabled | Verified against a pinned package oracle; independent live vendor evidence is not available. |
| `POST /v1/users/:userId/unlock` | `POST /v1/users/{userId}/unlock` | ✅ supported | ❌ disabled | Verified against a pinned package oracle; independent live vendor evidence is not available. |
| `POST /v1/users/:userId/verify_password` | `POST /v1/users/{userId}/verify_password` | ✅ supported | ❌ disabled | Verified against a pinned package oracle; independent live vendor evidence is not available. |
