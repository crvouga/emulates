# Infisical Universal Auth and v3 raw secrets — operation support

Generated from `openapi.yaml`; do not edit by hand.

- operations in spec: **6**
- supported by the emulator: **6**
- parity enabled: **6**

| operationId | route | emulator | parity | notes |
| --- | --- | --- | --- | --- |
| `UniversalAuthLogin` | `POST /api/v1/auth/universal-auth/login` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `RenewAccessToken` | `POST /api/v1/auth/token/renew` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `ListSecrets` | `GET /api/v3/secrets/raw` | ✅ supported | ✅ |  |
| `GetSecret` | `GET /api/v3/secrets/raw/{secretName}` | ✅ supported | ✅ |  |
| `CreateSecret` | `POST /api/v3/secrets/raw/{secretName}` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `UpdateSecret` | `PATCH /api/v3/secrets/raw/{secretName}` | ✅ supported | ⚠️ unsafe (opt-in) |  |
