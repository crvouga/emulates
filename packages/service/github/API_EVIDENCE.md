# GitHub REST contract evidence

Research date: 2026-09-27. This is the US-024 contract definition, not implemented
support or live parity evidence. Delivery remains independent of Initiative.

## Version and reproducible source

Target `https://api.github.com` with `Accept: application/vnd.github+json` and
**`X-GitHub-Api-Version: 2026-03-10`**. GitHub's [version policy](https://docs.github.com/en/rest/about-the-rest-api/api-versions)
lists that version as supported and identifies `2022-11-28` as the current default
when the header is omitted. The mock must explicitly advertise its selected
version; accepting an omitted header must not claim compatibility with the older
contract. Unsupported-version handling must be documented as a mock limitation
unless compared with GitHub.

The authoritative schema is the stable, version-specific file
[`descriptions/api.github.com/api.github.com.2026-03-10.json`](https://github.com/github/rest-api-description/blob/c6721f32a17a71397ae46be21be90d7f1a173b6e/descriptions/api.github.com/api.github.com.2026-03-10.json),
not `descriptions-next` or an unversioned alias:

- Repository: `github/rest-api-description` (MIT).
- Commit: `c6721f32a17a71397ae46be21be90d7f1a173b6e`.
- File SHA-256: `106b151eb723284d9449cd6dae26bc87e60d313f75e8ad98c18e9327d4281b88`.
- OpenAPI metadata version `1.1.4` describes the specification; it is not the API date.
- [Raw immutable source](https://raw.githubusercontent.com/github/rest-api-description/c6721f32a17a71397ae46be21be90d7f1a173b6e/descriptions/api.github.com/api.github.com.2026-03-10.json).

Context7 resolved `GitHub REST API` to `/websites/github_en_rest`; also advertised
`/github/rest-api-description` and generated OpenAPI indexes. Queries covered
repository identity/default branch, matching/get/create/update refs, ancestry and
force, PR create/get/list/update, filters/pagination, errors and idempotency.
Its answers confirmed ref and PR-list routes but did not establish a pinned API
version, duplicate-PR wire errors or universal idempotency. The explicit immutable
schema above, read directly, resolves versioned field/status definitions. Context7's
permission summaries are not authorization evidence and are not modeled as policy.

## Declared operation inventory

These nine operations define the initial REST subset. Schema-listed statuses are
an inventory, not a promise to implement every response or deployment condition.
Unsupported paths and features must be explicit in the eventual support matrix.

| Operation ID | Method and path under `/repos/{owner}/{repo}` | Schema statuses |
| --- | --- | --- |
| `repos/get` | `GET` repository root | 200, 301, 403, 404 |
| `git/get-ref` | `GET /git/ref/{ref}` | 200, 404, 409 |
| `git/list-matching-refs` | `GET /git/matching-refs/{ref}` | 200, 409 |
| `git/create-ref` | `POST /git/refs` | 201, 409, 422 |
| `git/update-ref` | `PATCH /git/refs/{ref}` | 200, 409, 422 |
| `pulls/list` | `GET /pulls` | 200, 304, 422 |
| `pulls/create` | `POST /pulls` | 201, 403, 422 |
| `pulls/get` | `GET /pulls/{pull_number}` | 200, 304, 404, 406, 422, 500, 503 |
| `pulls/update` | `PATCH /pulls/{pull_number}` | 200, 403, 422 |

Primary references: [repositories](https://docs.github.com/en/rest/repos/repos#get-a-repository),
[refs](https://docs.github.com/en/rest/git/refs), [pull requests](https://docs.github.com/en/rest/pulls/pulls).
The schema is exhaustive for this table; common HTTP/auth/rate errors can exist
beyond an operation's listed responses and need corresponding mock contract entries
when explicitly scripted.

## Identity, state and scope

Repository `id` and opaque `node_id` are distinct from `owner.login`, `name`,
`full_name`, URLs and `default_branch`. Owner/repository lookup is case-insensitive
per shared schema parameters; do not infer that Git ref names are case-insensitive.
A default branch is a branch name, not a commit ID. Ref responses use a full `ref`
(such as `refs/heads/topic`), opaque `node_id`, URL and `object` containing type,
SHA and URL. Preserve nested branch names. A PR has its own ID, opaque node ID,
repository-scoped integer `number`, URLs, and separate head/base branch/repository/
SHA relationships. Do not identify PRs solely by a mutable branch tip.

Mock namespaces isolate all synthetic repository, commit ancestry, ref and PR
records. Explicit admin seeding creates synthetic commit objects/parent edges;
this is not Git object storage, commit creation over REST, push, clone or fetch.
Shared Collections, injected clock, deterministic IDs and Timeline own persistence
and history. No token issuance, GitHub App identity or production authorization
logic is introduced. Scripted denied responses are scenarios, not verified
permissions, branch protection or repository rules enforcement.

## Reference semantics and concurrency

The single-ref read uses `/git/ref/{ref}`; mutations use `/git/refs`. Matching-ref
reads return prefix matches, so a missing exact branch can still have matching
longer names. The source also documents the empty prefix as all refs. It declares
no `page` or `per_page` parameters for this endpoint; do not invent PR-style
pagination for matching refs. A missing exact ref returns 404.

Creation requires a fully qualified `ref` and `sha`; GitHub documents rejection
without `refs` and at least two slashes, and disallows ref creation in an empty
repository without branches. Validation and collisions must not overwrite an
existing ref. Exact error wording for collisions, missing objects, malformed names
and empty repositories still needs the authorized oracle; listed 409/422 statuses
alone do not prove which condition uses which envelope.

Update requires `sha`, with optional `force` defaulting to false. Non-forced
updates require a fast-forward from the head current when the request executes.
The mock must evaluate seeded ancestry at mutation time, including intervening
head movement. It may model force on synthetic records or explicitly reject it
as unsupported; no live force-push is authorized.

**REST ref update has no documented expected-old-SHA request field.** This follows
from the pinned update schema's complete property list (`sha`, `force`), not a
claim that every GitHub transport lacks compare-and-swap. Fast-forward checking
is not an expected-head lease: a concurrent update can still permit a later update
if ancestry allows it. Do not add fictional `expected_sha`, `old_sha`, operation-ID
or atomic ref-plus-PR guarantees. Initiative's broker/transport selection and
publication lineage remain consumer responsibilities.

## Pull requests and uncertain creation

Create accepts `head`, `base`, and a title unless converting an existing `issue`;
optional fields include body, draft, maintainer modification and cross-repository
head metadata. The base belongs to the target repository; head syntax may carry
an owner prefix. Update accepts title, body, state (`open`/`closed`), base and
maintainer modification; it does not replace the head branch. The initial mock
must preserve supported repository/head/base/number/SHA relationships and explicitly
mark issue conversion, cross-repository networks or unsupported media/features
rather than silently claiming them. Mergeability computation and test merge
commits are outside the initial subset; null is not proof of a clean merge.

**The pinned PR-create schema documents no universal idempotency-key contract.**
No header or body property in this operation promises consumer operation-ID
replay. Retrying after a lost response requires observing remote state, including
head/base filters and pagination; a duplicate validation error is not a replay
response. Exact duplicate/no-change-branch errors and closed-PR re-creation cases
are not established by the generic 422 declaration. US-027/US-030 must obtain
specific evidence before claiming exact duplicate compatibility; never invent
server-side request-ID deduplication to make the consumer fixture pass.

PR creation can trigger notifications and secondary rate limits. Live creation
requires explicit disposable repository, write and notification authorization.
No external PR/ref has been created during this research.

## Pagination and errors

PR lists default to state `open`, support `open`/`closed`/`all`, head in
`owner:branch` form, and base branch filters. The schema declares sort values
`created`, `updated`, `popularity`, `long-running`; default created order is
descending, while the other default directions are ascending. Support each
advertised option accurately or report it as unsupported. Page defaults to 1;
per-page defaults to 30, maximum 100. The [pagination guide](https://docs.github.com/en/rest/using-the-rest-api/using-pagination-in-the-rest-api)
documents clamping oversized per-page requests, omission of Link when unnecessary,
and navigation via available next/prev/first/last relations. Filter first, then
sort/page; retain filters in generated links. Do not infer a consistent snapshot
across concurrent list calls. Invalid negative/noninteger query handling remains
a targeted oracle question.

Pinned `basic-error` fields include message, documentation_url, url and string
status. Validation errors require message/documentation_url and can add structured
errors (resource, field, code, message) or strings via the simple variant. Do not
force every provider failure into one shape. Missing/private resources may be
indistinguishable to a client; the mock's scripted 404/403 scenarios do not prove
real authorization behavior. See [troubleshooting](https://docs.github.com/en/rest/using-the-rest-api/troubleshooting-the-rest-api).

The [rate-limit guide](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)
distinguishes primary/secondary limits; exhaustion can return 403 or 429. Honor
Retry-After when present and expose appropriate x-ratelimit metadata in scenarios.
Do not simulate real quota consumption, identity-based limits or enforcement.
Accepted-write/response-loss must retain state independently of transport failure;
pre-mutation errors must leave state unchanged and journals must remain metadata-only.

## Verification gaps and next gates

This story ran read-only documentation/schema retrieval and source validation.
No account, credential, operational repository, writes or notifications were used.
No runtime compatibility, full schema coverage or Ready status is claimed.

Subsequent work must resolve exact semantic wire errors through primary evidence
or bounded authorized live comparisons, preserve operation coverage and deliberate
divergence sensitivity, and exercise lost PR acknowledgment, ref movement,
duplicates, pagination and retry-after with an independent consumer. US-030 needs
an explicit owned disposable repository and operations/cleanup scope; missing
credentials must be reported by key name only. No default-branch update, merge,
force-push or unrelated resource modification is allowed. All provider limitations
must remain visible in SUPPORT/README and the oracle report.
