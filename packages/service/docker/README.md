# @crvouga/mockingbird-service-docker

Work-in-progress Docker Engine API 1.52 mock. It implements GET/HEAD `/_ping`,
GET `/version`, `/info`, `/containers/json`, and `/containers/{id}/json`, plus
Mockingbird's shared runtime controls. POST `/containers/create` persists a stopped
container. Start, wait, stop, kill, and removal use explicit simulated completion.
Attached streams remain unavailable. The contract is
pinned in [API_EVIDENCE.md](API_EVIDENCE.md); [SUPPORT.md](SUPPORT.md) lists operations.

## Install

```sh
bun add @crvouga/mockingbird-service-docker
```

## Usage

```ts
import { createRuntime } from "@crvouga/mockingbird-service-docker"

const docker = createRuntime({ seed: 42 })
const response = await docker.fetch(new Request("http://docker.mock/_ping"))
console.log(await response.text()) // OK
```

Use `DockerAPI` for the provider-only Fetch surface, or `createRuntime` for health,
admin controls, namespaces, faults, metrics, and the request journal. Neither entry
imports a Node server. The Node entry provides `createServer()` with an ephemeral
loopback port by default; close it with `await server.close()` after a test.

```sh
mockingbird-docker serve --port 8826
```

HTTP clients can target `http://127.0.0.1:8826`. A Docker client using `DOCKER_HOST`
can select `tcp://127.0.0.1:8826`. Unversioned and `/v1.52` provider routes work.
Versions above 1.52 or below the simulated Engine minimum 1.44 receive provider
400 errors (plain text below 1.24, JSON otherwise). Versions 1.44–1.51 receive an
explicit mock-only 501: their wire formats are not implemented. Full client
compatibility and real Engine parity remain pending.

## Synthetic observations

`POST /__admin/docker/seed` atomically adds images and containers in the selected
namespace. It never downloads an image or starts a process. For example:

```ts
await docker.fetch(new Request("http://docker.mock/__admin/docker/seed", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    images: [{ id: `sha256:${"a".repeat(64)}`, tags: ["synthetic:latest"] }],
    containers: [{
      id: "b".repeat(64), name: "worker", image: "synthetic:latest",
      status: "running", labels: { suite: "example" }, cmd: ["synthetic-worker"],
    }],
    daemon: { rootless: true },
  }),
}))
```

Image IDs are immutable SHA-256 strings; container IDs are separate 64-character
lowercase hexadecimal strings. Container `image` resolves an existing image ID
or exact tag. Duplicate IDs, names and image tags conflict; unknown images return
404. Invalid seed fields return 400 and roll back the entire seed. Container
fields also accept `exitCode`, `entrypoint`, `env`, `workingDir`, `user`,
`hostConfig`, `networkSettings`, `sizeRw`, and `sizeRootFs`. Status is one of
`created`, `running`, `paused`, `restarting`, `removing`, `exited`, or `dead`.
Timestamps use the mock clock; reported PIDs are zero, never host processes.

`GET /__admin/docker/daemon` reports `{ available, rootless, simulated: true }`.
`POST` to the same route changes either boolean. `available: false` drops provider
requests while shared health/admin routes remain accessible and container state
is retained. Rootless, security, OS, build, size, and resource metadata are
synthetic observations, not host attestation or enforcement.

List defaults to running containers, including paused/restarting ones. `all`,
positive `limit`, or a `status` filter includes stopped containers. `limit` selects
the newest results; `size` includes the seeded byte counts. Like the pinned
Engine's boolean parser, empty/0/no/false/none (case-insensitive) mean false and
other values mean true. Inspect resolves full IDs, unique prefixes, and names.

`filters` accepts JSON string arrays or boolean-key sets for `id`, `name`,
`status`, `label`, and `exited`. Categories combine with AND; values within a
category combine with OR, except labels which all must match. Name matching
supports literals, dots, anchors, and at most one `.*`; other regex constructs
and other filter categories return explicit mock-only 501 errors. Malformed
filter shapes, statuses and exit codes return 400. Seeded state and daemon
settings participate in shared reset and Timeline checkpoints.

## Container creation

Seed images before calling `POST /containers/create`. Image seeds may include
`platform` (default `linux/amd64`) and `config` containing supported image defaults.
Creation resolves image IDs or exact tags, adding `:latest` to an untagged reference.
It never pulls or executes an image. Missing images and requested platform
mismatches return 404; an implicit host-platform mismatch produces a warning.

