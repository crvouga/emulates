import { describe, expect, test } from "bun:test"
import { renameEnvKeys } from "./rebrand-bootstrap.ts"

describe("renameEnvKeys", () => {
  test("renames former keys and keeps values, comments and other keys", () => {
    const { text, renamed, kept } = renameEnvKeys(
      "# local\nMOCKINGBIRD_ADMIN_KEY=abc\nexport MOCKINGBIRD_TRACE = 1\nSTRIPE_SECRET_KEY=sk\n",
    )
    expect(text).toBe(
      "# local\nEMULATORS_ADMIN_KEY=abc\nexport EMULATORS_TRACE = 1\nSTRIPE_SECRET_KEY=sk\n",
    )
    expect(renamed).toEqual(["EMULATORS_ADMIN_KEY", "EMULATORS_TRACE"])
    expect(kept).toEqual([])
  })

  test("never overwrites a key that already has its new name", () => {
    const input = "MOCKINGBIRD_TRACE=old\nEMULATORS_TRACE=new\n"
    const { text, renamed, kept } = renameEnvKeys(input)
    expect(text).toBe(input)
    expect(renamed).toEqual([])
    expect(kept).toEqual(["MOCKINGBIRD_TRACE"])
  })

  test("is idempotent", () => {
    const once = renameEnvKeys("MOCKINGBIRD_DROP=1\n").text
    expect(renameEnvKeys(once)).toEqual({ text: once, renamed: [], kept: [] })
  })
})
