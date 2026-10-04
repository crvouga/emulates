# @crvouga/mockingbird-service-sqs discovery

This is the installed-package index for coding agents and tooling. All relative links resolve
inside `node_modules/@crvouga/mockingbird-service-sqs/`; no repository checkout is needed to discover the mock's
supported surface or documented behavior.

## Capability and behavior sources

| Question | Authoritative file | What it contains |
| --- | --- | --- |
| Behaviour and integration | [`README.md`](README.md) | Routes, state transitions, auth, webhooks, controls, presets and deliberate omissions. |
| Exact capabilities | [`SUPPORT.md`](SUPPORT.md) | Supported, unsupported and parity-covered operations or commands, including reasons for gaps. |
| Wire contract | [`openapi.yaml`](openapi.yaml) | Machine-readable paths, methods, schemas, responses and parity annotations. |
| Public API | [`dist/index.d.ts`](dist/index.d.ts) | The installed package's exact TypeScript exports and signatures. |
| Package metadata | [`package.json`](package.json) | Runtime/entry-point claims, vendor links, parity scope/tier and `mockingbird.discovery`. |

Read these together: the contract/capability matrix says *what* is available, while the README
defines stateful behavior, lifecycle rules, test controls, and intentional oracle differences.
If prose and an executable surface disagree, report a parity mismatch instead of adding a
consumer-side workaround.

## Parity and oracle

- Declared parity surface: **Queues, FIFO, and batches**.
- Parity tier: **cold** (the repository controls when live checks run).
- Oracle: **Live vendor API or sandbox**.
- Repository command: `bun run parity:service -- sqs`.
- Evidence model: Run from a Mockingbird checkout; credentials come only from .env.local or GitHub Actions secrets. Missing credentials exit 2.

The npm package contains evidence summaries and the exact contract, not credentials or the
repository-only parity harness. Self-parity/property and acceptance tests run in the Mockingbird
repository; live parity is an additional oracle check, not a substitute for the packaged matrix.

## Runtime introspection

- `GET /__admin/health`
- `GET /__admin`
- `GET /__admin/state`
- `GET /__admin/requests`
- `GET /__admin/metrics`
- `GET /__admin/faults/presets`
- `GET /__admin/ui`

For HTTP services, use `x-mockingbird-namespace` (or the documented credential/path carrier) so
parallel tests do not share state. Admin state, journal, metrics and fault-preset endpoints are
designed for assertions and diagnosis by consuming test suites.

## Report a mismatch or missing capability

Follow the [agent reporting contract](https://github.com/crvouga/mockingbird/blob/main/docs/REPORTING_ISSUES.md). Include package version,
operation/command, a minimal redacted request, actual mock result, expected oracle result or vendor
documentation, and whether the mismatch appears in the matrix. Never include keys, tokens,
customer data, prompts, PHI, card data, or unredacted recordings.

Service key: `sqs`.
