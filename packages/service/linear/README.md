# @crvouga/mockingbird-service-linear

> Local emulators. Real API contracts. Part of [Mockingbird](https://github.com/crvouga/mockingbird).

GraphQL, OAuth, issues, teams, users, workflow states, comments, labels, projects, cycles, webhooks, agents, inspector. Runs through Mockingbird's portable Fetch runtime with SQLite persistence, namespaces, checkpoints, faults and admin controls.

## Install

```sh
npm install @crvouga/mockingbird-service-linear
```

## Usage

```ts
import { createRuntime } from "@crvouga/mockingbird-service-linear"
const runtime = createRuntime({ seed: 1 })
const response = await runtime.fetch(new Request("https://api.linear.app"))
```

## API

- `LinearAPI`: portable provider instance; accepts SQLite, namespace, clock, fixtures and baseUrl.
- `createRuntime`: shared runtime, including native namespace and checkpoint controls.
- `LINEAR_NAMESPACE`: default storage namespace.
- `document`, `operationIds`, `supportedOperationIds`: registered provider route inventory.
- `createServer`, `DEFAULT_PORT`, `serveTarget` from `/server`: loopback listener and CLI configuration.

`fixtures` accepts synthetic provider seed records. `reset()` restores defaults. Emulate 0.12.1 is a test oracle only, never a runtime dependency. Vendor handlers ported under Apache-2.0 retain their license and attribution; see LICENSE_EMULATE and THIRD_PARTY_NOTICES.md.

See [SUPPORT.md](SUPPORT.md) for coverage and limits and [API_EVIDENCE.md](API_EVIDENCE.md) for validation status.