The supported body fields are `Image`, `Cmd`, `Entrypoint`, `Env`, `Labels`,
`WorkingDir`, `User`, `Hostname`, `Domainname`, `AttachStdin`, `AttachStdout`,
`AttachStderr`, `OpenStdin`, `StdinOnce`, `Tty`, `NetworkDisabled`, `StopSignal`,
`StopTimeout`, `HostConfig`, and `NetworkingConfig`. Unsupported fields return
explicit mock-only 501 errors. Bad field types, relative working directories,
invalid stop signals, invalid names, and missing commands return 400.
Image defaults supply commands/entrypoints, environment, labels and selected
strings. Request environment keys and labels take precedence. `Entrypoint: [""]`
clears the image entrypoint; provide a replacement command when doing so.

Use `?name=...` for a stable name. Conflicting names return 409, including concurrent
creation requests. Omitted names use `mockingbird_<id-prefix>`. Responses contain
`Id` and `Warnings`; IDs are deterministic synthetic 64-character hex strings,
immutable within stored records and restored with the shared ID sequence by
Timeline checkout. New records inspect as `created` with `Running: false`.

Supported `HostConfig` metadata includes `NetworkMode`, `IpcMode`, `PidMode`,
`CgroupnsMode`, `Runtime`, `AutoRemove`, `ReadonlyRootfs`, `Privileged`, `Init`,
`Memory`, `MemorySwap`, `NanoCpus`, `CpuShares`, `PidsLimit`, `Binds`, `CapDrop`,
`CapAdd`, `SecurityOpt`, `Dns`, `ExtraHosts`, `Mounts`, `Tmpfs`, `PortBindings`,
`RestartPolicy`, and `LogConfig`. `NetworkingConfig.EndpointsConfig` is retained
under inspected `NetworkSettings.Networks`. These are declared configuration
observations, not enforced resources, mounts, security controls or network setup.
Nested host metadata is retained as supplied; full daemon-specific resource and
network validation is not modelled. No host isolation claim follows from it.

## Start, wait and scripted completion

`POST /containers/<id>/start` marks a created/exited container running (204),
returns 304 when already running/restarting, and returns 409 for paused, dead,
or removing records. No image is executed. The clock supplies `StartedAt`;
restart clears the exit code but retains the prior `FinishedAt` until completion.
Checkpoint, checkpoint-dir and detachKeys options return explicit mock-only 501.
As in the pinned Engine route, bodies longer than seven bytes and chunked bodies
return 400; use an empty body.

`POST /containers/<id>/wait?condition=...` accepts `not-running` (also the default
for omitted/empty values), `next-exit`, or `removed`. Headers arrive immediately;
the JSON body `{ "StatusCode": 7 }` arrives only when the condition holds.
Not-running returns immediately for stopped/created containers. Next-exit waits
for a future exit even if already stopped. Removed remains pending after an
ordinary exit. Invalid conditions return 400 and unknown containers return 404
before opening the stream.

Use `POST /__admin/docker/containers/<id>/complete` with `{ "exitCode": 7 }` to
explicitly finish a running synthetic container. Completion persists `exited`,
`FinishedAt`, and the supplied integer code, wakes relevant waiters, and captures
a shared Timeline checkpoint. If `HostConfig.AutoRemove` is true, completion also
removes the synthetic record and satisfies removed waits. No host resource is
touched. Repeated completion while stopped returns 409. These controls operate on
the selected namespace's main branch; provider operations can use shared branches.

`GET /__admin/docker/waits` reports the namespace's pending wait and termination-reply handles.
Aborting the request or canceling its response body releases its wait handle.
Reset cancels waits in the reset namespace; `runtime.close()`, `DockerAPI.close()`
and `createServer().close()` cancel owned waits. Canceled bodies reject rather
than fabricate an exit code. Wait handles are transient and never serialized.
Active-wait checkout semantics are a subsequent history-consistency story.
Generated parity excludes blocking waits; deterministic Fetch and real HTTP tests
cover their completion/cancellation behavior. Live Engine parity remains pending.

## Stop, signals and removal

