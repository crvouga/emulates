import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import pg from "pg";
import { type PostgresServer, serve } from "../../src/wire/index.ts";

let server: PostgresServer;

beforeAll(async () => {
  server = await serve({ port: 0 });
  const client = new pg.Client({ connectionString: server.connectionString });
  await client.connect();
  await client.query("CREATE TABLE copy_items (id int PRIMARY KEY, label text)");
  await client.end();
});

afterAll(async () => {
  await server.close();
});

const runPsql = async (sql: string, input = "") => {
  const psql = Bun.which("psql");
  if (!psql) throw new Error("psql is not installed");
  const proc = Bun.spawn([psql, "-X", "-v", "ON_ERROR_STOP=1", server.connectionString, "-c", sql], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  proc.stdin.write(input);
  proc.stdin.end();
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
};

describe("wire COPY protocol", () => {
  test.skipIf(!Bun.which("psql"))("psql streams COPY FROM STDIN across row and frame boundaries", async () => {
    const payload = Array.from({ length: 2_000 }, (_, i) => `${i}\tlabel-${i}`).join("\n") + "\n";
    const result = await runPsql("COPY copy_items (id, label) FROM STDIN", payload);
    expect(result).toMatchObject({ exitCode: 0 });
    expect(result.stdout).toContain("COPY 2000");

    const client = new pg.Client({ connectionString: server.connectionString });
    await client.connect();
    expect((await client.query("SELECT count(*)::int AS n FROM copy_items")).rows).toEqual([{ n: 2000 }]);
    await client.end();
  });

  test.skipIf(!Bun.which("psql"))("psql receives COPY query TO STDOUT frames", async () => {
    const result = await runPsql(
      "COPY (SELECT id, label FROM copy_items WHERE id < 2 ORDER BY id) TO STDOUT WITH (FORMAT csv)",
    );
    expect(result).toMatchObject({ exitCode: 0 });
    expect(result.stdout).toContain("0,label-0\n1,label-1\n");
  });

  test.skipIf(!Bun.which("psql"))("CSV records survive CopyData boundaries inside a quoted field", async () => {
    const label = `${"x".repeat(20_000)}\nwith "quote"`;
    const csv = `4000,"${label.replaceAll('"', '""')}"\n`;
    const result = await runPsql("COPY copy_items (id, label) FROM STDIN WITH (FORMAT csv)", csv);
    expect(result).toMatchObject({ exitCode: 0 });

    const client = new pg.Client({ connectionString: server.connectionString });
    await client.connect();
    expect((await client.query("SELECT label FROM copy_items WHERE id = 4000")).rows).toEqual([{ label }]);
    await client.end();
  });

  test.skipIf(!Bun.which("psql"))("malformed COPY is atomic and leaves the session usable", async () => {
    const result = await runPsql("COPY copy_items (id, label) FROM STDIN", "3000\tok\nnot-an-int\tbad\n");
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("invalid input syntax");

    const client = new pg.Client({ connectionString: server.connectionString });
    await client.connect();
    expect((await client.query("SELECT count(*)::int AS n FROM copy_items WHERE id = 3000")).rows).toEqual([{ n: 0 }]);
    await client.end();
  });
});
