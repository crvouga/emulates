import { expect, test } from "bun:test"
import { validateValue } from "@emulators/openapi"
import cancelledTestkitObservation from "./scripts/cancelled-testkit-observation.json" with {
  type: "json",
}
import { probeSimulationLifecycle, type SimulationProbeCall } from "./scripts/simulation-probes.js"
import { document, JunctionAPI } from "./src/index.js"

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

test("probe uses four distinct testkit orders and captures cancellation before each single simulation", async () => {
  const { call, requests } = fixture()
  const report = await probeSimulationLifecycle(call, "isolated")
  expect(report.failure).toBeNull()
  expect(report.complete).toBe(true)
  expect(
    report.cases.map((entry) => [entry.before.method, entry.before.cancelled, entry.target]),
  ).toEqual([
    ["testkit", false, "testkit"],
    ["testkit", false, "at_home_phlebotomy"],
    ["testkit", true, "testkit"],
    ["testkit", true, "at_home_phlebotomy"],
  ])
  const simulations = requests.filter((request) => request.path.includes("/test?"))
  expect(new Set(simulations.map((request) => request.path.split("/test?")[0])).size).toBe(4)
  expect(simulations).toHaveLength(4)
  expect(report.cleanup.filter((entry) => entry.resource === "user")).toHaveLength(1)
  expect(JSON.stringify(report)).not.toContain("probe@example.com")
  expect(JSON.stringify(report)).not.toContain("isolated")
})

test("partial setup failure cleans up owned resources and does not expose exception text", async () => {
  const { call, requests } = fixture()
  const report = await probeSimulationLifecycle(async (method, path, body) => {
    if (method === "GET" && path.startsWith("/v3/order/")) throw new Error("private patient data")
    return call(method, path, body)
  }, "partial")
  expect(report.complete).toBe(false)
  expect(report.failure).toBe("read before")
  expect(report.cleanup.map((entry) => entry.resource)).toEqual(["order", "user"])
  expect(requests.some((request) => request.path.includes("/test?"))).toBe(false)
  expect(JSON.stringify(report)).not.toContain("private")
})

test("a simulation 500 is recorded without retry and the other independent cases still run", async () => {
  const { call, requests } = fixture()
  let simulations = 0
  const report = await probeSimulationLifecycle(async (method, path, body) => {
    if (path.includes("/test?")) {
      simulations++
      return { status: 500, body: "sensitive error" }
    }
    return call(method, path, body)
  }, "failures")
  expect(simulations).toBe(4)
  expect(report.complete).toBe(true)
  expect(report.cases.map((entry) => entry.status)).toEqual([500, 500, 500, 500])
  expect(JSON.stringify(report)).not.toContain("sensitive")
  expect(requests.filter((request) => request.method === "DELETE")).toHaveLength(1)
})

test.each([undefined, ...cancelledTestkitObservation.targets])(
  "cancelled testkit simulation preserves the observed lifecycle for %s",
  async (target) => {
    const { call } = fixture()
    const report = await probeSimulationLifecycle(async (method, path, body) => {
      const reply = await call(
        method,
        target === undefined
          ? path
          : path.replace(/final_status=completed\.[^&]+/, `final_status=${target}`),
        body,
      )
      if (path.includes("/test?") && reply.status === 500) {
        const operation = document.paths["/v3/order/{order_id}/test"]?.post
        const response = operation?.responses?.[String(reply.status)]
        const schema =
          response && !("$ref" in response) ? response.content?.["text/plain"]?.schema : undefined
        expect(schema).toBeDefined()
        if (!schema) throw new Error("missing observed simulation response schema")
        expect(validateValue(document, schema, reply.body)).toEqual([])
        expect(reply.body).toBe("Internal Server Error")
      }
      return reply
    }, "cancelled-regression")
    expect(report.complete).toBe(true)
    expect(report.cases.map((entry) => entry.status)).toEqual([200, 200, 500, 500])
    for (const entry of report.cases.filter((entry) => entry.cancelled)) {
      expect(entry.after).toEqual(entry.before)
    }
  },
)
