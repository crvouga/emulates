# @crvouga/mockingbird-service-github

WIP GitHub REST mock targeting `X-GitHub-Api-Version: 2026-03-10`.
Only repository observations are implemented. References and pull requests are
inventoried but currently return an explicit mock-only 501 response.
[API_EVIDENCE.md](API_EVIDENCE.md) pins the source and distinguishes research from
runtime verification. [SUPPORT.md](SUPPORT.md) is generated from the contract.

## Install

```sh
bun add @crvouga/mockingbird-service-github
```

## API

The portable entry exports `GitHubAPI`, `createRuntime`, `GITHUB_NAMESPACE`,
`GITHUB_API_VERSION`, `document`, `operationIds`, and `supportedOperationIds`.
Types include `GitHubAPIOptions`, `GitHubRuntime`, `GitHubRuntimeOptions`,
`Repository`, `Commit`, `OperationId`, and `SupportedOperationId`.
The Node-only `/server` entry exports `createServer`, `DEFAULT_PORT`, `serveTarget`,
`GitHubServerOptions`, and `GitHubServer`. The executable is `mockingbird-github`.

## Usage

```ts
import { createRuntime } from "@crvouga/mockingbird-service-github"

const github = createRuntime({ seed: 42 })
await github.fetch(new Request("http://github.mock/__admin/github/repositories", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    owner: "synthetic-org", name: "example", default_branch: "main",
    commits: [{ sha: "a".repeat(40), parents: [] }],
    branches: { main: "a".repeat(40) },
  }),
}))
const response = await github.fetch(new Request("http://github.mock/repos/synthetic-org/example"))
console.log(await response.json())
```

`createRuntime` adds health, namespaces, clock, scoped faults, redacted request
journal and shared Timeline. Select a namespace with `x-mockingbird-namespace`
or `/ns/<name>/...` consistently on seed and provider requests. Reset removes
repository, owner, ancestry and branch state in that namespace; diagnostic history
and fault settings retain their shared runtime lifetimes. Checkpoints restore
all stored provider state through the shared Timeline.

`GitHubAPI` is the portable provider-only Fetch/Hono entry; `createServer` from
`@crvouga/mockingbird-service-github/server` exposes Node HTTP and returns a
`close` function. Programmatic servers default to an ephemeral loopback port.
The CLI is `mockingbird-github serve --port 8828`.

## Synthetic setup and boundaries

`POST /__admin/github/repositories` accepts owner/name, optional `private` and
`default_branch`, a `commits` array of lowercase 40-hex SHA/parents records and a
`branches` map of branch names to seeded SHAs. Omitted commits/branches create an
empty synthetic repository. Every parent and branch target must be seeded; cycles,
duplicates and an absent default branch in a nonempty branch map are rejected.
Validation completes before mutation; existing repositories cannot be overwritten
by this control. Use a fresh namespace or reset for a different fixture.
These are mock fixture constraints, not GitHub REST request rules.

Seeds create organization owners only. Same-owner repositories share owner
identity. Repository lookup is case-insensitive; branch names preserve case.
Only identity, ownership, visibility, default branch, URLs and timestamps are
returned; repository settings, statistics, permissions and full upstream response
coverage are not claimed. Missing repositories return a provider-shaped 404.
No credential-based namespace mapping or authorization policy is implemented.

The selected API version is returned in `x-github-api-version-selected`. Omitting
the request header selects this mock's 2026-03-10 contract, unlike GitHub's current
2022-11-28 default. Other versions return mock-only 501, not a claimed provider
error. This is an explicit single-version test double.

No Git transport, real commit creation, token issuance, GitHub App identity,
branch protection, repository rules, merge execution or outgoing notification is
provided. Seeded ancestry does not prove a real repository's contents. No
expected-old-SHA or universal pull-request idempotency guarantee is added.
Use synthetic fixture names only; journal records omit bodies and credential/query
values. Package tests require no GitHub account or network service.
