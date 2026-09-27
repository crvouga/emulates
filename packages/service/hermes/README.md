# @crvouga/mockingbird-service-hermes

Work-in-progress mock for the Hermes Agent public peer-run API pinned to
`v2026.8.31`. Submission and polling work with explicit synthetic lifecycle observations.
Stop, events, approval and steer remain unsupported. No agent or inference runs.
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
URL at `http://127.0.0.1:8827`; submission returns immediately while execution remains queued until scripted.
The Node entry is separate from the portable Fetch entry.

## Routes and controls

`POST /v1/runs` admits a run and `GET /v1/runs/{run_id}` polls it.
Stop, events, approval and steer return a mock-only 501 envelope with `error.type` of
`mockingbird_unsupported` and `error.code` of `operation_not_implemented`.
Missing runs use the pinned `run_not_found` 404 envelope. Unknown paths return
404. Mock-only errors do not claim real Hermes rejection behavior.

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
- `supportedOperationIds`: `RunCreate` and `RunGet`.

The Node-only `/server` entry exports:

- `createServer`: returns `runtime`, `server`, `url`, `host`, `port`, and `close`.
- `DEFAULT_PORT`: CLI default 8827; programmatic calls default to an ephemeral port.
- `serveTarget`: shared CLI server target.

Types include `HermesAPIOptions`, `HermesRuntime`, `HermesRuntimeOptions`,
`OperationId`, `SupportedOperationId`, `HermesServer`, and `HermesServerOptions`.
The executable `mockingbird-hermes` provides `serve`.

## Script a run

```ts
const accepted = await hermes.fetch(new Request("http://hermes.mock/v1/runs", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ input: "synthetic prompt" }),
}))
const { run_id } = await accepted.json()
await hermes.fetch(new Request(`http://hermes.mock/__admin/hermes/runs/${run_id}/observe`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ status: "completed", output: "synthetic result" }),
}))
const status = await hermes.fetch(new Request(`http://hermes.mock/v1/runs/${run_id}`))
console.log(await status.json())
```

Admission returns 202 `{ run_id, status: "started", replayed: false }`. The stored
status starts as `queued`. Repeated polling does not advance execution or time.
Use the same namespace on submission, observations and polling. Optional
`session_id` defaults to the run ID when absent or falsy. `model` defaults to
`hermes-agent` only when absent; an explicit null or empty value is retained, as
in the pinned handler. A valid `X-Hermes-Session-Key` is echoed without deriving a
conversation ID or authenticating credentials. Model routing and transcript loading
are not simulated. IDs are deterministic opaque hex strings, separate from sessions.

The observation control accepts `status`: `queued`, `running`,
`waiting_for_approval`, `stopping`, `completed`, `failed`, `cancelled`, or
`interrupted`. It accepts optional `last_event`; `approval` only while waiting;
`error` only for failed/interrupted; and `output`, `usage`, `pending_steer` only
for completed. Usage has three nonnegative integer counts: `input_tokens`,
`output_tokens`, `total_tokens`. Completion defaults to empty output and zero counts.
Terminal observations cannot be changed (409); invalid control payloads return 400
without changing state. These are mock controls, not additional Hermes routes.

Timestamps are Unix seconds from the shared clock. Run records and their identity
sequence use shared storage and Timeline; reset clears them. No timers, agent
handles or prompts are stored. Polling result content stays out of journals.
Malformed roots/final input elements, hosted rooms and invalid memory-scope headers
currently return explicit mock-only 501 responses. See evidence for these limits.

## Idempotent submission and synthetic scope

Send `Idempotency-Key` to reserve a delivery. Identical retries return 202 with
the original run ID, its current status, `replayed: true`, and
`Idempotency-Replayed: true`. A changed payload with the same scoped key returns
409 `idempotency_key_conflict`. Concurrent identical requests reserve one run.
Empty/whitespace keys disable deduplication; other keys must contain 1–255 visible
ASCII characters after Python-style trimming. Validation errors reserve nothing.

The fingerprint covers the entire parsed JSON body, including unknown fields,
and the trimmed `X-Hermes-Session-Key`. Object key order does not matter; array
order and session/body changes do. Raw integer/float forms follow Python:
`1` and `1.0` conflict, `1.0` and `1e0` replay, and negative floating zero differs
from positive zero. Lone Unicode surrogates return an explicit mock-only 501;
Python cannot UTF-8 encode that fingerprint either.

`POST /__admin/hermes/scope` with `{ "profile": "synthetic-profile",
"identity": "synthetic-listener" }` selects an explicit synthetic scope within
the current Mockingbird namespace. Defaults are `default` and
`unauthenticated-test-listener`. Use only synthetic labels, never credentials.
Changing scope isolates reservations and public polling; returning to it restores
access to its runs. Session IDs and memory keys are not scope selectors, and
bearer text is ignored. This control does not implement authentication.

Reservations and owners survive reconstructing a `HermesAPI` with the same
SQLite client and namespace. Terminal replay is verified after that modeled
adapter reconstruction. Actual process/disk durability and unfinished-run restart
outcomes are separate claims; stop/restart behavior is still pending. Shared
Timeline restores scope, reservations and run records together; reset clears them.
No public key-lookup endpoint is added. Request bodies are hashed in memory and
not persisted; stored reservations contain the key, hash and run identity.

## Deliberately not modelled

Stop/restart behavior and retention arrive in later stories. Prompts, instructions and history are validated then discarded.
Synthetic result text can be stored by observation controls and is cleared by reset.
Kanban attempts, client intake/recovery policy, inference, Python dispatchers,
host tool execution and credential enforcement are excluded. There are no outgoing
webhooks, provider calls or agent processes. Public peer-run IDs will remain
separate from consumer intake and Kanban identities.

Source evidence is not runtime parity. Package/shared-control tests do not establish
compatibility with a real Hermes process; the pinned differential oracle is a later
gate. Keep this package WIP until independent Ready requirements are met.
