#!/usr/bin/env node
/**
 * `emulates-sqlite serve`: start the length-prefixed JSON socket (see ./index.ts).
 *
 *   emulates-sqlite serve
 *   emulates-sqlite serve sqlite://127.0.0.1:0/app
 *
 * The stock `sqlite3` CLI cannot attach to this socket. Use `connect()` from
 * `@emulates/sqlite/socket`.
 */
import { type SocketServeOptions, serve } from "./index.ts";

const usage = `emulates-sqlite serve [sqlite://URI] [--port <n>] [--host <h>]

The stock sqlite3 CLI cannot attach. Use connect() from @emulates/sqlite/socket.`;

const args = process.argv.slice(2);
if (args[0] !== "serve") {
  console.error(usage);
  process.exit(args[0] === "--help" || args[0] === "-h" ? 0 : 2);
}

const options: SocketServeOptions = {};
for (let i = 1; i < args.length; i++) {
  const flag = args[i];
  if (flag?.startsWith("sqlite://")) {
    options.url = flag;
    continue;
  }
  const value = args[i + 1];
  const need = (): string => {
    if (value === undefined) {
      console.error(`${flag} requires a value`);
      process.exit(2);
    }
    i++;
    return value;
  };
  switch (flag) {
    case "--port":
      options.port = Number(need());
      break;
    case "--host":
      options.host = need();
      break;
    default:
      console.error(`unknown option ${flag}\n${usage}`);
      process.exit(2);
  }
}

const server = await serve(options);
console.log(`emulates-sqlite listening on ${server.url}`);
console.error("sqlite3 cannot attach to this socket; use @emulates/sqlite/socket connect()");

const stop = async () => {
  await server.close();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
