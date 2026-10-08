# Local scripted OpenAI API — operation support

Generated from `openapi.yaml`; do not edit by hand.

- operations in spec: **16**
- supported by the emulator: **16**
- parity enabled: **13**

| operationId | route | emulator | parity | notes |
| --- | --- | --- | --- | --- |
| `ListChatCompletions` | `GET /v1/chat/completions` | ✅ supported | ✅ |  |
| `CreateChatCompletion` | `POST /v1/chat/completions` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `GetChatCompletion` | `GET /v1/chat/completions/{completion_id}` | ✅ supported | ✅ |  |
| `DeleteChatCompletion` | `DELETE /v1/chat/completions/{completion_id}` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `CreateEmbeddings` | `POST /v1/embeddings` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `ListModels` | `GET /v1/models` | ✅ supported | ✅ |  |
| `GetModel` | `GET /v1/models/{model}` | ✅ supported | ✅ |  |
| `ListFiles` | `GET /v1/files` | ✅ supported | ✅ |  |
| `CreateFile` | `POST /v1/files` | ✅ supported | ❌ disabled | Multipart/binary byte shapes are verified by served SDK and acceptance tests. |
| `GetFile` | `GET /v1/files/{file_id}` | ✅ supported | ✅ |  |
| `DeleteFile` | `DELETE /v1/files/{file_id}` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `DownloadFile` | `GET /v1/files/{file_id}/content` | ✅ supported | ❌ disabled | Multipart/binary byte shapes are verified by served SDK and acceptance tests. |
| `CreateUpload` | `POST /v1/uploads` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `CreateUploadPart` | `POST /v1/uploads/{upload_id}/parts` | ✅ supported | ❌ disabled | Multipart/binary byte shapes are verified by served SDK and acceptance tests. |
| `CompleteUpload` | `POST /v1/uploads/{upload_id}/complete` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `CancelUpload` | `POST /v1/uploads/{upload_id}/cancel` | ✅ supported | ⚠️ unsafe (opt-in) |  |
