import { describe, expect, test } from "bun:test";
import pg from "pg";
import { serve } from "../../src/wire/index.ts";

describe("postgres URI", () => {
  test("serve(uri) accepts a normal connection string and rejects another database", async () => {
    const server = await serve("postgres://postgres@127.0.0.1:0/app");
    expect(server.connectionString.startsWith("postgres://postgres@127.0.0.1:")).toBe(true);
    expect(server.connectionString.endsWith("/app")).toBe(true);
    expect(server.port).toBeGreaterThan(0);
    const client = new pg.Client({ connectionString: server.connectionString });
    await client.connect();
    try {
      expect((await client.query("SELECT 1 AS n")).rows).toEqual([{ n: 1 }]);
    } finally {
      await client.end();
    }
    const other = new pg.Client({
      connectionString: server.connectionString.replace(/\/app$/, "/other"),
    });
    await expect(other.connect()).rejects.toThrow(/does not exist|3D000/);
    await server.close();
  });
});
