import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { restoreOriginals } from "./files.ts"

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe("restoreOriginals", () => {
  test("restores files whose checkout still exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "mockingbird-restore-"))
    dirs.push(dir)
    const path = join(dir, "package.json")
    writeFileSync(path, "changed")

    expect(restoreOriginals(new Map([[path, "original"]]))).toBe(0)
    expect(readFileSync(path, "utf8")).toBe("original")
  })

  test("does not recreate a checkout that disappeared", () => {
    const dir = mkdtempSync(join(tmpdir(), "mockingbird-restore-"))
    rmSync(dir, { recursive: true })

    expect(restoreOriginals(new Map([[join(dir, "package.json"), "original"]]))).toBe(1)
  })
})
