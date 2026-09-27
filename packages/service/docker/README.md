# @crvouga/mockingbird-service-docker

Work-in-progress Docker Engine API 1.52 mock. This scaffold implements GET/HEAD
`/_ping` and Mockingbird's shared runtime controls. Container lifecycle, inspection,
version negotiation and attached streams are not implemented yet. The contract is
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
can select `tcp://127.0.0.1:8826`, but full client compatibility is pending: automatic
negotiation and version-prefixed routes are not available in this scaffold.

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
sockets, HTTP upgrade, duplex attach, daemon discovery, orchestration and real
Engine parity are deferred. Attach is classified as requiring protocol-specific
Node verification; a Fetch response cannot represent its bidirectional upgrade.
No successful attach behavior or real-provider parity is claimed by these tests.
