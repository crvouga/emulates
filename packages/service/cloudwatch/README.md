# @emulates/cloudwatch

> Part of [Emulates](https://github.com/crvouga/emulates): high-fidelity, in-process emulators for APIs and databases.

Stateful local emulator of Amazon CloudWatch Metrics. ESM; Node 22+ or Bun 1.2+.

## Usage

```ts
import { createServer } from "@emulates/cloudwatch/server"
const mock = await createServer()
// AWS SDK: endpoint: mock.url, region: "us-east-1", fixture credentials.
// Await mock.close() after the test.
```

State lives in SQLite collections and participates in the shared runtime's namespace isolation,
reset, timeline, clock, journal, metrics and fault controls. No AWS account is needed.

Implemented AWS operations: `PutMetricData`, `ListMetrics`, `GetMetricStatistics`, `GetMetricData`, `PutMetricAlarm`, `DescribeAlarms`, `DeleteAlarms`, `EnableAlarmActions`, `DisableAlarmActions`, `SetAlarmState`, `PutDashboard`, `GetDashboard`, `ListDashboards`, `DeleteDashboards`.

Operations outside this list fail explicitly. This package emulates API state, not AWS infrastructure,
production quotas, billing, IAM enforcement, or provider consoles. Service-specific omissions and
oracle evidence are recorded in [the AWS coverage ledger](../../../docs/AWS_COVERAGE.md).

Run `bun run parity` with LocalStack on `http://127.0.0.1:4566`; an unavailable oracle fails the run.
No LocalStack run is recorded for this integration. The parity command is a bounded read-only SDK envelope probe, not proof of full vendor equivalence.

## Install

```sh
bun add @emulates/cloudwatch
```

## API

- `CloudwatchAPI(options?)`: low-level AWS transport instance with `fetch` and `reset`.

- `createRuntime(options?)`: in-process Fetch API and shared state controls.
- `createServer(options?)` from the `/server` entry: HTTP listener with `url`, `runtime`, and `close()`.
- `document`, `operationIds`, and `supportedOperationIds`: generated transport contract metadata.