`POST /containers/<id>/stop` records an accepted stop request without changing
`Running`. The HTTP request remains pending until the explicit completion control
finishes execution, then returns 204. Already-stopped containers return 304.
`signal` selects the requested signal (default Config.StopSignal or TERM); `t`
selects the timeout (default Config.StopTimeout or 10 seconds; negative means no
escalation timeout). The mock records these parameters for scenario inspection.
It does not schedule real timers or automatically declare exit when a timeout
expires: script graceful completion or forced completion, including the exit code,
through `/__admin/docker/containers/<id>/complete`. This permits controlled delayed
termination without fabricating an early Docker success response.

`POST /containers/<id>/kill` defaults to SIGKILL and keeps its 204 reply pending
until completion; explicit KILL/9 behaves identically. Other supported Linux
signal names/numbers acknowledge delivery with 204 while preserving execution
state. The fixture decides the subsequent process response. No host signal is
sent. Killing a stopped container returns 409. Invalid kill signals return 400;
pinned Engine stop signal errors and malformed `t` return 500. Timeouts outside
JavaScript's safe integer range return explicit mock-only 501.

`DELETE /containers/<id>` removes a stopped record and releases its name (204).
Running or paused records require `force=true`; otherwise removal returns 409.
Forced removal records intent and waits for explicit completion, then removes the
record and wakes both exit and removed waiters. A second removal while forced
removal is pending returns 409. Seed status `removing` to model an existing removal
conflict. Missing records return 404. `v` is accepted but no host volumes exist;
`link=true` is outside this subset and returns mock-only 501.

`GET /__admin/docker/containers/<id>/termination` returns the last accepted request
(operation, numeric signal, optional timeout and request time), `removalPending`,
and `simulated: true`. These diagnostic fields are not Docker wire fields.
Canceling a stop/kill/removal reply releases only the reply handle. Accepted intent
and running state survive socket loss; explicit completion still applies, including
pending forced removal. Reset clears the namespace and cancels its pending replies.
Closing a runtime/server cancels replies without claiming exit. Accepted-mutation
history after response loss is the subsequent US-008 verification gate.

## Controls

- `GET /health` reports readiness and service identity.
- Select independent state with `x-mockingbird-namespace` or `/ns/<name>/…`.
- `POST /__admin/reset` resets the selected namespace's records and Timeline;
  `?all=1` resets all namespaces. It preserves clock, fault configuration and journal.
- `POST /__admin/clock` accepts shared `set`, `advance`, and `freeze` controls.
- `POST /__admin/faults` configures faults by operation, path, or method.
  `DELETE /__admin/faults` clears them. There are no Docker-specific presets yet.
- `GET /__admin/requests` exposes metadata, never request bodies or query values;
  `DELETE /__admin/requests` clears the selected journal.
- `POST /__admin/checkpoints`, `POST /__admin/branches/<name>`, and
  `POST /__admin/branches/<name>/checkout` use the shared Timeline coordinator.
  There is no Docker-local history manager. Pass `{ "checkpoint": "cp_…" }` to checkout.

The shared `adminKey` option gates admin routes. Docker credential-based namespace
selection, webhooks and provider credentials are not configured.

## API

The portable `@crvouga/mockingbird-service-docker` entry exports:

- `DockerAPI`: provider Fetch handler with `fetch`, `reset`, and `close`.
- `DOCKER_NAMESPACE`: default storage namespace (`docker`).
- `createRuntime`: provider plus standard Mockingbird controls and Timeline.
- `document`: annotated OpenAPI contract.
- `operationIds`: all inventoried operation IDs, including unsupported routes.
- `supportedOperationIds`: currently implemented operation IDs.

The Node-only `@crvouga/mockingbird-service-docker/server` entry exports:

- `createServer`: HTTP server with `runtime`, `url`, `port`, `host`, `server`, `close`.
- `DEFAULT_PORT`: CLI default port, 8826 (programmatic default is ephemeral).
- `serveTarget`: shared CLI server configuration.

Type exports include `DockerAPIOptions`, `DockerRuntime`, `DockerRuntimeOptions`,
`OperationId`, `SupportedOperationId`, and the Node entry's `DockerServer` and
`DockerServerOptions`. The executable `mockingbird-docker` provides `serve`.

## Deliberately not modelled

Attach and unsupported options return Mockingbird-specific 501 JSON errors;
unknown routes return 404. No real containers are started. UNIX
sockets, HTTP upgrade, duplex attach, orchestration and real
Engine parity are deferred. Attach is classified as requiring protocol-specific
Node verification; a Fetch response cannot represent its bidirectional upgrade.
No successful attach behavior or real-provider parity is claimed by these tests.
