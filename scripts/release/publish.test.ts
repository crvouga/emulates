import { describe, expect, test } from "bun:test"
import { initialPackageBlocker, releaseInOrder } from "./lib.ts"

const release = (name: string, ...runtimeDeps: string[]) => ({ pkg: { name, runtimeDeps } })

describe("initialPackageBlocker", () => {
  const ci = { inCi: true, local: false, dryRun: false, npmToken: "" }

  test("a never-published package without NPM_TOKEN is blocked, and says how to unblock it", () => {
    const lines = initialPackageBlocker([], ci)
    expect(lines?.join("\n")).toContain("NPM_TOKEN")
  })

  test("published packages, tokens, local logins and dry runs are never blocked", () => {
    expect(initialPackageBlocker(["1.0.0"], ci)).toBeNull()
    expect(initialPackageBlocker([], { ...ci, npmToken: "set" })).toBeNull()
    expect(initialPackageBlocker([], { ...ci, local: true })).toBeNull()
    expect(initialPackageBlocker([], { ...ci, dryRun: true })).toBeNull()
  })
})

describe("releaseInOrder", () => {
  test("one package that cannot publish does not stop the others; only its dependents are skipped", async () => {
    const releases = [
      release("a"),
      release("new-pkg"),
      release("b"),
      release("dependent", "new-pkg"),
      release("c", "a"),
    ]
    const attempted: string[] = []
    const skipped: string[] = []
    const failed = await releaseInOrder(
      releases,
      async (r) => {
        attempted.push(r.pkg.name)
        return r.pkg.name !== "new-pkg"
      },
      (r) => skipped.push(r.pkg.name),
    )
    expect(attempted).toEqual(["a", "new-pkg", "b", "c"])
    expect(skipped).toEqual(["dependent"])
    expect([...failed].sort()).toEqual(["dependent", "new-pkg"])
  })
})
