import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import pg from "pg";
import { Database } from "../../src/index.ts";
import { type PostgresServer, serve } from "../../src/wire/index.ts";

let server: PostgresServer;

beforeAll(async () => {
  server = await serve({ database: new Database({ now: "system" }) });
});

afterAll(async () => {
  await server.close();
});

const client = async (): Promise<pg.Client> => {
  const value = new pg.Client({ connectionString: server.connectionString });
  await value.connect();
  return value;
};

const settle = () => new Promise((resolve) => setTimeout(resolve, 60));

describe("READ COMMITTED workspaces", () => {
  test("uncommitted writes stay private and become visible at commit", async () => {
    const a = await client();
    const b = await client();
    try {
      await a.query("CREATE TABLE visibility (id int PRIMARY KEY)");
      await a.query("BEGIN");
      await a.query("INSERT INTO visibility VALUES (1)");
      expect((await a.query("SELECT count(*)::int AS n FROM visibility")).rows).toEqual([{ n: 1 }]);
      expect((await b.query("SELECT count(*)::int AS n FROM visibility")).rows).toEqual([{ n: 0 }]);
      await a.query("COMMIT");
      expect((await b.query("SELECT count(*)::int AS n FROM visibility")).rows).toEqual([{ n: 1 }]);
    } finally {
      await a.end();
      await b.end();
    }
  });

  test("rollback discards writes and releases row locks", async () => {
    const a = await client();
    const b = await client();
    try {
      await a.query("CREATE TABLE rollback_jobs (id int PRIMARY KEY)");
      await a.query("INSERT INTO rollback_jobs VALUES (1)");
      await a.query("BEGIN");
      await a.query("INSERT INTO rollback_jobs VALUES (2)");
      await a.query("SELECT id FROM rollback_jobs WHERE id = 1 FOR UPDATE");
      const waiting = b.query("SELECT id FROM rollback_jobs WHERE id = 1 FOR UPDATE");
      expect(await Promise.race([waiting.then(() => "done"), settle().then(() => "waiting")])).toBe("waiting");
      await a.query("ROLLBACK");
      expect((await waiting).rows).toEqual([{ id: 1 }]);
      expect((await b.query("SELECT id FROM rollback_jobs ORDER BY id")).rows).toEqual([{ id: 1 }]);
    } finally {
      await a.end();
      await b.end();
    }
  });

  test("an unrelated autocommit write progresses while a transaction is open", async () => {
    const setup = await client();
    await setup.query("CREATE TABLE progress (id int PRIMARY KEY, value int)");
    await setup.query("INSERT INTO progress VALUES (1, 0), (2, 0)");
    await setup.end();

    const a = await client();
    const b = await client();
    try {
      await a.query("BEGIN");
      await a.query("UPDATE progress SET value = 1 WHERE id = 1");
      const update = b.query("UPDATE progress SET value = 2 WHERE id = 2");
      expect(await Promise.race([update.then(() => "done"), settle().then(() => "blocked")])).toBe("done");
      expect((await a.query("SELECT value FROM progress WHERE id = 2")).rows).toEqual([{ value: 2 }]);
      await a.query("COMMIT");
      expect((await b.query("SELECT id, value FROM progress ORDER BY id")).rows).toEqual([
        { id: 1, value: 1 },
        { id: 2, value: 2 },
      ]);
    } finally {
      await a.end();
      await b.end();
    }
  });
});

