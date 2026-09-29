import { expect, test } from "bun:test"
import { bookingSummary, probeBookingLifecycle } from "./scripts/booking-probes.js"
import type { SimulationProbeCall } from "./scripts/simulation-probes.js"
import { JunctionAPI } from "./src/index.js"

const fixture = () => {
  const api = new JunctionAPI()
  const requests: { method: string; path: string }[] = []
  const call: SimulationProbeCall = async (method, path, body) => {
    requests.push({ method, path })
    const response = await api.fetch(
      new Request(`http://mock.local${path}`, {
        method,
        headers: { "x-vital-api-key": "sk_us_test", "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    )
    const text = await response.text()
    let parsed: unknown = text
    try {
      parsed = JSON.parse(text)
    } catch {}
    return { status: response.status, body: parsed }
  }
  return { call, requests }
}
test("booking probe verifies cancellation and cleans appointments before deleting its user", async () => {
  const { call, requests } = fixture()
  const report = await probeBookingLifecycle(call, "fixture-abc")
  expect(report.failure).toBeNull()
  expect(report.complete).toBe(true)
  expect(
    report.observations.find((entry) => entry.step === "verify cancelled")?.appointment.status,
  ).toBe("cancelled")
  expect(
    report.observations.find((entry) => entry.step === "book after cancellation")?.status,
  ).toBe(200)
  expect(report.cleanup.map((entry) => entry.resource)).toEqual([
    "appointment",
    "order",
    "appointment",
    "order",
    "user",
  ])
  expect(requests.at(-1)?.method).toBe("DELETE")
  expect(JSON.stringify(report)).not.toContain("fixture-abc")
})
test("partial booking setup failure still cleans owned orders and user", async () => {
  const { call } = fixture()
  const report = await probeBookingLifecycle(async (method, path, body) => {
    if (path.includes("/availability")) throw new Error("private upstream payload")
    return call(method, path, body)
  }, "partial-xyz")
  expect(report.complete).toBe(false)
  expect(report.failure).toBe("availability")
  expect(report.cleanup.filter((entry) => entry.resource === "order")).toHaveLength(2)
  expect(report.cleanup.at(-1)?.resource).toBe("user")
  expect(JSON.stringify(report)).not.toContain("private")
})
test("booking diagnostics whitelist fields and classify duplicate rejection without leaking messages", () => {
  const summary = bookingSummary({
    id: "private-id",
    status: "private-status",
    events: [{ status: "pending", data: "private-data" }],
    detail: "The patient already has an appointment private-name",
    address: "private-address",
  })
  expect(summary.duplicatePatient).toBe(true)
  expect(summary.events).toEqual(["pending"])
  expect(JSON.stringify(summary)).not.toContain("private")
})
