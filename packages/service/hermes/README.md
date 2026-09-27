# @crvouga/mockingbird-service-hermes

Work-in-progress scaffold for the Hermes Agent public peer-run API pinned to
`v2026.8.31`. Shared Mockingbird controls work; the six inventoried provider routes
currently return explicit mock-only 501 errors. No agent or inference runs.
[API_EVIDENCE.md](API_EVIDENCE.md) records source-backed semantics and gaps;
[SUPPORT.md](SUPPORT.md) records current operation support.

## Install

```sh
bun add @crvouga/mockingbird-service-hermes
```

## Usage

```ts
import { createRuntime } from "@crvouga/mockingbird-service-hermes"

const hermes = createRuntime({ seed: 42 })
const response = await hermes.fetch(new Request("http://hermes.mock/health"))
console.log(await response.json())
```

Use the portable `HermesAPI` class for provider routes alone. `createRuntime`
adds health, namespaces, admin controls, faults, clock, metrics, metadata-only
request journal, and shared Timeline checkpoints. It needs no Hermes installation,
provider account, prompt data, API key, or local service.

For an HTTP endpoint:

```ts
import { createServer } from "@crvouga/mockingbird-service-hermes/server"

const server = await createServer() // ephemeral loopback port
try {
  console.log(await (await fetch(`${server.url}/health`)).json())
} finally {
  await server.close()
}
```

The CLI is `mockingbird-hermes serve --port 8827`. Point a peer HTTP client's base
URL at `http://127.0.0.1:8827`; run submission is not implemented in this scaffold.
The Node entry is separate from the portable Fetch entry.

## Routes and controls

The contract inventories `POST /v1/runs`, `GET /v1/runs/{run_id}`,
`POST /v1/runs/{run_id}/stop`, and the events/approval/steer routes. None is
implemented yet. The mock-only 501 envelope uses `error.type` of
`mockingbird_unsupported` and `error.code` of `operation_not_implemented`.
Unknown paths return 404. These errors do not claim real Hermes rejection behavior.

- `GET /health` identifies the `hermes` runtime.
- Select isolated namespaces with `x-mockingbird-namespace` or `/ns/<name>/…`.
- `POST /__admin/reset` clears selected provider state and Timeline. Shared clock,
  faults and diagnostic journal retain their standard independent lifetimes.
- `POST /__admin/clock` controls the shared clock.
- `POST /__admin/faults` configures scoped operation/path/method fault rules;
  `DELETE /__admin/faults` clears them. No Hermes-specific presets exist yet.
- `GET /__admin/requests` exposes request metadata without bodies, query values
  or credentials. `DELETE /__admin/requests` clears selected diagnostic history.
- `POST /__admin/checkpoints` captures shared Timeline state. Checkout through
  `POST /__admin/branches/<name>/checkout` with `{ "checkpoint": "cp_…" }`.

The existing shared `adminKey` option controls admin access. No credential-based
namespace mapping or Hermes provider authentication logic is introduced.

## API

The portable entry exports:

- `HermesAPI`: provider `fetch` and `reset`, with namespace and shared SQLite storage.
- `HERMES_NAMESPACE`: the default storage namespace, `hermes`.
- `createRuntime`: the standard service runtime and shared controls.
- `document`: annotated OpenAPI contract.
- `operationIds`: all inventoried operations.
- `supportedOperationIds`: currently empty in the scaffold.

The Node-only `/server` entry exports:

- `createServer`: returns `runtime`, `server`, `url`, `host`, `port`, and `close`.
- `DEFAULT_PORT`: CLI default 8827; programmatic calls default to an ephemeral port.
- `serveTarget`: shared CLI server target.

Types include `HermesAPIOptions`, `HermesRuntime`, `HermesRuntimeOptions`,
`OperationId`, `SupportedOperationId`, `HermesServer`, and `HermesServerOptions`.
The executable `mockingbird-hermes` provides `serve`.

## Deliberately not modelled

Submission, polling, idempotency, stopping, interruption, retention and scripted
results arrive in later stories. This scaffold stores no prompts or results.
Kanban attempts, client intake/recovery policy, inference, Python dispatchers,
host tool execution and credential enforcement are excluded. There are no outgoing
webhooks, provider calls or agent processes. Public peer-run IDs will remain
separate from consumer intake and Kanban identities.

Source evidence is not runtime parity. Package/shared-control tests do not establish
compatibility with a real Hermes process; the pinned differential oracle is a later
gate. Keep this package WIP until independent Ready requirements are met.
