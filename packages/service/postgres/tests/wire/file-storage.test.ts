import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, stat, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { Database, Snapshot } from "../../src/index.ts";
import { type ClusterImage, fileStorage, type PostgresServer, serve } from "../../src/wire/index.ts";

// The file-backed durable storage: layout, atomic replacement, and what a crash can leave behind.

const roots: string[] = [];
const servers: PostgresServer[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close().catch(() => undefined);
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const newRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "mockingbird-postgres-durable-"));
  roots.push(root);
  return root;
};

/** PGMM bytes of a database holding one table with `rows` rows. */
const snapshotBytes = (rows: number): Uint8Array => {
  const db = new Database();
  db.exec("CREATE TABLE t (id int)");
  for (let i = 0; i < rows; i++) db.exec(`INSERT INTO t VALUES (${i})`);
  return db.snapshot().encode();
};

const rowsIn = (bytes: Uint8Array | undefined): number | undefined => {
  if (!bytes) throw new Error("the image has no such database");
  return Snapshot.decode(bytes).open().query<{ n: number }>("SELECT count(*)::int AS n FROM t")[0]?.n;
};

const files = async (root: string): Promise<string[]> => (await readdir(root)).sort();
const snapshots = async (root: string): Promise<string[]> => (await files(root)).filter((n) => n.endsWith(".pgmm"));

describe("layout and replacement", () => {
  test("an empty root reads as nothing and is created on demand", async () => {
    const root = join(await newRoot(), "nested", "cluster");
    expect(await fileStorage(root).read()).toBeNull();
    expect(await files(root)).toEqual([]);
  });

  test("a written image is what the next process reads", async () => {
    const root = await newRoot();
    const image: ClusterImage = new Map([
      ["postgres", snapshotBytes(1)],
      ["app", snapshotBytes(3)],
    ]);
    await fileStorage(root).write(image);

    const read = await fileStorage(root).read();
    expect([...(read?.keys() ?? [])]).toEqual(["postgres", "app"]);
    expect(rowsIn(read?.get("postgres"))).toBe(1);
    expect(rowsIn(read?.get("app"))).toBe(3);
    expect(Buffer.from(read?.get("app") as Uint8Array).equals(Buffer.from(image.get("app") as Uint8Array))).toBe(true);
    // One manifest, one snapshot per database, nothing temporary.
    expect((await files(root)).map((name) => name.replace(/^[0-9a-f]{64}/, "<sha256>")).sort()).toEqual([
      "<sha256>.pgmm",
      "<sha256>.pgmm",
      "MANIFEST.json",
    ]);
  });

  test("a commit rewrites only the database that changed and drops the snapshot it replaced", async () => {
    const root = await newRoot();
    const storage = fileStorage(root);
    const unchanged = snapshotBytes(1);
    await storage.write(
      new Map([
        ["postgres", unchanged],
        ["app", snapshotBytes(2)],
      ]),
    );
    const before = new Map<string, { ino: number; mtimeMs: number }>();
    for (const name of await snapshots(root)) before.set(name, await stat(join(root, name)));

    await storage.write(
      new Map([
        ["postgres", unchanged],
        ["app", snapshotBytes(5)],
      ]),
    );
    const after = await snapshots(root);
    expect(after).toHaveLength(2);
    const kept = after.filter((name) => before.has(name));
    expect(kept).toHaveLength(1);
    const read = await fileStorage(root).read();
    expect(rowsIn(read?.get("postgres"))).toBe(1);
    expect(rowsIn(read?.get("app"))).toBe(5);
    // The kept snapshot is the file it was: same inode, never written again.
    const now = await stat(join(root, kept[0] as string));
    const then = before.get(kept[0] as string);
    expect({ ino: now.ino, mtimeMs: now.mtimeMs }).toEqual({
      ino: then?.ino as number,
      mtimeMs: then?.mtimeMs as number,
    });
  });

  test("dropping a database removes its snapshot", async () => {
    const root = await newRoot();
    const storage = fileStorage(root);
    const postgres = snapshotBytes(1);
    await storage.write(
      new Map([
        ["postgres", postgres],
        ["app", snapshotBytes(2)],
      ]),
    );
    await storage.write(new Map([["postgres", postgres]]));
    expect(await snapshots(root)).toHaveLength(1);
    expect([...((await fileStorage(root).read())?.keys() ?? [])]).toEqual(["postgres"]);
  });

  test("separate roots are isolated", async () => {
    const one = await newRoot();
    const two = await newRoot();
    await fileStorage(one).write(new Map([["postgres", snapshotBytes(1)]]));
    await fileStorage(two).write(new Map([["postgres", snapshotBytes(4)]]));
    expect(rowsIn((await fileStorage(one).read())?.get("postgres"))).toBe(1);
    expect(rowsIn((await fileStorage(two).read())?.get("postgres"))).toBe(4);
  });
});

