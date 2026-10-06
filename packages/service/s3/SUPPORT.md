# Amazon S3 (Emulates subset) — operation support

Generated from `openapi.yaml`; do not edit by hand.

- operations in spec: **9**
- supported by the emulator: **9**
- parity enabled: **8**

| operationId | route | emulator | parity | notes |
| --- | --- | --- | --- | --- |
| `ListObjectsV2` | `GET /{bucket}` | ✅ supported | ✅ |  |
| `CreateBucket` | `PUT /{bucket}` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `BucketPost` | `POST /{bucket}` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `HeadBucket` | `HEAD /{bucket}` | ✅ supported | ✅ |  |
| `GetObject` | `GET /{bucket}/{key}` | ✅ supported | ✅ |  |
| `PutObject` | `PUT /{bucket}/{key}` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `MultipartPost` | `POST /{bucket}/{key}` | ✅ supported | ❌ disabled | Multipart XML protocol. |
| `DeleteObject` | `DELETE /{bucket}/{key}` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `HeadObject` | `HEAD /{bucket}/{key}` | ✅ supported | ✅ |  |
