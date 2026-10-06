# WorkOS AuthKit mock — operation support

Generated from `openapi.yaml`; do not edit by hand.

- operations in spec: **4**
- supported by the emulator: **4**
- parity enabled: **3**

| operationId | route | emulator | parity | notes |
| --- | --- | --- | --- | --- |
| `Authorize` | `GET /user_management/authorize` | ✅ supported | ❌ disabled | Browser redirect requires registered client and callback |
| `Authenticate` | `POST /user_management/authenticate` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `ListUsers` | `GET /user_management/users` | ✅ supported | ✅ |  |
| `GetJwks` | `GET /sso/jwks/{clientId}` | ✅ supported | ✅ |  |