describe("behavior 3: an interrupted write leaves the previous state or the new one", () => {
  test("a crash before the manifest swap leaves the previous image, and its leftovers are removed", async () => {
    const root = await newRoot();
    await fileStorage(root).write(new Map([["postgres", snapshotBytes(1)]]));
    const committed = await files(root);

    // What a killed write leaves: a half-written temporary snapshot, a complete snapshot the
    // manifest does not name yet, and a temporary manifest that was never renamed into place.
    const next = snapshotBytes(9);
    await writeFile(join(root, `${"a".repeat(64)}.pgmm.4242.0.tmp`), next.subarray(0, next.length >> 1));
    await writeFile(join(root, `${"b".repeat(64)}.pgmm`), next);
    await writeFile(join(root, "MANIFEST.json.4242.1.tmp"), '{"format":"mockingbird-postgres-durable","ver');

    const read = await fileStorage(root).read();
    expect(rowsIn(read?.get("postgres"))).toBe(1);
    expect(await files(root)).toEqual(committed);
  });

  test("a crash before the first manifest leaves an empty storage", async () => {
    const root = await newRoot();
    await writeFile(join(root, `${"c".repeat(64)}.pgmm`), snapshotBytes(2));
    expect(await fileStorage(root).read()).toBeNull();
    expect(await files(root)).toEqual([]);
  });

  test("a failed write keeps the previous image readable", async () => {
    const root = await newRoot();
    const storage = fileStorage(root);
    await storage.write(new Map([["postgres", snapshotBytes(1)]]));
    // The manifest cannot be replaced by a directory of the same temporary shape: rename fails.
    const unwritable = new Map([["postgres", snapshotBytes(2)]]);
    const manifest = join(root, "MANIFEST.json");
    const saved = await readFile(manifest);
    await rm(manifest);
    await Bun.write(join(manifest, "blocker"), "x");
    await expect(storage.write(unwritable)).rejects.toThrow();
    await rm(manifest, { recursive: true });
    await writeFile(manifest, saved);
    expect(rowsIn((await fileStorage(root).read())?.get("postgres"))).toBe(1);
  });

  test("a snapshot that does not match its manifest entry is refused, never decoded", async () => {
    const root = await newRoot();
    await fileStorage(root).write(new Map([["postgres", snapshotBytes(50)]]));
    const [snapshot] = await snapshots(root);
    const path = join(root, snapshot as string);

    await truncate(path, (await stat(path)).size - 7);
    await expect(fileStorage(root).read()).rejects.toThrow(/corrupt.*"postgres" does not match its manifest entry/);
    await expect(serve({ port: 0, durable: root })).rejects.toThrow(/refusing to start/);

    const bytes = await readFile(path);
    bytes[bytes.length >> 1] = (bytes[bytes.length >> 1] as number) ^ 0xff;
    await writeFile(path, Buffer.concat([bytes, Buffer.alloc(7)]));
    await expect(fileStorage(root).read()).rejects.toThrow(/does not match its manifest entry/);

    await rm(path);
    await expect(fileStorage(root).read()).rejects.toThrow(/snapshot of database "postgres" is missing/);
  });

  test("a manifest that is not one is refused", async () => {
    const root = await newRoot();
    const cases: [string, RegExp][] = [
      ["{", /not valid JSON/],
      ['{"format":"something-else","version":1,"databases":[]}', /not a mockingbird-postgres-durable manifest/],
      ['{"format":"mockingbird-postgres-durable","version":2,"databases":[]}', /format version 2/],
      [
        '{"format":"mockingbird-postgres-durable","version":1,"databases":[{"name":"postgres","file":"../x.pgmm","bytes":1}]}',
        /malformed database entry/,
      ],
    ];
    for (const [text, message] of cases) {
      await writeFile(join(root, "MANIFEST.json"), text);
      await expect(fileStorage(root).read()).rejects.toThrow(message);
    }
  });
});

describe("serve({ durable: directory })", () => {
  const connect = async (server: PostgresServer): Promise<pg.Client> => {
    const client = new pg.Client({ connectionString: server.connectionString });
    await client.connect();
    return client;
  };

  test("a restart on the same directory resumes; another directory starts empty", async () => {
    const root = await newRoot();
    const first = await serve({ port: 0, durable: root });
    servers.push(first);
    const client = await connect(first);
    await client.query("CREATE TABLE notes (id serial PRIMARY KEY, body text)");
    await client.query("INSERT INTO notes (body) VALUES ('kept')");
    await client.query("CREATE DATABASE app");
    await client.end();
    await first.close();

    const second = await serve({ port: 0, durable: root });
    servers.push(second);
    expect(second.databaseNames()).toEqual(["app", "postgres"]);
    const again = await connect(second);
    expect((await again.query("SELECT id, body FROM notes")).rows).toEqual([{ id: 1, body: "kept" }]);
    await again.end();

    const elsewhere = await serve({ port: 0, durable: await newRoot() });
    servers.push(elsewhere);
    expect(elsewhere.databaseNames()).toEqual(["postgres"]);
    const fresh = await connect(elsewhere);
    await expect(fresh.query("SELECT * FROM notes")).rejects.toMatchObject({ code: "42P01" });
    await fresh.end();
  });
});
