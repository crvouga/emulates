# Fleets

One service CLI can supervise installed HTTP emulators, PostgreSQL wire servers and Redis RESP
servers. Every listener starts before readiness is published; a boot failure names the service,
closes listeners that already started, and exits nonzero. SIGINT/SIGTERM closes the whole fleet.

```json
{
  "log": "off",
  "control": { "port": 0 },
  "services": {
    "stripe": { "port": 0, "seed": "fixture" },
    "postgres": {
      "protocol": "postgres", "port": 0, "database": "app",
      "namespaces": { "worker-7": "app", "other": "app" }
    },
    "redis": {
      "protocol": "redis", "port": 0,
      "namespaces": { "worker-7": 0, "other": 0 }
    }
  }
}
```

```sh
emulators-stripe serve --config emulators.json --ready-file ready.json --ready-json
```

Set top-level `adminPrefix` (default `/__admin`) to move the aggregate API and all
HTTP children together. A service entry may override `adminPrefix`. CLI
`--admin-prefix` and `EMULATORS_ADMIN_PREFIX` also apply; ready manifests always
report the actual URLs. Aggregate controls are under `<adminPrefix>/fleet`, and
readiness is `<adminPrefix>/health`. Old `/__fleet` and `/health` routes are removed.

HTTP namespace selection uses `x-emulators-namespace` or `/__admin/ns/{name}`. Protocol namespaces
must be declared in the config; each gets its own engine and listener. Use the URL from
`services[name].namespaces.endpoints[namespace]`. This isolates scripts, Pub/Sub, faults and
clocks as well as records. Within one Redis endpoint, `SELECT` retains Redis's logical-database
semantics: keys are partitioned, but scripts, Pub/Sub and time belong to the server.

The aggregate `/__admin/health` endpoint reports `processReady`, `protocolReady` and `status` per child.
If any child stops, it returns 503. The control listener defaults to a loopback ephemeral port.

## Endpoint discovery

`--ready-json` emits one version-1 ready record with `pid`, a unique `id`, `startedAt`, aggregate
`healthUrl`/`adminBase`, and every child's actual protocol URL, health URL, admin URL and namespace
mechanism. The ready file contains the same JSON. It is published by rename after all children
are healthy, and removed on shutdown only if it still belongs to this process. Starting with
an existing ready-file path invalidates the earlier artifact before boot. Give concurrent fleets
different paths.

Public URLs omit passwords. `--connections-file private.json` writes credential-bearing default and namespace
connection URLs to a separate file, atomically and with mode 0600. Keep configuration and this
private payload outside tracked files. PostgreSQL accepts `user`, `password` and `database`;
Redis accepts `password`. Protocol seeds are numeric. An admin key belongs in the config's
`adminKey` field or `EMULATORS_ADMIN_KEY`; it is never part of discovery.

## Fleet controls

Call these paths under the manifest's `adminBase`. Every control request requires
`x-emulators-admin-key` when a fleet admin key is configured.

| Method | Path relative to `adminBase` | Behavior |
| --- | --- | --- |
| POST | `/namespaces/{name}/reset` | Reset records, namespace faults, clock and pending work across children. |
| POST | `/namespaces/{name}/snapshots` | Capture an opaque in-process checkpoint; optional `label` and `services` list. |
| POST | `/namespaces/{name}/snapshots/{id}/restore` | Restore every child captured by that checkpoint, including deterministic random state. |
| GET/POST | `/clock?namespace={name}` | Read or update logical time with `set`, `freeze`, and `advance` (milliseconds or e.g. `"1h"`). |
| GET | `/metrics?namespace={name}` | Per-child unmatched requests, active requests/connections, blocked commands, jobs and webhooks. |
| POST | `/wait-until-idle?namespace={name}` | Return 200 when idle, otherwise 409 with exact per-child diagnostics. |

Reset and clock operations accept an optional `services` list. Fleet mutations fence new work,
checkpoint each child, then apply the operation. A rejection returns the failed service and each
rollback result, including `rolledBack: false` if any rollback failed. Only a completed operation
returns global success. Snapshots belong to one namespace and the current fleet process.

Active HTTP requests, pending webhooks, active BullMQ jobs, blocked Redis commands, or live PostgreSQL sessions
cause a precise 409 conflict. Close workers and PostgreSQL pools before checkpointing/resetting;
PostgreSQL sessions can retain transactions and prepared statements even when apparently idle.
Queued and delayed Redis jobs are checkpointable state; `/wait-until-idle` still counts them.
HTTP clocks and random streams are independent per namespace in a fleet. Reset/restore of one
namespace leaves the others unchanged.

BullMQ timestamps and worker timers also read the client process's clock. For deterministic
delay/backoff tests, inject the same clock in the client test harness and Redis, then use public
`Worker.getNextJob`/`Job` APIs. Advancing the server clock cannot change `Date.now()` in a separate
consumer process.
