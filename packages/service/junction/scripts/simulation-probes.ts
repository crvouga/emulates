import { simulationOrderSummary } from "./simulation-diagnostics.js"

type Reply = { status: number; body: unknown }
export type SimulationProbeCall = (method: string, path: string, body?: unknown) => Promise<Reply>
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {}
const success = (reply: Reply) => reply.status >= 200 && reply.status < 300

/** Isolated synthetic orders; reports contain only allowlisted lifecycle facts and HTTP statuses. */
export async function probeSimulationLifecycle(call: SimulationProbeCall, runId: string) {
  const cases: {
    cancelled: boolean
    target: "testkit" | "at_home_phlebotomy"
    before: ReturnType<typeof simulationOrderSummary>
    status: number
    afterStatus: number
    after: ReturnType<typeof simulationOrderSummary> | null
  }[] = []
  const cleanup: { resource: "order" | "user"; status: number | null }[] = []
  const orders: string[] = []
  let userId: string | undefined
  let stage = "catalog"
  let failure: string | null = null
  try {
    const catalog = await call("GET", "/v3/lab_test")
    const data = record(catalog.body).data
    const test = Array.isArray(data)
      ? data.map(record).find((test) => test.method === "testkit" && test.is_active !== false)
      : undefined
    if (!success(catalog) || typeof test?.id !== "string") throw new Error()
    stage = "create user"
    const user = await call("POST", "/v2/user", {
      client_user_id: `emulators-simulation-probe-${runId}`,
    })
    const id = record(user.body).user_id
    if (typeof id === "string") userId = id
    if (!success(user) || userId === undefined) throw new Error()
    for (const cancelled of [false, true]) {
      for (const target of ["testkit", "at_home_phlebotomy"] as const) {
        stage = "create order"
        const created = await call("POST", "/v3/order", {
          user_id: userId,
          patient_details: {
            first_name: "Emulators",
            last_name: "Probe",
            dob: "1990-01-01",
            gender: "female",
            phone_number: "+14155551234",
            email: "probe@example.com",
          },
          patient_address: {
            first_line: "1 Main St",
            city: "San Diego",
            state: "CA",
            zip: "92101",
            country: "US",
          },
          order_set: { lab_test_ids: [test.id] },
        })
        const orderId = record(record(created.body).order).id
        if (typeof orderId === "string") orders.push(orderId)
        if (!success(created) || typeof orderId !== "string") throw new Error()
        const path = `/v3/order/${encodeURIComponent(orderId)}`
        if (cancelled) {
          stage = "cancel order"
          if (!success(await call("POST", `${path}/cancel`))) throw new Error()
        }
        stage = "read before"
        const before = await call("GET", path)
        const summary = simulationOrderSummary(before.body)
        stage = `read before (HTTP ${before.status}, expected cancelled=${cancelled}, observed cancelled=${summary.cancelled})`
        if (!success(before) || summary.method !== "testkit" || summary.cancelled !== cancelled)
          throw new Error()
        stage = "simulate"
        // Exactly one request: retries could hide a partial transition caused by a failed request.
        const simulated = await call(
          "POST",
          `${path}/test?final_status=completed.${target}.completed`,
          {},
        )
        stage = "read after"
        const after = await call("GET", path)
        cases.push({
          cancelled,
          target,
          before: summary,
          status: simulated.status,
          afterStatus: after.status,
          after: success(after) ? simulationOrderSummary(after.body) : null,
        })
        if (!success(after)) throw new Error()
      }
    }
  } catch {
    failure = stage
  } finally {
    for (const id of orders) {
      const result = await call("POST", `/v3/order/${encodeURIComponent(id)}/cancel`).catch(
        () => null,
      )
      cleanup.push({ resource: "order", status: result?.status ?? null })
    }
    if (userId !== undefined) {
      const result = await call("DELETE", `/v2/user/${encodeURIComponent(userId)}`).catch(
        () => null,
      )
      cleanup.push({ resource: "user", status: result?.status ?? null })
    }
  }
  const userCleanup = cleanup.find((entry) => entry.resource === "user")
  const cleanupSucceeded =
    userId === undefined ||
    (userCleanup?.status !== null &&
      userCleanup?.status !== undefined &&
      userCleanup.status >= 200 &&
      userCleanup.status < 300)
  return {
    complete: failure === null && cases.length === 4 && cleanupSucceeded,
    failure: failure ?? (cleanupSucceeded ? null : "cleanup user"),
    cases,
    cleanup,
  }
}
