import { expect, test } from "bun:test"
import {
  diagnoseSimulationFailure,
  simulationOrderSummary,
} from "./scripts/simulation-diagnostics.js"

test("simulation diagnostics expose lifecycle facts without private payload fields", () => {
  const summary = simulationOrderSummary({
    id: "private-id",
    patient_details: { first_name: "private-name" },
    lab_test: { method: "at_home_phlebotomy", name: "private-lab" },
    details: { type: "private-string" },
    requisition_form_url: "https://private.invalid/file",
    events: [
      { status: "received.at_home_phlebotomy.requisition_created" },
      { status: "collecting_sample.at_home_phlebotomy.appointment_scheduled" },
      { status: "cancelled.at_home_phlebotomy.cancelled", data: "private-data" },
    ],
  })
  expect(summary).toEqual({
    method: "at_home_phlebotomy",
    detailsType: null,
    eventCount: 3,
    requisitionCreated: true,
    appointmentScheduled: true,
    completed: false,
    cancelled: true,
    hasRequisitionUrl: true,
  })
  expect(JSON.stringify(summary)).not.toContain("private")
})

test("exhausted simulation failure gets a read-only snapshot and preserves its response", async () => {
  const request = new Request(
    "https://sandbox.invalid/v3/order/synthetic/test?final_status=completed.at_home_phlebotomy.completed",
    { method: "POST", body: "{}" },
  )
  const response = new Response("Internal Server Error", { status: 500 })
  const messages: string[] = []
  await diagnoseSimulationFailure(
    request,
    response,
    async (read) => {
      expect(read.method).toBe("GET")
      expect(read.url).toBe("https://sandbox.invalid/v3/order/synthetic")
      expect(read.body).toBeNull()
      return Response.json({ events: [] })
    },
    (message) => messages.push(message),
  )
  expect(messages).toHaveLength(1)
  expect(response.status).toBe(500)
  expect(await response.text()).toBe("Internal Server Error")
})

test("diagnostic read failures do not leak exception text or mask the parity failure", async () => {
  const messages: string[] = []
  await diagnoseSimulationFailure(
    new Request("https://sandbox.invalid/v3/order/synthetic/test", { method: "POST" }),
    new Response(null, { status: 500 }),
    async () => {
      throw new Error("private-error")
    },
    (message) => messages.push(message),
  )
  expect(messages).toEqual(["junction simulation failure state: unavailable"])
})

test("successful simulations and other endpoints do not cause diagnostic requests", async () => {
  for (const [path, status] of [
    ["/v3/order/synthetic/test", 200],
    ["/v3/order", 500],
  ] as const) {
    await diagnoseSimulationFailure(
      new Request(`https://sandbox.invalid${path}`, { method: "POST" }),
      new Response(null, { status }),
      async () => {
        throw new Error("unexpected read")
      },
      () => {
        throw new Error("unexpected log")
      },
    )
  }
})
