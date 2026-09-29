import { expect, test } from "bun:test"
import { cancelWalkAppointments } from "./scripts/booking-cleanup.js"

test("cleanup verifies cancellation and ignores only absent or terminal appointments", async () => {
  const calls: string[] = []
  let cancelled = false
  await cancelWalkAppointments(
    async (method, path) => {
      calls.push(`${method} ${path}`)
      if (path.includes("/missing/")) return { status: 404, body: {} }
      if (path.endsWith("cancellation-reasons"))
        return { status: 200, body: [{ id: "reason", name: "Changed plans" }] }
      if (method === "PATCH") cancelled = true
      return { status: 200, body: { status: cancelled ? "cancelled" : "pending" } }
    },
    ["owned", "owned", "missing"],
  )
  expect(cancelled).toBe(true)
  expect(calls.filter((call) => call.startsWith("PATCH"))).toHaveLength(1)
  expect(
    calls.filter((call) => call === "GET /v3/order/owned/phlebotomy/appointment"),
  ).toHaveLength(2)
})
test("cleanup refuses to continue when cancellation is not verified", async () => {
  let failed = false
  try {
    await cancelWalkAppointments(
      async (_method, path) =>
        path.endsWith("cancellation-reasons")
          ? { status: 200, body: [{ id: "reason", name: "Changed plans" }] }
          : { status: 200, body: { status: "pending" } },
      ["owned"],
    )
  } catch {
    failed = true
  }
  expect(failed).toBe(true)
})
