# @emulates/s3-control

> Part of [Emulates](https://github.com/crvouga/emulates): high-fidelity, in-process emulators for APIs and databases.

Transport scaffold for Amazon S3 Control. ESM; Node 22+ or Bun 1.2+.

## Usage

```ts
import { createServer } from "@emulates/s3-control/server"
const mock = await createServer()
// AWS SDK: endpoint: mock.url, region: "us-east-1", fixture credentials.
// Await mock.close() after the test.
```

State lives in SQLite collections and participates in the shared runtime's namespace isolation,
reset, timeline, clock, journal, metrics and fault controls. No AWS account is needed.

**Planned, not implemented**, AWS operations: `PutPublicAccessBlock`, `GetPublicAccessBlock`, `DeletePublicAccessBlock`, `CreateAccessPoint`, `GetAccessPoint`, `ListAccessPoints`, `DeleteAccessPoint`, `PutAccessPointPolicy`, `GetAccessPointPolicy`, `DeleteAccessPointPolicy`.

Operations outside this list fail explicitly. This package emulates API state, not AWS infrastructure,
production quotas, billing, IAM enforcement, or provider consoles. Service-specific omissions and
oracle evidence are recorded in [the AWS coverage ledger](../../../docs/AWS_COVERAGE.md).

Run `bun run parity` with LocalStack on `http://127.0.0.1:4566`; an unavailable oracle fails the run.
No LocalStack run is recorded for this integration. The parity command is a bounded read-only SDK envelope probe, not proof of full vendor equivalence.

## Implementation status

No vendor operations are implemented. Requests fail explicitly with `UnknownOperationException`; transport tests cover this boundary and malformed input. This package is not a usable vendor replacement yet. No LocalStack or live AWS parity is claimed.

## Install

```sh
bun add @emulates/s3-control
```

## API

- `S3ControlAPI(options?)`: low-level AWS transport instance with `fetch` and `reset`.

- `createRuntime(options?)`: in-process Fetch API and shared state controls.
- `createServer(options?)` from the `/server` entry: HTTP listener with `url`, `runtime`, and `close()`.
- `document`, `operationIds`, and `supportedOperationIds`: generated transport contract metadata.
