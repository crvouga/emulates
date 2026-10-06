/**
 * A small TCP server in front of the in-memory SQLite engine.
 *
 * SQLite has no client/server wire protocol, so the stock `sqlite3` CLI cannot
 * attach. This entry speaks a length-prefixed JSON frame (`uint32` big-endian
 * length, then UTF-8 JSON, at most 8 MiB) and ships an in-package `connect(uri)`
 * client. URIs look like `sqlite://127.0.0.1:5432/app`. It needs `node:net`, so
 * it stays out of the browser build. Portable queries go through `POST /sql/query`
 * on the admin API.
 *
 * @example
 * ```ts
 * import { connect, serve } from "@emulates/sqlite/socket";
 *
 * const server = await serve("sqlite://127.0.0.1:0/app");
 * const db = await connect(server.url);
 * await db.exec("CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT)");
 * await db.close();
 * await server.close();
 * ```
 *
 * @module
 */
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { Database, type DatabaseOptions } from "../api/database.ts";
import type { BindValue } from "../types/value.ts";

const MAX_FRAME = 8 * 1024 * 1024;
const READ_SQL = /^(?:select|with|values|pragma|explain)\b/i;

export type SocketServeOptions = {
  /** TCP port. `0` (the default) picks a free one. */
  port?: number;
  /** Interface to bind. Default `127.0.0.1`. */
  host?: string;
  /** Engine to share. Omit for a fresh deterministic database. */
  database?: Database;
  databaseOptions?: DatabaseOptions;
  /** When set, a frame naming another database is rejected. */
  databaseName?: string;
  /** `sqlite://host:port/name`. An omitted port means `0` (ephemeral) for the server. */
  url?: string;
};

export type SqliteServer = {
  readonly port: number;
  readonly host: string;
  /** Bound `sqlite://` URI. */
  readonly url: string;
  readonly database: Database;
  readonly server: Server;
  close(): Promise<void>;
};

export type SqliteSocket = {
  query<T = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<T[]>;
  exec(sql: string): Promise<{ changes: number }>;
  close(): Promise<void>;
};

type SqliteUri = { host: string; port: number; databaseName?: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const jsonSafe = (value: unknown): unknown => {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Uint8Array) {
    let binary = "";
    for (const byte of value) binary += String.fromCharCode(byte);
    return btoa(binary);
  }
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((item) => jsonSafe(item));
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) out[key] = jsonSafe(item);
    return out;
  }
  return value;
};

const parseSqliteUri = (raw: string): SqliteUri => {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`invalid sqlite URI: ${raw}`);
  }
  if (url.protocol !== "sqlite:") throw new Error(`unsupported sqlite URI protocol ${url.protocol}`);
  const databaseName = decodeURIComponent(url.pathname.replace(/^\//, ""));
  const port = url.port === "" ? 0 : Number(url.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`invalid sqlite URI port: ${url.port}`);
  return {
    host: url.hostname || "127.0.0.1",
    port,
    ...(databaseName !== "" ? { databaseName } : {}),
  };
};

const normalize = (input: SocketServeOptions | string): SocketServeOptions => {
  if (typeof input === "string") return parseSqliteUri(input);
  if (input.url === undefined) return input;
  const parsed = parseSqliteUri(input.url);
  return {
    ...parsed,
    ...input,
    host: input.host ?? parsed.host,
    port: input.port ?? parsed.port,
    databaseName: input.databaseName ?? parsed.databaseName,
  };
};

const encode = (value: unknown): Buffer => {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  if (body.length > MAX_FRAME) throw new Error("frame exceeds 8 MiB");
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length, 0);
  return Buffer.concat([header, body]);
};

class FrameReader {
  private buffer = Buffer.alloc(0);

  push(chunk: Uint8Array): unknown[] {
    const incoming = Buffer.from(chunk);
    this.buffer = this.buffer.length === 0 ? incoming : Buffer.concat([this.buffer, incoming]);
    const frames: unknown[] = [];
    for (;;) {
      if (this.buffer.length < 4) break;
      const length = this.buffer.readUInt32BE(0);
      if (length > MAX_FRAME) throw new Error("frame exceeds 8 MiB");
      if (this.buffer.length < 4 + length) break;
      const body = this.buffer.subarray(4, 4 + length);
      this.buffer = this.buffer.subarray(4 + length);
      frames.push(JSON.parse(body.toString("utf8")) as unknown);
    }
    return frames;
  }
}

