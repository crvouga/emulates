import { expect, test } from "bun:test"
import { withTestkitSettlement } from "./scripts/testkit-settlement.js"

const simulation = () =>
  new Request("https://mock/v3/order/order-id/test?final_status=completed.testkit.completed", {
    method: "POST",
  })

test("settlement polls reads without repeating a successful simulation", async () => {
  let writes = 0
  let reads = 0
  let now = 0
  const call = withTestkitSettlement(
    async (request) => {
      if (request.method === "POST") {
        writes++
        return Response.json("Success")
      }
      reads++
      return Response.json({
        lab_test: { method: "testkit" },
        status: reads < 3 ? "sample_with_lab" : "completed",
      })
    },
    {
      now: () => now,
      sleep: async (ms) => {
        now += ms
      },
      timeoutMs: 1000,
      intervalMs: 100,
    },
  )
  expect(await (await call(simulation())).json()).toBe("Success")
  expect(writes).toBe(1)
  expect(reads).toBe(3)
})

test("settlement fails explicitly at its deadline", async () => {
  let now = 0
  let rejected = false
  const call = withTestkitSettlement(
    async (request) =>
      request.method === "POST"
        ? Response.json("Success")
        : Response.json({ lab_test: { method: "testkit" }, status: "sample_with_lab" }),
    {
      now: () => now,
      sleep: async (ms) => {
        now += ms
      },
      timeoutMs: 200,
      intervalMs: 100,
    },
  )
  try {
    await call(simulation())
  } catch (error) {
    rejected = true
    expect(String(error)).toContain("did not complete")
  }
  expect(rejected).toBe(true)
  expect(now).toBe(200)
})

test("failed simulations and other modalities are not retried or waited to completion", async () => {
  let reads = 0
  const failed = withTestkitSettlement(
    async () => new Response("Internal Server Error", { status: 500 }),
  )
  expect((await failed(simulation())).status).toBe(500)
  const other = withTestkitSettlement(async (request) => {
    if (request.method === "POST") return Response.json("Success")
    reads++
    return Response.json({ lab_test: { method: "walk_in_test" }, status: "received" })
  })
  expect((await other(simulation())).status).toBe(200)
  expect(reads).toBe(1)
})

test("settlement leaves explicit delayed simulations alone", async () => {
  let calls = 0
  const call = withTestkitSettlement(async () => {
    calls++
    return Response.json("Success")
  })
  const request = new Request(`${simulation().url}&delay=3`, { method: "POST" })
  expect((await call(request)).status).toBe(200)
  expect(calls).toBe(1)
})

test("settlement does not hide a failed order read", async () => {
  let failed = false
  const call = withTestkitSettlement(async (request) =>
    request.method === "POST" ? Response.json("Success") : new Response(null, { status: 503 }),
  )
  try {
    await call(simulation())
  } catch (error) {
    failed = true
    expect(String(error)).toContain("HTTP 503")
  }
  expect(failed).toBe(true)
})
