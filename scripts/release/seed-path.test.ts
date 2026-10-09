import { describe, expect, test } from "bun:test"
import { seedCachePath } from "./seed-path.ts"

describe("seedCachePath", () => {
  test("uses the primary repository parent from a linked worktree", () => {
    expect(seedCachePath("/repos/mockingbird/.git")).toBe("/repos/.mockingbird-seed-main")
  })
})
