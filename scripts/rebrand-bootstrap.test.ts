import { describe, expect, test } from "bun:test"
import { renameEnvKeys } from "./rebrand-bootstrap.ts"

describe("renameEnvKeys", () => {
  test("renames former keys and keeps values, comments and other keys", () => {
    const { text, renamed, kept } = renameEnvKeys(
      "# local\nMOCKINGBIRD_ADMIN_KEY=abc\nexport MOCKINGBIRD_TRACE = 1\nSTRIPE_SECRET_KEY=sk\n",
    )
    expect(text).toBe(
      "# local\nEMULATES_ADMIN_KEY=abc\nexport EMULATES_TRACE = 1\nSTRIPE_SECRET_KEY=sk\n",
    )
    expect(renamed).toEqual(["EMULATES_ADMIN_KEY", "EMULATES_TRACE"])
    expect(kept).toEqual([])
  })

  test("never overwrites a key that already has its new name", () => {
    const input = "MOCKINGBIRD_TRACE=old\nEMULATES_TRACE=new\n"
    const { text, renamed, kept } = renameEnvKeys(input)
    expect(text).toBe(input)
    expect(renamed).toEqual([])
    expect(kept).toEqual(["MOCKINGBIRD_TRACE"])
  })

  test("is idempotent", () => {
    const once = renameEnvKeys("MOCKINGBIRD_DROP=1\n").text
    expect(renameEnvKeys(once)).toEqual({ text: once, renamed: [], kept: [] })
  })

  test("renames the intermediate EMULATORS_ prefix", () => {
    const { text, renamed, kept } = renameEnvKeys("EMULATORS_ADMIN_KEY=abc\n")
    expect(text).toBe("EMULATES_ADMIN_KEY=abc\n")
    expect(renamed).toEqual(["EMULATES_ADMIN_KEY"])
    expect(kept).toEqual([])
  })
})
