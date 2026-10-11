# @crvouga/mockingbird-mqtt-broker

> **Internal package — not published to npm.** Mockingbird publishes only its emulator services (`@crvouga/mockingbird-service-*`), which bundle this code. It is documented here for contributors to this repo.

The MQTT 5 broker that Mockingbird's MQTT emulators share
([`emqx`](../../service/emqx), [`aws-iot`](../../service/aws-iot)): the packet codec, sessions,
subscriptions, QoS 1 flows, offline queues, session expiry on an injected clock, client-id
takeover, and the TCP and WebSocket transports. A service supplies what its vendor decides
differently as a `BrokerPolicy` and adds its HTTP API beside it.

Follows the [MQTT 5.0 specification](https://docs.oasis-open.org/mqtt/mqtt/v5.0/os/mqtt-v5.0-os.html);
section numbers in the source comments are that document's.

## Install

Workspace only: add `"@crvouga/mockingbird-mqtt-broker": "workspace:*"` to a service's
`devDependencies`; `scripts/bundle-service.ts` inlines it into the service's `dist`.

The default entry is portable (Node >= 22, Bun >= 1.2, browsers, workers). `./node` needs
`node:net`, `node:http` and `node:stream`.

## Usage

```ts
import { Broker, type BrokerPolicy, ReasonCode } from "@crvouga/mockingbird-mqtt-broker"
import { listenTcp } from "@crvouga/mockingbird-mqtt-broker/node"
import { bootSqlite } from "@crvouga/mockingbird-service"

const policy: BrokerPolicy = {
  authenticate: ({ username }) =>
    username === "service" ? { ok: true } : { ok: false, reasonCode: ReasonCode.NotAuthorized },
  authorize: () => true,
  denyAction: () => "ignore",
  assignClientId: (token) => token,
  sessionExpiry: (requested) => requested,
  connackProperties: () => ({ receiveMaximum: 32 }),
  maxInflight: 32,
  queue: { storeQos0: false },
  pubackNoMatchingSubscribers: ReasonCode.Success,
  qos2Subscribe: "downgrade",
  multiLevelWildcardMatchesParent: true,
  connectionExpiredReason: ReasonCode.NotAuthorized,
}
const broker = new Broker({ sqlite: bootSqlite(), namespace: "demo", now: Date.now, policy })
const tcp = await listenTcp((transport, info) => broker.connect(transport, info))

broker.publish({ topic: "a/b", payload: new TextEncoder().encode("hi"), qos: 1 })
await tcp.close()
```

## How it is built

- **No timers.** Time is `now()`. Everything it decides (session expiry, a credential's expiry)
  is settled by `broker.sweep()`, which every entry point runs first. A runtime wraps its clock
  with `observeClock` so a suite that moves time sees the effect at once; a served process also
  sweeps on an interval (`serveMqtt`).
- **State in `Collection`s.** Sessions, subscriptions, queued and in-flight messages, transport
  cuts and the publish log are records, so reset and Timeline checkpoints cover them. Only live
  connections are in memory; `dropConnections()` discards them before a restore.
- **Transport-free engine.** Bytes arrive through `Connection.receive` and leave through a
  `Transport` (`send`, `close`, `destroy`). `./node` provides TCP, WebSocket and an in-memory
  stream; `routeConnection` holds a transport until its CONNECT names a tenant.
- **Payloads are not logged.** The publish log keeps topic, QoS, size and source.

What the broker itself does not do, and says so in its CONNACK: QoS 2 (Maximum QoS 1), retained
messages (Retain Available 0), shared subscriptions (Shared Subscription Available 0). It also
has no Will messages, enhanced authentication, keep-alive timeouts, message expiry or outbound
topic aliases, and refuses MQTT 3.1 / 3.1.1 with that protocol's own CONNACK.

## API

| Export | Kind | Description |
| --- | --- | --- |
| `Broker` | class | `connect(transport, info?)`, `publish(input, source?)`, `kick`, `disconnect`, `cutTransport` / `restoreTransport` / `transportCuts`, `clients`, `subscriptionList`, `publishLog` / `publishCount`, `sweep`, `dropConnections`. |
| `routeConnection` | function | Attach a transport to the broker its CONNECT selects. |
| `encodePacket`, `decodePacket`, `PacketReader`, `MqttProtocolError` | codec | MQTT 5 control packets, both directions, and stream reassembly. |
| `LEGACY_UNSUPPORTED_VERSION_CONNACK`, `MAX_VARIABLE_BYTE_INTEGER` | values | The MQTT 3.1.1 refusal; the largest Remaining Length. |
| `ReasonCode` | object | MQTT 5 reason codes by name. |
| `topicMatches`, `isValidTopicName`, `isValidTopicFilter`, `isSharedSubscription`, `utf8Length` | functions | Topic names and filters (section 4.7). |
| `SESSION_NEVER_EXPIRES`, `PUBLISH_LOG_SIZE` | numbers | `0xFFFFFFFF`; 1000. |
| `brokerAdminRoutes`, `observeClock`, `connackPreset`, `takeConnackFault`, `connectNamespace`, `webSocketNamespace`, `MQTT_CONNECT_OPERATION`, `MQTT_WEBSOCKET_PATH` | runtime | What every MQTT service runtime wires around its brokers: admin routes, the observed clock, CONNECT faults, namespace selection. |
| `listenTcp`, `attachWebSocket`, `memoryStream`, `serveMqtt` (`./node`) | Node | The TCP listener, MQTT over WebSocket on a `node:http` server, an in-process stream, and all of them bound to a service runtime. |
