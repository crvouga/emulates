/**
 * A PostgreSQL wire-protocol (frontend/backend 3.0) TCP server in front of the in-memory
 * engine, so a separate process can use it through a normal `postgres://` connection string:
 * `pg`, `postgres.js`, a JDBC client, `psql`. It runs in Node and Bun (it needs `node:net`),
 * not the browser.
 *
 * One {@link Database} is shared by every connection through a {@link Cluster}: the engine
 * runs one statement at a time, so a connection inside an explicit `BEGIN` block holds the
 * engine until it commits or rolls back and the others queue, which keeps read-committed
 * visibility (uncommitted rows never reach another connection) at the cost of serializing
 * transaction blocks. Advisory locks, `LISTEN`/`NOTIFY`, `CancelRequest` and per-connection
 * aborted-transaction state (`25P02`) are coordinated across connections.
 *
 * @example
 * ```ts
 * import { serve } from "@crvouga/mockingbird-service-postgres/wire";
 *
 * const server = await serve({ port: 0 });
 * // new pg.Pool({ connectionString: `postgres://postgres@127.0.0.1:${server.port}/db` })
 * await server.close();
 * ```
 *
 * @module
 */
import { createServer, type Server, type Socket } from "node:net";
import { Database } from "../api/database.ts";
import type { Snapshot } from "../api/snapshot.ts";
import { Cluster } from "./cluster.ts";
import { Connection, type ServerFaults, type ServerLog } from "./connection.ts";

export type ServeOptions = {
  /** TCP port; `0` (the default) picks a free one, reported as `server.port`. */
  port?: number;
  /** Interface to bind; default `127.0.0.1`. */
  host?: string;
  /**
   * The database to serve. Pass a {@link Database} to share an existing one, a {@link Snapshot}
   * to boot every server from one frozen template, or omit it for a fresh deterministic engine.
   */
  database?: Database | Snapshot;
  /** Require SCRAM-SHA-256 with this password; omitted means trust (AuthenticationOk). */
  password?: string;
  /** `server_version` reported at startup and by `SHOW server_version`. Default `18.3`. */
  serverVersion?: string;
  /** Extra `ParameterStatus` values sent at startup (override the defaults). */
  parameters?: Record<string, string>;
  /** Per-statement log sink, for tests and debugging. */
  onLog?: (entry: ServerLog) => void;
  /**
   * `postgres://` or `postgresql://` URL. User, password, host, port, and database name
   * fill the fields above when those fields are omitted. An omitted port means `5432`;
   * pass port `0` in the URL (`postgres://postgres@127.0.0.1:0/app`) for an ephemeral port.
   */
  url?: string;
  /**
   * Database name clients must request in the startup packet. A different name is
   * SQLSTATE `3D000`. Set from `url` when the path is non-empty. Unset accepts any name.
   */
  databaseName?: string;
  /** Role shown in `connectionString`. A URI's username fills this. Default `postgres`. */
  user?: string;
};

export type PostgresServer = {
  /** The bound port. */
  readonly port: number;
  /** The bound host. */
  readonly host: string;
  /** `postgres://` URL for the bound address, including the database name. */
  readonly connectionString: string;
  /** The shared engine, for seeding, snapshotting or asserting from the test process. */
  readonly database: Database;
  /** The underlying `net.Server`. */
  readonly server: Server;
  /** Open connections right now. */
  readonly connections: number;
  /** Arm a fault preset for the next statement / connection (see {@link ServerFaults}). */
  fault(fault: ServerFaults): void;
  /** Freeze the live state (the admin `snapshot()` control). */
  snapshot(): Snapshot;
  /** Stop listening and close every connection. */
  close(): Promise<void>;
};

export type ServeInput = ServeOptions | string;

const parseUri = (raw: string): ServeOptions => {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`invalid postgres URI: ${raw}`);
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new Error(`unsupported postgres URI protocol ${url.protocol}`);
  }
  const databaseName = decodeURIComponent(url.pathname.replace(/^\//, ""));
  const password = url.password === "" ? undefined : decodeURIComponent(url.password);
  const user = decodeURIComponent(url.username || "postgres");
  const port = url.port === "" ? 5432 : Number(url.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`invalid postgres URI port: ${url.port}`);
  return {
    host: url.hostname || "127.0.0.1",
    port,
    user,
    ...(password !== undefined ? { password } : {}),
    ...(databaseName !== "" ? { databaseName } : {}),
  };
};

const normalize = (input: ServeInput): ServeOptions => {
  if (typeof input === "string") return parseUri(input);
  if (input.url === undefined) return input;
  const parsed = parseUri(input.url);
  return {
    ...parsed,
    ...input,
    host: input.host ?? parsed.host,
    port: input.port ?? parsed.port,
    password: input.password ?? parsed.password,
    databaseName: input.databaseName ?? parsed.databaseName,
    user: input.user ?? parsed.user,
    parameters: input.parameters ?? parsed.parameters,
  };
};

const isSnapshot = (value: unknown): value is Snapshot =>
  typeof value === "object" && value !== null && "open" in value && typeof (value as Snapshot).open === "function";

/** Start a server and resolve once it is listening. A string argument is a `postgres://` URI. */
export const serve = (input: ServeInput = {}): Promise<PostgresServer> => {
  const options = normalize(input);
  const database = isSnapshot(options.database) ? options.database.open() : (options.database ?? new Database());
  const cluster = new Cluster(database);
  const faults: ServerFaults = {};
  const connections = new Set<Connection>();
  const host = options.host ?? "127.0.0.1";
  const user = options.user || "postgres";

  const server = createServer((socket: Socket) => {
    socket.setNoDelay(true);
    const connection = new Connection(socket, cluster, {
      ...(options.password !== undefined ? { password: options.password } : {}),
      serverVersion: options.serverVersion ?? "18.3",
      parameters: options.parameters ?? {},
      faults,
      ...(options.databaseName !== undefined ? { database: options.databaseName } : {}),
      ...(options.onLog ? { onLog: options.onLog } : {}),
    });
    connections.add(connection);
    socket.on("close", () => connections.delete(connection));
  });

  return new Promise<PostgresServer>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, host, () => {
      server.removeListener("error", reject);
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      const name = options.databaseName ?? "postgres";
      const auth = options.password
        ? `${encodeURIComponent(user)}:${encodeURIComponent(options.password)}@`
        : `${encodeURIComponent(user)}@`;
      resolve({
        port,
        host,
        connectionString: `postgres://${auth}${host}:${port}/${encodeURIComponent(name)}`,
        database,
        server,
        get connections() {
          return connections.size;
        },
        fault(next) {
          Object.assign(faults, next);
        },
        snapshot() {
          return database.snapshot();
        },
        close() {
          for (const connection of connections) connection.destroy();
          connections.clear();
          return new Promise<void>((done, fail) => {
            server.close((error?: Error | null) => (error ? fail(error) : done()));
          });
        },
      });
    });
  });
};

export { Cluster } from "./cluster.ts";
export type { ServerFaults, ServerLog } from "./connection.ts";
