import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";

// Durable mode across real process deaths: the server runs in a child process on the file-backed
// store, is killed with SIGKILL (no shutdown handler runs), and a new process opens the same root.

const packageRoot = join(import.meta.dir, "..", "..");
const cli = join(packageRoot, "src", "wire", "cli.ts");
const fixture = join(import.meta.dir, "fixtures", "durable-server.ts");
const TIMEOUT = 120_000;

type Child = {
  url: string;
  /** Resolves once the child printed `marker`. */
  printed(marker: string): Promise<void>;
  /** SIGKILL, and wait until the process is gone. */
  kill(): Promise<void>;
};

const children: Child[] = [];
const clients: pg.Client[] = [];
const roots: string[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.end().catch(() => undefined);
  for (const child of children.splice(0)) await child.kill();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const newRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "mockingbird-postgres-kill-"));
  roots.push(root);
  return root;
};

const spawn = async (args: string[]): Promise<Child> => {
  const process = Bun.spawn(["bun", ...args], { cwd: packageRoot, stdout: "pipe", stderr: "inherit" });
  let output = "";
  let ended = false;
  let wake: (() => void)[] = [];
  void (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of process.stdout) {
      output += decoder.decode(chunk, { stream: true });
      for (const resolve of wake.splice(0)) resolve();
    }
    ended = true;
    for (const resolve of wake.splice(0)) resolve();
  })();
  const match = async (pattern: RegExp): Promise<RegExpExecArray> => {
    for (;;) {
      const found = pattern.exec(output);
      if (found) return found;
      if (ended) throw new Error(`the server process ended; it printed: ${output}`);
      await new Promise<void>((resolve) => {
        wake = [...wake, resolve];
      });
    }
  };
  const child: Child = {
    url: "",
    printed: async (marker) => {
      await match(new RegExp(marker));
    },
    kill: async () => {
      process.kill("SIGKILL");
      await process.exited;
    },
  };
  children.push(child);
  child.url = (await match(/listening on (postgres:\/\/\S+)/))[1] as string;
  return child;
};

/** The real CLI on the file-backed store. */
const serveCli = (root: string): Promise<Child> => spawn([cli, "serve", "--port", "0", "--durable", root]);

const connect = async (child: Child, database = "postgres"): Promise<pg.Client> => {
  const url = new URL(child.url);
  url.pathname = `/${database}`;
  const client = new pg.Client({ connectionString: url.toString() });
  // A killed server ends the socket; the query in flight rejects, and nothing else should throw.
  client.on("error", () => undefined);
  await client.connect();
  clients.push(client);
  return client;
};

describe("SIGKILL", () => {
  test(
    "acknowledged autocommit writes and COMMITs are there after a restart",
    async () => {
      const root = await newRoot();
      const first = await serveCli(root);
      const client = await connect(first);
      await client.query("CREATE TABLE ledger (id serial PRIMARY KEY, note text)");
      await client.query("INSERT INTO ledger (note) VALUES ('autocommit')");
      await client.query("BEGIN");
      await client.query("INSERT INTO ledger (note) VALUES ('committed block')");
      await client.query("COMMIT");
      await client.query("CREATE DATABASE app");
      const app = await connect(first, "app");
      await app.query("CREATE TABLE settings (name text PRIMARY KEY); INSERT INTO settings VALUES ('theme')");
      await first.kill();

      const second = await serveCli(root);
      const again = await connect(second);
      expect((await again.query("SELECT id, note FROM ledger ORDER BY id")).rows).toEqual([
        { id: 1, note: "autocommit" },
        { id: 2, note: "committed block" },
      ]);
      // The sequence resumes after the last committed value.
      expect((await again.query("INSERT INTO ledger (note) VALUES ('after restart') RETURNING id")).rows).toEqual([
        { id: 3 },
      ]);
      const restored = await connect(second, "app");
      expect((await restored.query("SELECT name FROM settings")).rows).toEqual([{ name: "theme" }]);
    },
    TIMEOUT,
  );

  test(
    "an uncommitted transaction and a rolled-back one are not",
    async () => {
      const root = await newRoot();
      const first = await serveCli(root);
      const client = await connect(first);
      await client.query("CREATE TABLE ledger (note text)");
      await client.query("INSERT INTO ledger VALUES ('committed')");
      await client.query("BEGIN");
      await client.query("INSERT INTO ledger VALUES ('rolled back')");
      await client.query("ROLLBACK");
      await client.query("BEGIN");
      await client.query("INSERT INTO ledger VALUES ('never committed')");
      expect((await client.query("SELECT count(*)::int AS n FROM ledger")).rows).toEqual([{ n: 2 }]);
      await first.kill();

      const second = await serveCli(root);
      const again = await connect(second);
      expect((await again.query("SELECT note FROM ledger")).rows).toEqual([{ note: "committed" }]);
    },
    TIMEOUT,
  );

  test(
    "a commit persisted but not yet acknowledged is there after a restart",
    async () => {
      const root = await newRoot();
      const first = await spawn([fixture, root, "pause-before-ack"]);
      const client = await connect(first);
      await client.query("CREATE TABLE ledger (note text)");
      const outcome = client.query("INSERT INTO ledger VALUES ('marked')").then(
        () => "acknowledged",
        () => "connection lost",
      );
      await first.printed("PAUSED before the acknowledgement");
      await first.kill();
      expect(await outcome).toBe("connection lost");

      const second = await serveCli(root);
      const again = await connect(second);
      expect((await again.query("SELECT note FROM ledger")).rows).toEqual([{ note: "marked" }]);
    },
    TIMEOUT,
  );

  test(
    "a commit that never reached storage is not acknowledged and not there",
    async () => {
      const root = await newRoot();
      // Write 1 initialises the root, write 2 is CREATE TABLE, write 3 would be the INSERT.
      const first = await spawn([fixture, root, "hang-write:3"]);
      const client = await connect(first);
      await client.query("CREATE TABLE ledger (note text)");
      const outcome = client.query("INSERT INTO ledger VALUES ('lost')").then(
        () => "acknowledged",
        () => "connection lost",
      );
      await first.printed("HUNG before the storage write");
      await first.kill();
      expect(await outcome).toBe("connection lost");

      const second = await serveCli(root);
      const again = await connect(second);
      expect((await again.query("SELECT count(*)::int AS n FROM ledger")).rows).toEqual([{ n: 0 }]);
    },
    TIMEOUT,
  );
});
