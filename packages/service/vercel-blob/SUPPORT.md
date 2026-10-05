# Vercel Blob API — operation support

Generated from `openapi.yaml`; do not edit by hand.

- operations in spec: **7**
- supported by the mock: **7**
- parity enabled: **3**

| operationId | route | mock | parity | notes |
| --- | --- | --- | --- | --- |
| `PutBlob` | `PUT /api/blob/` | ✅ supported | ❌ disabled | Raw bytes or action-dependent multipart requests are verified with the official SDK and binary HTTP acceptance tests. |
| `ReadBlobStore` | `GET /api/blob` | ✅ supported | ✅ |  |
| `CopyBlob` | `PUT /api/blob` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `DeleteBlobs` | `POST /api/blob/delete` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `MultipartUpload` | `POST /api/blob/mpu` | ✅ supported | ❌ disabled | Raw bytes or action-dependent multipart requests are verified with the official SDK and binary HTTP acceptance tests. |
| `DownloadBlob` | `GET /__admin/blobs/{id}` | ✅ supported | ❌ disabled | Raw bytes or action-dependent multipart requests are verified with the official SDK and binary HTTP acceptance tests. |
| `HeadDownload` | `HEAD /__admin/blobs/{id}` | ✅ supported | ❌ disabled | Raw bytes or action-dependent multipart requests are verified with the official SDK and binary HTTP acceptance tests. |
