# Kill Bill Billing API (Mockingbird subset) — operation support

Generated from `openapi.yaml`; do not edit by hand.

- operations in spec: **10**
- supported by the mock: **10**
- parity enabled: **10**

| operationId | route | mock | parity | notes |
| --- | --- | --- | --- | --- |
| `GetTenantByApiKey` | `GET /1.0/kb/tenants` | ✅ supported | ✅ |  |
| `CreateTenant` | `POST /1.0/kb/tenants` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `GetNotificationCallbacks` | `GET /1.0/kb/tenants/registerNotificationCallback` | ✅ supported | ✅ |  |
| `RegisterNotificationCallback` | `POST /1.0/kb/tenants/registerNotificationCallback` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `DeleteNotificationCallbacks` | `DELETE /1.0/kb/tenants/registerNotificationCallback` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `ReadResource` | `GET /1.0/kb/{resource}` | ✅ supported | ✅ |  |
| `CreateResource` | `POST /1.0/kb/{resource}` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `GetResource` | `GET /1.0/kb/{resource}/{id}` | ✅ supported | ✅ |  |
| `UpdateResource` | `PUT /1.0/kb/{resource}/{id}` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `DeleteResource` | `DELETE /1.0/kb/{resource}/{id}` | ✅ supported | ⚠️ unsafe (opt-in) |  |
