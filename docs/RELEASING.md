# Releasing

How packages get from `main` to npm using Trusted Publishing, without a stored npm token.

Upgrading from the `@crvouga/mockingbird-service-*` packages? See
[Migrating from Mockingbird](MIGRATING.md).

## Package names

Every published service is `@emulates/<id>`, where `<id>` is its directory under
`packages/service/`. The name is derived, not chosen: `packageName(id)` in
[`project.ts`](../project.ts) builds it, and `check:boundaries` fails if a service's
`package.json` disagrees. Publishing needs the `emulates` npm organization to exist.

## How a release runs

A pull request whose checks passed is releasable. Merging it to `main` is the release. The Release workflow ([`.github/workflows/ci.yml`](../.github/workflows/ci.yml)) then publishes; it does not re-run Commitlint, Check, or the consumer smoke. Those already passed on the pull request ([`.github/workflows/pr.yml`](../.github/workflows/pr.yml)). Manual dispatch and a run every six hours only retry an interrupted publish ([`scripts/release/`](../scripts/release/lib.ts)):

- **Which packages:** every published service with a releasable Conventional Commit since its last `<name>@<version>` git tag — in its own directory or in any private helper it bundles — every service that has never been released, and every service that depends at runtime on one of those (workspace deps are pinned exactly).
- **Which version:** `feat!` / `BREAKING CHANGE` → major, `feat` → minor, `fix` / `perf` / `revert` / `refactor` / `build` / `docs` → patch, dependency-only → patch. `test` / `ci` / `chore` / `style` never release a package on their own. First releases start at `0.1.0`, unless the package or its [former name](#former-names) already has versions on npm, in which case they continue above the latest.
- **How:** build (replaying main's Turborepo cache from the GitHub Actions cache) → `bun pm pack` → `npm publish --provenance` via npm Trusted Publishing (OIDC) → push the `<name>@<version>` tag → GitHub Release with that package's notes. `pack:check`, portability, and the consumer smoke already ran as the Check job.

Versions live in tags, so `package.json` keeps `0.0.0-development` and nothing is committed back to `main` (same model as semantic-release). Every step is idempotent — re-running a failed release job finishes it.

OIDC cannot create a package that does not exist on npm yet. A maintainer runs `bun run release:seed` once with an interactive npm login; it first-publishes missing packages from `origin/main`, attaches `ci.yml` as each package's Trusted Publisher (`npm trust github`), and reconciles deprecations. CI never receives or falls back to a long-lived npm token. Until the seed runs, a never-published package fails the release (as do its dependents), while every independent package still releases. See [docs/SECRETS.md](SECRETS.md).

```bash
bun run release:plan                   # what the next push to main would release
bun run release:publish -- --dry-run   # plan + pack every tarball, no side effects
bun run release:seed                   # reconcile npm with origin/main using your npm login
bun run health                         # access pages whose Trusted Publisher still needs a click
bun run secrets:doctor                 # npm / Trusted Publishing / live parity status
```

## Former names

The project published as Mockingbird before the rename, and npm names are immutable, so the old
packages stay on npm, deprecated in favor of their successors:

- **Services.** Each `@crvouga/mockingbird-service-<id>` is succeeded by `@emulates/<id>`. The first
  `@emulates/<id>` release continues the former package's version line (the next patch above its
  latest published version) instead of restarting at `0.1.0`. Once the successor is on npm, the seed
  deprecates the former name with "This package has moved to @emulates/<id>. Install
  @emulates/<id> instead." A former name is never deprecated before its successor exists.
- **Helpers.** The former helper packages (`@crvouga/mockingbird`, `@crvouga/mockingbird-core`,
  `-service`, `-sqlite`, `-openapi*`, `-http-codec`, `-commands`, `-model`, `-canonicalize`,
  `-parity`, `-adapter-*`, `-openbao`) are bundled into the services and no longer published. Their
  deprecation messages are re-pointed at `@emulates/*`; the seed re-deprecates any package whose
  current message differs.
- **Archived packages.** `@crvouga/postgres-mem` and `@crvouga/sqlite-mem` continue here as
  `@emulates/postgres` and `@emulates/sqlite`.

After the rename merges, a maintainer runs `bun run rebrand:bootstrap -- --publish` once (add
`--dry-run` to preview). It requires the npm org `emulates` (create it at
https://www.npmjs.com/org/create; npm cannot create orgs from the CLI), then runs
`bun run release:seed`, which creates the `@emulates/*` packages, attaches their Trusted
Publishers, and deprecates the former names. OIDC
only authenticates publish operations, so CI logs pending deprecations for the next local seed
instead of managing package settings. The full old-to-new mapping is in
[MIGRATING.md](MIGRATING.md).

Local replica of the pull-request gate: `bun run check:full`.
