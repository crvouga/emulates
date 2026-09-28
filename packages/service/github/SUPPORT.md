# GitHub REST subset (Mockingbird) — operation support

Generated from `openapi.yaml`; do not edit by hand.

- operations in spec: **9**
- supported by the mock: **5**
- parity enabled: **0**

| operationId | route | mock | parity | notes |
| --- | --- | --- | --- | --- |
| `repos/get` | `GET /repos/{owner}/{repo}` | ✅ supported | ❌ disabled | Live and property verification are scheduled after implementation. |
| `git/get-ref` | `GET /repos/{owner}/{repo}/git/ref/{ref}` | ✅ supported | ❌ disabled | Live and property verification are scheduled after implementation. |
| `git/list-matching-refs` | `GET /repos/{owner}/{repo}/git/matching-refs/{ref}` | ✅ supported | ❌ disabled | Live and property verification are scheduled after implementation. |
| `git/create-ref` | `POST /repos/{owner}/{repo}/git/refs` | ✅ supported | ❌ disabled | Live and property verification are scheduled after implementation. |
| `git/update-ref` | `PATCH /repos/{owner}/{repo}/git/refs/{ref}` | ✅ supported | ❌ disabled | Live and property verification are scheduled after implementation. |
| `pulls/list` | `GET /repos/{owner}/{repo}/pulls` | ❌ unsupported | — | Implementation is scheduled in the reference and pull-request stories. |
| `pulls/create` | `POST /repos/{owner}/{repo}/pulls` | ❌ unsupported | — | Implementation is scheduled in the reference and pull-request stories. |
| `pulls/get` | `GET /repos/{owner}/{repo}/pulls/{pull_number}` | ❌ unsupported | — | Implementation is scheduled in the reference and pull-request stories. |
| `pulls/update` | `PATCH /repos/{owner}/{repo}/pulls/{pull_number}` | ❌ unsupported | — | Implementation is scheduled in the reference and pull-request stories. |
