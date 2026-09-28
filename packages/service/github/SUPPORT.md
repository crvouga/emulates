# GitHub REST subset (Mockingbird) — operation support

Generated from `openapi.yaml`; do not edit by hand.

- operations in spec: **9**
- supported by the mock: **1**
- parity enabled: **0**

| operationId | route | mock | parity | notes |
| --- | --- | --- | --- | --- |
| `repos/get` | `GET /repos/{owner}/{repo}` | ✅ supported | ❌ disabled | Live and property verification are scheduled after implementation. |
| `git/get-ref` | `GET /repos/{owner}/{repo}/git/ref/{ref}` | ❌ unsupported | — | Implementation is scheduled in the reference and pull-request stories. |
| `git/list-matching-refs` | `GET /repos/{owner}/{repo}/git/matching-refs/{ref}` | ❌ unsupported | — | Implementation is scheduled in the reference and pull-request stories. |
| `git/create-ref` | `POST /repos/{owner}/{repo}/git/refs` | ❌ unsupported | — | Implementation is scheduled in the reference and pull-request stories. |
| `git/update-ref` | `PATCH /repos/{owner}/{repo}/git/refs/{ref}` | ❌ unsupported | — | Implementation is scheduled in the reference and pull-request stories. |
| `pulls/list` | `GET /repos/{owner}/{repo}/pulls` | ❌ unsupported | — | Implementation is scheduled in the reference and pull-request stories. |
| `pulls/create` | `POST /repos/{owner}/{repo}/pulls` | ❌ unsupported | — | Implementation is scheduled in the reference and pull-request stories. |
| `pulls/get` | `GET /repos/{owner}/{repo}/pulls/{pull_number}` | ❌ unsupported | — | Implementation is scheduled in the reference and pull-request stories. |
| `pulls/update` | `PATCH /repos/{owner}/{repo}/pulls/{pull_number}` | ❌ unsupported | — | Implementation is scheduled in the reference and pull-request stories. |
