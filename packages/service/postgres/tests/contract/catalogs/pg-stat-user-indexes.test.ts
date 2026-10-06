import { expect, test } from "bun:test";
import { Database, Snapshot } from "../../../src/index.ts";

// regression: emulators-postgres-index-statistics
test("actual unique index scans update usage while constraint validation does not", () => {
  const database = new Database();
  let restored: Database | undefined;
  try {
    database.exec("CREATE TABLE t (id int)");
    database.exec("CREATE UNIQUE INDEX t_id_idx ON t (id)");
    database.exec("INSERT INTO t VALUES (1)");
    const initial = database.snapshot();
    expect(database.query("SELECT idx_scan FROM pg_stat_user_indexes")).toEqual([{ idx_scan: 0n }]);
    expect(database.query("SELECT id FROM t WHERE id = 1")).toEqual([{ id: 1 }]);
    expect(database.query("SELECT idx_scan FROM pg_stat_user_indexes")).toEqual([{ idx_scan: 1n }]);
    restored = Snapshot.decode(initial.encode()).open();
    expect(restored.query("SELECT idx_scan FROM pg_stat_user_indexes")).toEqual([{ idx_scan: 0n }]);
  } finally {
    restored?.close();
    database.close();
  }
});