describe("insert conflicts and aliased updates", () => {
  test("a duplicate primary key reports 23505", async () => {
    const c = await client();
    try {
      await c.query("CREATE TABLE keys (id int PRIMARY KEY)");
      await c.query("INSERT INTO keys (id) VALUES (1)");
      await expect(c.query("INSERT INTO keys (id) VALUES (1)")).rejects.toMatchObject({ code: "23505" });
    } finally {
      await c.end();
    }
  });

  test("INSERT ON CONFLICT waits for the open transaction and keeps the committed row", async () => {
    const setup = await client();
    await setup.query("CREATE TABLE owners (id text PRIMARY KEY, current_id text)");
    await setup.end();

    const a = await client();
    const b = await client();
    try {
      await a.query("BEGIN");
      await b.query("BEGIN");
      await a.query(
        "INSERT INTO owners (id, current_id) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET current_id = excluded.current_id RETURNING current_id",
        ["alice", "first"],
      );
      const waiting = b.query(
        "INSERT INTO owners (id, current_id) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET current_id = owners.current_id RETURNING current_id",
        ["alice", "second"],
      );
      expect(await Promise.race([waiting.then(() => "done"), settle().then(() => "waiting")])).toBe("waiting");
      await a.query("COMMIT");
      expect((await waiting).rows).toEqual([{ current_id: "first" }]);
      await b.query("COMMIT");
      expect((await b.query("SELECT current_id FROM owners WHERE id = 'alice'")).rows).toEqual([
        { current_id: "first" },
      ]);
    } finally {
      await a.end();
      await b.end();
    }
  });

  test("UPDATE alias references survive the row lock and the write", async () => {
    const c = await client();
    try {
      await c.query("CREATE TABLE parts (id int PRIMARY KEY, deleted_at text)");
      await c.query("INSERT INTO parts (id, deleted_at) VALUES (1, NULL)");
      await c.query(`CREATE TABLE waiting (id int PRIMARY KEY, part_id int, deleted_at text)`);
      const updated = await c.query(
        `UPDATE parts AS ap
            SET deleted_at = $1
          WHERE ap.deleted_at IS NULL
            AND NOT EXISTS (
              SELECT 1 FROM waiting AS w
               WHERE w.part_id = ap.id AND w.deleted_at IS NULL
            )
          RETURNING id`,
        ["2020-01-01T00:00:00.000Z"],
      );
      expect(updated.rows).toEqual([{ id: 1 }]);
    } finally {
      await c.end();
    }
  });
});

describe("row locks", () => {
  test("SKIP LOCKED assigns a different job and NOWAIT reports 55P03", async () => {
    const setup = await client();
    await setup.query("CREATE TABLE jobs (id int PRIMARY KEY, state text)");
    await setup.query("INSERT INTO jobs VALUES (1, 'ready'), (2, 'ready')");
    await setup.end();

    const a = await client();
    const b = await client();
    try {
      await a.query("BEGIN");
      await b.query("BEGIN");
      expect((await a.query("SELECT id FROM jobs WHERE state = 'ready' ORDER BY id LIMIT 1 FOR UPDATE")).rows).toEqual([
        { id: 1 },
      ]);
      expect(
        (await b.query("SELECT id FROM jobs WHERE state = 'ready' ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED")).rows,
      ).toEqual([{ id: 2 }]);
      await expect(b.query("SELECT id FROM jobs WHERE id = 1 FOR UPDATE NOWAIT")).rejects.toMatchObject({
        code: "55P03",
      });
      await b.query("ROLLBACK");
      await a.query("ROLLBACK");
    } finally {
      await a.end();
      await b.end();
    }
  });

  test("a row-lock cycle aborts one participant with 40P01", async () => {
    const setup = await client();
    await setup.query("CREATE TABLE deadlock_jobs (id int PRIMARY KEY)");
    await setup.query("INSERT INTO deadlock_jobs VALUES (1), (2)");
    await setup.end();

    const a = await client();
    const b = await client();
    try {
      await a.query("BEGIN");
      await b.query("BEGIN");
      await a.query("SELECT id FROM deadlock_jobs WHERE id = 1 FOR UPDATE");
      await b.query("SELECT id FROM deadlock_jobs WHERE id = 2 FOR UPDATE");
      const aWaiting = a.query("SELECT id FROM deadlock_jobs WHERE id = 2 FOR UPDATE");
      await settle();
      await expect(b.query("SELECT id FROM deadlock_jobs WHERE id = 1 FOR UPDATE")).rejects.toMatchObject({
        code: "40P01",
      });
      expect((await aWaiting).rows).toEqual([{ id: 2 }]);
      await a.query("ROLLBACK");
      await b.query("ROLLBACK");
    } finally {
      await a.end();
      await b.end();
    }
  });

  test("conflicting updates wait and retry after the holder commits", async () => {
    const setup = await client();
    await setup.query("CREATE TABLE update_jobs (id int PRIMARY KEY, value int)");
    await setup.query("INSERT INTO update_jobs VALUES (1, 0)");
    await setup.end();

    const a = await client();
    const b = await client();
    try {
      await a.query("BEGIN");
      await a.query("UPDATE update_jobs SET value = 1 WHERE id = 1");
      const waiting = b.query("UPDATE update_jobs SET value = value + 10 WHERE id = 1");
      expect(await Promise.race([waiting.then(() => "done"), settle().then(() => "waiting")])).toBe("waiting");
      await a.query("COMMIT");
      expect((await waiting).rowCount).toBe(1);
      expect((await b.query("SELECT value FROM update_jobs WHERE id = 1")).rows).toEqual([{ value: 11 }]);
    } finally {
      await a.end();
      await b.end();
    }
  });
});
