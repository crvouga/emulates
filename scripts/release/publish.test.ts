import { describe, expect, test } from "bun:test"
import {
  githubRetryDelayMs,
  initialPackageBlocker,
  isRetryableGitHubError,
  releaseInOrder,
} from "./lib.ts"

const release = (name: string, ...runtimeDeps: string[]) => ({ pkg: { name, runtimeDeps } })

describe("initialPackageBlocker", () => {
  const ci = { inCi: true, local: false, dryRun: false }

  test("a never-published package is blocked in CI and points to interactive seeding", () => {
    const lines = initialPackageBlocker([], ci)
    expect(lines?.join("\n")).toContain("bun run release:seed")
  })

  test("published packages, local logins and dry runs are never blocked", () => {
    expect(initialPackageBlocker(["1.0.0"], ci)).toBeNull()
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

describe("GitHub release retries", () => {
  test("retries the 500 that aborts a seed, and backs off", () => {
    expect(
      isRetryableGitHubError(
        "HTTP 500 (https://api.github.com/repos/crvouga/mockingbird/releases)",
      ),
    ).toBe(true)
    expect(isRetryableGitHubError("You have exceeded a secondary rate limit")).toBe(true)
    expect(isRetryableGitHubError("HTTP 422 Validation Failed")).toBe(false)
    expect(githubRetryDelayMs(0)).toBe(5000)
    expect(githubRetryDelayMs(1)).toBe(10_000)
    expect(githubRetryDelayMs(8)).toBe(60_000)
  })
})
