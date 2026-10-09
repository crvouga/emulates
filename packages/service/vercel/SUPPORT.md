# Vercel API API — operation support

Generated from `openapi.yaml`; do not edit by hand.

- operations in spec: **52**
- supported by the emulator: **52**
- parity enabled: **0**

| operationId | route | emulator | parity | notes |
| --- | --- | --- | --- | --- |
| `DELETE /v1/api-keys/:keyId` | `DELETE /v1/api-keys/{keyId}` | ✅ supported | ❌ disabled | Verified against a pinned package oracle; independent live vendor evidence is not available. |
| `DELETE /v13/deployments/:id` | `DELETE /v13/deployments/{id}` | ✅ supported | ❌ disabled | Verified against a pinned package oracle; independent live vendor evidence is not available. |
| `GET /v9/projects/:idOrName` | `GET /v9/projects/{idOrName}` | ✅ supported | ❌ disabled | Verified against a pinned package oracle; independent live vendor evidence is not available. |
| `DELETE /v9/projects/:idOrName` | `DELETE /v9/projects/{idOrName}` | ✅ supported | ❌ disabled | Verified against a pinned package oracle; independent live vendor evidence is not available. |
| `PATCH /v9/projects/:idOrName` | `PATCH /v9/projects/{idOrName}` | ✅ supported | ❌ disabled | Verified against a pinned package oracle; independent live vendor evidence is not available. |
| `GET /v9/projects/:idOrName/domains/:domain` | `GET /v9/projects/{idOrName}/domains/{domain}` | ✅ supported | ❌ disabled | Verified against a pinned package oracle; independent live vendor evidence is not available. |
| `DELETE /v9/projects/:idOrName/domains/:domain` | `DELETE /v9/projects/{idOrName}/domains/{domain}` | ✅ supported | ❌ disabled | Verified against a pinned package oracle; independent live vendor evidence is not available. |
| `PATCH /v9/projects/:idOrName/domains/:domain` | `PATCH /v9/projects/{idOrName}/domains/{domain}` | ✅ supported | ❌ disabled | Verified against a pinned package oracle; independent live vendor evidence is not available. |
| `DELETE /v9/projects/:idOrName/env/:id` | `DELETE /v9/projects/{idOrName}/env/{id}` | ✅ supported | ❌ disabled | Verified against a pinned package oracle; independent live vendor evidence is not available. |
| `PATCH /v9/projects/:idOrName/env/:id` | `PATCH /v9/projects/{idOrName}/env/{id}` | ✅ supported | ❌ disabled | Verified against a pinned package oracle; independent live vendor evidence is not available. |
| `GET /api/blob` | `GET /api/blob` | ✅ supported | ❌ disabled | Verified against a pinned package oracle; independent live vendor evidence is not available. |
| `PUT /api/blob` | `PUT /api/blob` | ✅ supported | ❌ disabled | Verified against a pinned package oracle; independent live vendor evidence is not available. |
| `GET /api/blob/` | `GET /api/blob/` | ✅ supported | ❌ disabled | Verified against a pinned package oracle; independent live vendor evidence is not available. |
| `PUT /api/blob/` | `PUT /api/blob/` | ✅ supported | ❌ disabled | Verified against a pinned package oracle; independent live vendor evidence is not available. |
| `GET /blob/:storeId/:pathname{.+}` | `GET /blob/{storeId}/{pathname}` | ✅ supported | ❌ disabled | Verified against a pinned package oracle; independent live vendor evidence is not available. |
| `GET /login/oauth/userinfo` | `GET /login/oauth/userinfo` | ✅ supported | ❌ disabled | Verified against a pinned package oracle; independent live vendor evidence is not available. |
| `GET /oauth/authorize` | `GET /oauth/authorize` | ✅ supported | ❌ disabled | Verified against a pinned package oracle; independent live vendor evidence is not available. |
| `GET /registration` | `GET /registration` | ✅ supported | ❌ disabled | Verified against a pinned package oracle; independent live vendor evidence is not available. |
| `GET /v1/api-keys` | `GET /v1/api-keys` | ✅ supported | ❌ disabled | Verified against a pinned package oracle; independent live vendor evidence is not available. |
| `POST /v1/api-keys` | `POST /v1/api-keys` | ✅ supported | ❌ disabled | Verified against a pinned package oracle; independent live vendor evidence is not available. |
| `GET /v1/projects/:projectId/promote/aliases` | `GET /v1/projects/{projectId}/promote/aliases` | ✅ supported | ❌ disabled | Verified against a pinned package oracle; independent live vendor evidence is not available. |
| `GET /v10/projects` | `GET /v10/projects` | ✅ supported | ❌ disabled | Verified against a pinned package oracle; independent live vendor evidence is not available. |
| `GET /v10/projects/:idOrName/env` | `GET /v10/projects/{idOrName}/env` | ✅ supported | ❌ disabled | Verified against a pinned package oracle; independent live vendor evidence is not available. |
| `POST /v10/projects/:idOrName/env` | `POST /v10/projects/{idOrName}/env` | ✅ supported | ❌ disabled | Verified against a pinned package oracle; independent live vendor evidence is not available. |
| `GET /v10/projects/:idOrName/env/:id` | `GET /v10/projects/{idOrName}/env/{id}` | ✅ supported | ❌ disabled | Verified against a pinned package oracle; independent live vendor evidence is not available. |
| `GET /v13/deployments/:idOrUrl` | `GET /v13/deployments/{idOrUrl}` | ✅ supported | ❌ disabled | Verified against a pinned package oracle; independent live vendor evidence is not available. |
| `GET /v2/deployments/:id/aliases` | `GET /v2/deployments/{id}/aliases` | ✅ supported | ❌ disabled | Verified against a pinned package oracle; independent live vendor evidence is not available. |
| `GET /v2/teams` | `GET /v2/teams` | ✅ supported | ❌ disabled | Verified against a pinned package oracle; independent live vendor evidence is not available. |
| `POST /v2/teams` | `POST /v2/teams` | ✅ supported | ❌ disabled | Verified against a pinned package oracle; independent live vendor evidence is not available. |
| `GET /v2/teams/:teamId` | `GET /v2/teams/{teamId}` | ✅ supported | ❌ disabled | Verified against a pinned package oracle; independent live vendor evidence is not available. |
| `PATCH /v2/teams/:teamId` | `PATCH /v2/teams/{teamId}` | ✅ supported | ❌ disabled | Verified against a pinned package oracle; independent live vendor evidence is not available. |
| `GET /v2/teams/:teamId/members` | `GET /v2/teams/{teamId}/members` | ✅ supported | ❌ disabled | Verified against a pinned package oracle; independent live vendor evidence is not available. |
| `POST /v2/teams/:teamId/members` | `POST /v2/teams/{teamId}/members` | ✅ supported | ❌ disabled | Verified against a pinned package oracle; independent live vendor evidence is not available. |
| `GET /v2/user` | `GET /v2/user` | ✅ supported | ❌ disabled | Verified against a pinned package oracle; independent live vendor evidence is not available. |
| `PATCH /v2/user` | `PATCH /v2/user` | ✅ supported | ❌ disabled | Verified against a pinned package oracle; independent live vendor evidence is not available. |
| `GET /v3/deployments/:idOrUrl/events` | `GET /v3/deployments/{idOrUrl}/events` | ✅ supported | ❌ disabled | Verified against a pinned package oracle; independent live vendor evidence is not available. |
| `GET /v6/deployments` | `GET /v6/deployments` | ✅ supported | ❌ disabled | Verified against a pinned package oracle; independent live vendor evidence is not available. |
| `GET /v6/deployments/:id/files` | `GET /v6/deployments/{id}/files` | ✅ supported | ❌ disabled | Verified against a pinned package oracle; independent live vendor evidence is not available. |
| `GET /v7/deployments` | `GET /v7/deployments` | ✅ supported | ❌ disabled | Verified against a pinned package oracle; independent live vendor evidence is not available. |
| `GET /v9/projects/:idOrName/domains` | `GET /v9/projects/{idOrName}/domains` | ✅ supported | ❌ disabled | Verified against a pinned package oracle; independent live vendor evidence is not available. |
| `PATCH /v1/projects/:idOrName/protection-bypass` | `PATCH /v1/projects/{idOrName}/protection-bypass` | ✅ supported | ❌ disabled | Verified against a pinned package oracle; independent live vendor evidence is not available. |
| `PATCH /v12/deployments/:id/cancel` | `PATCH /v12/deployments/{id}/cancel` | ✅ supported | ❌ disabled | Verified against a pinned package oracle; independent live vendor evidence is not available. |
| `POST /api/blob/delete` | `POST /api/blob/delete` | ✅ supported | ❌ disabled | Verified against a pinned package oracle; independent live vendor evidence is not available. |
| `PUT /api/blob/mpu` | `PUT /api/blob/mpu` | ✅ supported | ❌ disabled | Verified against a pinned package oracle; independent live vendor evidence is not available. |
| `POST /api/blob/mpu` | `POST /api/blob/mpu` | ✅ supported | ❌ disabled | Verified against a pinned package oracle; independent live vendor evidence is not available. |
| `POST /login/oauth/token` | `POST /login/oauth/token` | ✅ supported | ❌ disabled | Verified against a pinned package oracle; independent live vendor evidence is not available. |
| `POST /oauth/authorize/callback` | `POST /oauth/authorize/callback` | ✅ supported | ❌ disabled | Verified against a pinned package oracle; independent live vendor evidence is not available. |
| `POST /v10/projects/:idOrName/domains` | `POST /v10/projects/{idOrName}/domains` | ✅ supported | ❌ disabled | Verified against a pinned package oracle; independent live vendor evidence is not available. |
| `POST /v11/projects` | `POST /v11/projects` | ✅ supported | ❌ disabled | Verified against a pinned package oracle; independent live vendor evidence is not available. |
| `POST /v13/deployments` | `POST /v13/deployments` | ✅ supported | ❌ disabled | Verified against a pinned package oracle; independent live vendor evidence is not available. |
| `POST /v2/files` | `POST /v2/files` | ✅ supported | ❌ disabled | Verified against a pinned package oracle; independent live vendor evidence is not available. |
| `POST /v9/projects/:idOrName/domains/:domain/verify` | `POST /v9/projects/{idOrName}/domains/{domain}/verify` | ✅ supported | ❌ disabled | Verified against a pinned package oracle; independent live vendor evidence is not available. |
