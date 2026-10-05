# Unsplash search subset — operation support

Generated from `openapi.yaml`; do not edit by hand.

- operations in spec: **3**
- supported by the mock: **3**
- parity enabled: **2**

| operationId | route | mock | parity | notes |
| --- | --- | --- | --- | --- |
| `SearchPhotos` | `GET /search/photos` | ✅ supported | ✅ |  |
| `TrackDownload` | `GET /photos/{id}/download` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `GetImage` | `GET /__admin/blobs/{id}` | ✅ supported | ❌ disabled | Local binary image fixture |