const run = (db: Database, message: unknown, databaseName: string | undefined): unknown => {
  if (!isRecord(message) || typeof message.sql !== "string" || message.sql.trim() === "") {
    return { ok: false, error: 'expected {"sql":"..."}' };
  }
  if (databaseName !== undefined && typeof message.database === "string" && message.database !== databaseName) {
    return { ok: false, error: `database "${message.database}" does not exist` };
  }
  const params = Array.isArray(message.params) ? message.params : [];
  const read = READ_SQL.test(message.sql.trim());
  const mode = message.mode === "exec" || message.mode === "query" ? message.mode : read ? "query" : "exec";
  try {
    if (mode === "exec") {
      db.exec(message.sql);
      if (!db.transactions.inTransaction) db.record();
      return { ok: true, columns: [], rows: [], changes: db.changes };
    }
    const rows = db.query<Record<string, unknown>>(message.sql, params as BindValue[]);
    if (!db.transactions.inTransaction) db.record();
    const truncated = rows.length > 500;
    const sliced = truncated ? rows.slice(0, 500) : rows;
    return {
      ok: true,
      columns: sliced[0] ? Object.keys(sliced[0]) : [],
      rows: sliced.map((row) => jsonSafe(row)),
      changes: db.changes,
      ...(truncated ? { truncated: true } : {}),
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
};

/** Start a server and resolve once it is listening. A string argument is a `sqlite://` URI. */
export const serve = (input: SocketServeOptions | string = {}): Promise<SqliteServer> => {
  const options = normalize(input);
  const database = options.database ?? new Database(options.databaseOptions ?? {});
  const host = options.host ?? "127.0.0.1";
  const server = createServer((socket: Socket) => {
    socket.setNoDelay(true);
    const reader = new FrameReader();
    socket.on("data", (chunk: Buffer) => {
      try {
        for (const frame of reader.push(chunk)) socket.write(encode(run(database, frame, options.databaseName)));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        socket.end(encode({ ok: false, error: message }));
      }
    });
    socket.on("error", () => socket.destroy());
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, host, () => {
      server.removeListener("error", reject);
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      const name = options.databaseName ?? "main";
      resolve({
        port,
        host,
        url: `sqlite://${host}:${port}/${encodeURIComponent(name)}`,
        database,
        server,
        close: () =>
          new Promise<void>((done, fail) => {
            server.close((error?: Error | null) => (error ? fail(error) : done()));
          }),
      });
    });
  });
};

const clientFrom = (socket: Socket, database: string | undefined): SqliteSocket => {
  const reader = new FrameReader();
  const pending: { resolve: (value: unknown) => void; reject: (error: Error) => void }[] = [];
  const failAll = (error: Error): void => {
    for (const wait of pending) wait.reject(error);
    pending.length = 0;
  };
  socket.on("data", (chunk: Buffer) => {
    let frames: unknown[];
    try {
      frames = reader.push(chunk);
    } catch (error) {
      failAll(error instanceof Error ? error : new Error(String(error)));
      socket.destroy();
      return;
    }
    for (const frame of frames) {
      const wait = pending.shift();
      if (!wait) continue;
      if (isRecord(frame) && frame.ok === true) wait.resolve(frame);
      else if (isRecord(frame) && typeof frame.error === "string") wait.reject(new Error(frame.error));
      else wait.reject(new Error("malformed sqlite response"));
    }
  });
  socket.on("error", failAll);
  socket.on("close", () => failAll(new Error("sqlite connection closed")));
  const request = (body: Record<string, unknown>): Promise<Record<string, unknown>> =>
    new Promise((resolve, reject) => {
      pending.push({
        resolve: (value) => {
          if (isRecord(value)) resolve(value);
          else reject(new Error("malformed sqlite response"));
        },
        reject,
      });
      socket.write(encode({ ...body, ...(database !== undefined ? { database } : {}) }));
    });
  return {
    async query<T = Record<string, unknown>>(sql: string, params: readonly unknown[] = []) {
      const frame = await request({ sql, params, mode: "query" });
      const rows = Array.isArray(frame.rows) ? frame.rows : [];
      return rows as T[];
    },
    async exec(sql) {
      const frame = await request({ sql, mode: "exec" });
      return { changes: typeof frame.changes === "number" ? frame.changes : 0 };
    },
    close() {
      return new Promise((resolve) => {
        socket.removeAllListeners("close");
        socket.end(() => resolve());
      });
    },
  };
};

/** Open a client for a `sqlite://host:port/name` URI. The port must already be listening. */
export const connect = (uri: string): Promise<SqliteSocket> => {
  const parsed = parseSqliteUri(uri);
  if (parsed.port <= 0) return Promise.reject(new Error("sqlite URI needs a port"));
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: parsed.host, port: parsed.port }, () => {
      socket.removeListener("error", reject);
      resolve(clientFrom(socket, parsed.databaseName));
    });
    socket.once("error", reject);
  });
};
