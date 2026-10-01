import { describe, expect, test } from "bun:test";
import { connect, serve } from "../../src/socket/index.ts";

describe("sqlite socket", () => {
  test("connect(uri) round-trips a statement", async () => {
    const server = await serve("sqlite://127.0.0.1:0/app");
    expect(server.url.startsWith("sqlite://127.0.0.1:")).toBe(true);
    expect(server.url.endsWith("/app")).toBe(true);
    const db = await connect(server.url);
    await db.exec("CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT)");
    await db.exec("INSERT INTO notes (body) VALUES ('hello')");
    expect(await db.query("SELECT body FROM notes")).toEqual([{ body: "hello" }]);
    await db.close();
    await server.close();
  });
});
