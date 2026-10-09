import { existsSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"

/** Restore temporary release edits without recreating a checkout that disappeared mid-run. */
export function restoreOriginals(originals: ReadonlyMap<string, string>): number {
  let skipped = 0
  for (const [path, raw] of originals) {
    if (!existsSync(dirname(path))) {
      skipped += 1
      continue
    }
    writeFileSync(path, raw)
  }
  return skipped
}
