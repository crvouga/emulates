# @crvouga/mockingbird-service-redis

> Familiar calls. Faithful echoes. Part of [Mockingbird](https://github.com/crvouga/mockingbird).

In-process Redis for tests. `createRedis()` is a pure TypeScript RESP store: call commands on
`redis.client()`, or speak RESP to the TCP server (`mockingbird-redis`, or `serve` from
`@crvouga/mockingbird-service-redis/server`). It is not an HTTP mock and has no `createRuntime`.

Replies follow the Redis command reference for a single standalone node and were spot-checked
against Redis 8.4.0. The advertised version is Redis 7.2.4 so clients do not probe Redis 8 modules.
This package is a work in progress.

## Install

```bash
npm install -D @crvouga/mockingbird-service-redis
```

## Usage

```ts
import { createRedis, manualClock } from "@crvouga/mockingbird-service-redis"

const clock = manualClock(1_700_000_000_000)
const redis = createRedis({ clock })
const client = redis.client()
const set = await client.call("SET", "lock", "token", "PX", 1000)
console.log(set)
redis.advance(1000)
```

Two `createRedis()` instances never share keys. `SELECT` isolates logical databases 0–15 inside
one instance. `redis.advance(ms)` moves an injected clock. `redis.inspect()`, `redis.fault()`,
`redis.pauseConsumers()`, `redis.reset()`, and `redis.waiterCount()` are the test controls.

`ioredis` can connect to the TCP server unchanged. Cluster `MOVED` / `ASK` is not implemented:
`CLUSTER` and `READONLY` answer that cluster support is disabled.

## API

- `createRedis(options?)` returns a `Redis` instance.
- `Redis` holds the store, the clock, and the test controls (`client`, `advance`, `fault`, `inspect`, `pauseConsumers`, `reset`, `waiterCount`, `close`).
- `RedisClient` is one connection: `call`, `raw`, `pipeline`, `quit`, `onPush`, and `protocol`.
- `RedisPipeline` queues `call`s and runs them in `exec`.
- `RedisConnectionError` is a dropped connection, a timeout fault, or a closed server.
- `RedisReplyError` is a Redis error reply raised by `call`.
- `manualClock(start)` moves only when `advance` is called. `wallClock` follows `Date.now()`.
- `encodeReply(reply, protocol)` writes a RESP2 or RESP3 frame.

## Deliberately not modelled

- Cluster redirects (`MOVED`, `ASK`) and replica replication. `ROLE` stays `master`.
- Redis 8 modules, and the full Redis command set.
- Full Lua 5.1, `cmsgpack`, and BullMQ beyond the script subset (`cjson`, `redis.call` / `pcall`).
- `XADD` / `XTRIM` `MAXLEN ~` trims exactly.
- Set members are returned in byte order so results stay deterministic.
