import { describe, expect, test } from "bun:test"
import type { TrustConfig } from "../health/trusted-publisher.ts"
import { hasReleasePublisher, trustedPublisherReconciler } from "./trust.ts"

const config: TrustConfig = {
  type: "github",
  permissions: ["createPackage"],
  claims: { repository: "crvouga/mockingbird", workflow_ref: { file: "ci.yml" } },
}

describe("local seed trust reconciliation", () => {
  test("the repository name alone does not prove CI can publish", () => {
    expect(hasReleasePublisher(JSON.stringify([config]))).toBe(true)
    for (const other of [
      { ...config, permissions: ["createStagedPackage"] },
      { ...config, environment: "production" },
      { ...config, claims: { ...config.claims, workflow_ref: { file: "other.yml" } } },
      { ...config, claims: { ...config.claims, repository: "crvouga/mockingbird-extra" } },
    ]) {
      expect(hasReleasePublisher(JSON.stringify([other]))).toBe(false)
    }
    for (const output of ["[]", "null", "[null]", "not json", JSON.stringify(config)]) {
      expect(hasReleasePublisher(output)).toBe(false)
    }
  })

  test("healthy configurations are skipped without a mutation", async () => {
    const created: string[] = []
    const trust = trustedPublisherReconciler({
      list: async () => JSON.stringify([config]),
      create: async (name) => {
        created.push(name)
        return true
      },
      onError: () => {},
    })
    await trust.ensure("healthy")
    expect(created).toEqual([])
    expect(trust.failed.size).toBe(0)
  })

  test("spaces mutations, preserves failures and continues independent packages", async () => {
    let clock = 0
    const started: number[] = []
    const slept: number[] = []
    const trust = trustedPublisherReconciler({
      list: async () => "[]",
      create: async (name) => {
        started.push(clock)
        clock += 500
        return name !== "failed"
      },
      onError: () => {},
      now: () => clock,
      sleep: async (ms) => {
        slept.push(ms)
        clock += ms
      },
    })
    for (const name of ["first", "failed", "last"]) await trust.ensure(name)
    expect(started).toEqual([0, 2_500, 5_000])
    expect(slept).toEqual([2_000, 2_000])
    expect([...trust.failed]).toEqual(["failed"])
  })

  test("a successful retry clears an earlier failure", async () => {
    let healthy = false
    const trust = trustedPublisherReconciler({
      list: async () => JSON.stringify(healthy ? [config] : []),
      create: async () => false,
      onError: () => {},
    })
    await trust.ensure("retry")
    expect([...trust.failed]).toEqual(["retry"])
    healthy = true
    await trust.ensure("retry")
    expect(trust.failed.size).toBe(0)
  })

  test("thrown trust commands remain failures without aborting reconciliation", async () => {
    const errors: string[] = []
    const trust = trustedPublisherReconciler({
      list: async (name) => {
        if (name === "lookup-failed") throw new Error("lookup failed")
        return "[]"
      },
      create: async (name) => {
        if (name === "create-failed") throw new Error("create failed")
        return true
      },
      onError: (name) => errors.push(name),
      sleep: async () => {},
    })
    for (const name of ["lookup-failed", "create-failed", "healthy"]) await trust.ensure(name)
    expect([...trust.failed]).toEqual(["lookup-failed", "create-failed"])
    expect(errors).toEqual(["lookup-failed", "create-failed"])
  })
})
