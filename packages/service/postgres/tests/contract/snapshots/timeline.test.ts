import { describe, expect, test } from "bun:test";
import { Database } from "../../../src/index.ts";

describe("timeline", () => {
  test("snapshot, checkout, and reset share one timeline", () => {
    const db = new Database();
    const origin = db.history.head("main")?.id;
    expect(db.history.size).toBe(1);
    db.exec("CREATE TABLE t (id int)");
    db.exec("INSERT INTO t VALUES (1)");
    const snap = db.snapshot();
    const id = db.history.head("main")?.id;
    expect(id).toBeDefined();
    db.exec("INSERT INTO t VALUES (2)");
    expect(db.query("SELECT id FROM t ORDER BY id")).toEqual([{ id: 1 }, { id: 2 }]);
    expect(db.query("SELECT id FROM t ORDER BY id", [], { at: snap })).toEqual([{ id: 1 }]);
    expect(db.query("SELECT id FROM t ORDER BY id", [], { at: id })).toEqual([{ id: 1 }]);
    db.fork("other");
    expect(db.query("SELECT id FROM t ORDER BY id")).toEqual([{ id: 1 }, { id: 2 }]);
    db.checkout(id ?? "", "other");
    expect(db.query("SELECT id FROM t ORDER BY id")).toEqual([{ id: 1 }]);
    db.reset();
    expect(db.history.head("main")?.id).toBe(origin);
    expect(() => db.query("SELECT id FROM t ORDER BY id")).toThrow();
  });

  test("a snapshot inside a transaction is rejected", () => {
    const db = new Database();
    db.exec("BEGIN");
    expect(() => db.snapshot()).toThrow(/transaction/);
    db.exec("ROLLBACK");
  });
});
