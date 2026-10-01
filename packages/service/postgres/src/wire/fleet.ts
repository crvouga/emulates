import type { ConfigService, FleetChild } from "@crvouga/mockingbird-adapter-node";
import { createClock, type Clock } from "@crvouga/mockingbird-service";
import { Database } from "../api/database.ts";
import type { Snapshot } from "../api/snapshot.ts";
import type { ServerFaults } from "./connection.ts";
import { probe } from "./probe.ts";
import { serve, type PostgresServer } from "./index.ts";

/** Separate database listeners make the protocol namespace explicit in discovery. */
export async function startProtocol(entry: ConfigService): Promise<FleetChild> {
  const namespaces = new Map<string, { server: PostgresServer; clock: Clock }>();
  const selectors = { default: entry.database ?? "postgres", ...entry.namespaces };
  try {
    for (const [name, databaseName] of Object.entries(selectors)) {
      if (!/^[A-Za-z0-9_.-]{1,64}$/.test(name) || typeof databaseName !== "string")
        throw new Error("invalid Postgres namespace/database name");
      const clock = createClock();
      const database = new Database({
        now: () => new Date(clock.now()),
        ...(entry.seed !== undefined ? { seed: Number(entry.seed) } : {}),
      });
      const server = await serve({
        database,
        databaseName,
        allowDatabaseSelection: true,
        host: entry.host ?? "127.0.0.1",
        port: name === "default" ? (entry.port ?? 0) : 0,
        ...(entry.password !== undefined ? { password: entry.password } : {}),
        ...(entry.user !== undefined ? { user: entry.user } : {}),
      });
      namespaces.set(name, { server, clock });
    }
  } catch (error) {
    await Promise.allSettled([...namespaces.values()].map(({ server }) => server.close()));
    throw error;
  }
  const get = (name: string) => {
    const found = namespaces.get(name);
    if (!found) throw new Error(`Postgres namespace ${name} is not configured`);
    return found;
  };
  const publicUrl = (name: string) => {
    const url = new URL(get(name).server.connectionString);
    url.password = "";
    return url.href;
  };
  const locked = new Set<string>();
  const snapshots = new WeakMap<
    object,
    { namespace: string; databases: Map<string, Snapshot>; clock: ReturnType<Clock["state"]>; faults: ServerFaults }
  >();
  const origins = new Map([...namespaces].map(([name, { server }]) => [name, server.snapshotAll()]));
  return {
    protocol: "postgres",
    url: publicUrl("default"),
    connection: get("default").server.connectionString,
    connections: Object.fromEntries([...namespaces].map(([name, { server }]) => [name, server.connectionString])),
    namespaces: {
      mechanism: "endpoint",
      endpoints: Object.fromEntries([...namespaces.keys()].map((name) => [name, publicUrl(name)])),
    },
    async ready() {
      const results = await Promise.all(
        [...namespaces.values()].map(({ server }) =>
          server.server.listening ? probe(server.connectionString) : false,
        ),
      );
      return results.every(Boolean);
    },
    async close() {
      await Promise.all(
        [...namespaces.values()].map(async ({ server }) => {
          await server.close();
          for (const name of server.databaseNames()) server.getDatabase(name).close();
        }),
      );
    },
    lock(namespace) {
      const { server } = get(namespace);
      if (locked.has(namespace)) throw new Error("Postgres namespace already locked");
      locked.add(namespace);
      const reject = (socket: import("node:net").Socket) => socket.destroy();
      // Prepend the fence, so the protocol handler never receives a live new socket.
      server.server.prependListener("connection", reject);
      return () => {
        locked.delete(namespace);
        server.server.off("connection", reject);
      };
    },
    diagnostics(namespace) {
      const { server } = get(namespace);
      // Even an idle client may retain prepared statements or a transaction workspace.
      return {
        activeRequests: server.connections,
        activeConnections: server.connections,
        blockedCommands: 0,
        pendingJobs: 0,
        pendingWebhooks: 0,
        unmatchedRequests: 0,
      };
    },
    async checkpoint(namespace) {
      const { server, clock } = get(namespace);
      const handle = {};
      snapshots.set(handle, {
        namespace,
        databases: server.snapshotAll(),
        clock: clock.state(),
        faults: server.faultState(),
      });
      return handle;
    },
    async restore(namespace, handle) {
      const point = typeof handle === "object" && handle !== null ? snapshots.get(handle) : undefined;
      if (!point || point.namespace !== namespace) throw new Error("invalid Postgres checkpoint");
      const { server, clock } = get(namespace);
      server.restoreAll(point.databases);
      for (const name of server.databaseNames()) server.getDatabase(name).now = () => new Date(clock.now());
      server.clearFaults();
      server.fault(point.faults);
      clock.freeze();
      clock.set(point.clock.now);
      if (!point.clock.frozen) clock.unfreeze();
    },
    async reset(namespace) {
      const { server, clock } = get(namespace);
      server.restoreAll(origins.get(namespace) as Map<string, Snapshot>);
      for (const name of server.databaseNames()) server.getDatabase(name).now = () => new Date(clock.now());
      server.clearFaults();
      clock.reset();
    },
    clock: (namespace) => get(namespace).clock,
  };
}
