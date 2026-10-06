# Wholescripts supplement fulfilment API (Emulators subset) — operation support

Generated from `openapi.yaml`; do not edit by hand.

- operations in spec: **5**
- supported by the emulator: **5**
- parity enabled: **5**

| operationId | route | emulator | parity | notes |
| --- | --- | --- | --- | --- |
| `GetPrivateLabelProductList` | `GET /api/Orders/PrivateLabelProductList` | ✅ supported | ✅ |  |
| `GetProductList` | `GET /api/Orders/ProductList` | ✅ supported | ✅ |  |
| `SubmitOrder` | `POST /api/Orders/Submit` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `GetOrderStatus` | `GET /api/Orders/Status` | ✅ supported | ✅ |  |
| `CancelOrder` | `POST /api/Orders/Cancel` | ✅ supported | ⚠️ unsafe (opt-in) |  |
