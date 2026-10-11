/**
 * A durable wire server in its own process, for tests that SIGKILL it at a chosen point of a
 * commit. Usage: `bun durable-server.ts <root> [pause-before-ack | hang-write:<n>]`.
 */
import { type DurableOptions, type DurableStorage, fileStorage, serve } from "../../../src/wire/index.ts";

const [root, mode = "run"] = process.argv.slice(2);
if (root === undefined) throw new Error("usage: durable-server.ts <root> [mode]");

const never = new Promise<void>(() => undefined);
const files = fileStorage(root);
const hangAt = mode.startsWith("hang-write:") ? Number(mode.slice("hang-write:".length)) : 0;
let writes = 0;

/** The n-th write never reaches the filesystem, as if the process died on the way to it. */
const storage: DurableStorage = {
  read: () => files.read(),
  write: (image) => {
    if (++writes !== hangAt) return files.write(image);
    console.log("HUNG before the storage write");
    return never;
  },
};

const durable: DurableOptions = {
  storage,
  ...(mode === "pause-before-ack"
    ? {
        beforeAcknowledge: (commit) => {
          if (!commit.sql.includes("'marked'")) return;
          console.log("PAUSED before the acknowledgement");
          return never;
        },
      }
    : {}),
};

const server = await serve({ port: 0, durable });
console.log(`listening on ${server.connectionString}`);
