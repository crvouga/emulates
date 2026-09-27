# @crvouga/mockingbird-service-docker

Work-in-progress Docker Engine API 1.52 mock. It implements GET/HEAD `/_ping`,
GET `/version`, `/info`, `/containers/json`, and `/containers/{id}/json`, plus
Mockingbird's shared runtime controls. Container lifecycle and attached streams
are not implemented yet. The contract is
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

- `DockerAPI`: provider Fetch handler with `fetch` and `reset`.
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

Known unimplemented lifecycle and attach routes return Mockingbird-specific 501
JSON errors; unknown routes return 404. No real containers are started. UNIX
sockets, HTTP upgrade, duplex attach, orchestration and real
Engine parity are deferred. Attach is classified as requiring protocol-specific
Node verification; a Fetch response cannot represent its bidirectional upgrade.
No successful attach behavior or real-provider parity is claimed by these tests.
