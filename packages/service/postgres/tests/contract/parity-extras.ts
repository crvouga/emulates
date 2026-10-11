import { expect } from "bun:test";
import { expectParity } from "../harness/assert.ts";
import { matrixBoth } from "../harness/matrix.ts";
import { setupBoth } from "./helpers.ts";

/**
 * Both backends must reject `sql` with the same SQLSTATE. For syntax errors,
 * where the engine's parser words the message its own way ("... (expected
 * identifier)"), so the text is not comparable but the code is.
 */
export function sqlstateParity(name: string, setup: string[], sql: string, sqlstate: string): void {
  matrixBoth(name, async (memory, postgres) => {
    await setupBoth(memory, postgres, setup);
    const a = await memory.exec(sql);
    const b = await postgres.exec(sql);
    expect(a.ok, `memory unexpectedly succeeded: ${sql}`).toBe(false);
    expect(b.ok, `postgres unexpectedly succeeded: ${sql}`).toBe(false);
    expect(b.error?.sqlstate).toBe(sqlstate);
    expect(a.error?.sqlstate).toBe(sqlstate);
  });
}

/**
 * Like `errorParity` with an exact message, for setups that create temporary
 * objects: the oracle session is shared and its reset keeps `pg_temp`, so the
 * objects are dropped afterwards whatever the outcome.
 */
export function tempErrorParity(name: string, setup: string[], sql: string, cleanup: string[]): void {
  matrixBoth(name, async (memory, postgres) => {
    try {
      await setupBoth(memory, postgres, setup);
      const a = await memory.exec(sql);
      const b = await postgres.exec(sql);
      expect(a.ok, `memory unexpectedly succeeded: ${sql}`).toBe(false);
      expect(b.ok, `postgres unexpectedly succeeded: ${sql}`).toBe(false);
      expectParity(a, b, { ignoreWriteCounters: true, ignoreErrorPhase: true, messageTier: "A" });
    } finally {
      for (const drop of cleanup) await postgres.exec(drop);
    }
  });
}
