import type { SimulationProbeCall } from "./simulation-probes.js"

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
const ok = (status: number) => status >= 200 && status < 300
const states = ["pending", "scheduled", "confirmed", "cancelled", "completed", "failed"]
const state = (value: unknown) =>
  typeof value === "string" && states.includes(value) ? value : null
export const bookingSummary = (value: unknown) => {
  const body = record(value)
  const location = record(body.location)
  return {
    status: state(body.status),
    eventStatus: state(body.event_status),
    events: Array.isArray(body.events)
      ? body.events.map((event) => state(record(event).status))
      : [],
    location:
      typeof location.lat === "number" && typeof location.lng === "number"
        ? { lat: location.lat, lng: location.lng }
        : null,
    duplicatePatient:
      typeof body.detail === "string" && body.detail.includes("patient already has an appointment"),
  }
}

/** One isolated synthetic patient, two orders; never print provider payloads or fixture identifiers. */
export async function probeBookingLifecycle(call: SimulationProbeCall, runId: string) {
  const observations: {
    step: string
    status: number
    appointment: ReturnType<typeof bookingSummary>
  }[] = []
  const orders: string[] = []
  const cleanup: { resource: string; status: number | null }[] = []
  let userId: string | undefined
  let reasonId: string | undefined
  let stage = "catalog"
  let failure: string | null = null
  const observe = async (step: string, method: string, path: string, body?: unknown) => {
    stage = step
    const reply = await call(method, path, body)
    observations.push({ step, status: reply.status, appointment: bookingSummary(reply.body) })
    return reply
  }
  const address = {
    first_line: "West Lincoln Street",
    second_line: null,
    city: "Phoenix",
    state: "AZ",
    zip_code: "85004",
    unit: null,
  }
  const key = async () => {
    stage = "availability"
    const reply = await call(
      "POST",
      "/v3/order/phlebotomy/appointment/availability?start_date=2099-06-15",
      address,
    )
    const root = record(reply.body)
    const days = root.slots ?? root.days
    const slots = Array.isArray(days)
      ? days.flatMap((day) => {
          const nested = record(day).slots
          return Array.isArray(nested) ? nested : [day]
        })
      : []
    const found = slots.map(record).find((slot) => typeof slot.booking_key === "string")
    if (!ok(reply.status) || typeof found?.booking_key !== "string") throw new Error()
    return found.booking_key
  }
  try {
    const catalog = await call("GET", "/v3/lab_test")
    const tests = record(catalog.body).data
    const test = Array.isArray(tests)
      ? tests
          .map(record)
          .find((entry) => entry.method === "at_home_phlebotomy" && entry.is_active !== false)
      : undefined
    if (!ok(catalog.status) || typeof test?.id !== "string") throw new Error()
    stage = "cancellation reasons"
    const reasons = await call("GET", "/v3/order/phlebotomy/appointment/cancellation-reasons")
    const items = Array.isArray(reasons.body)
      ? reasons.body
      : record(reasons.body).cancellation_reasons
    const reason = Array.isArray(items)
      ? items.map(record).find((entry) => typeof entry.id === "string" && entry.name !== "Other")
      : undefined
    if (!ok(reasons.status) || typeof reason?.id !== "string") throw new Error()
    reasonId = reason.id
    stage = "create user"
    const user = await call("POST", "/v2/user", { client_user_id: `booking-probe-${runId}` })
    const id = record(user.body).user_id
    if (typeof id === "string") userId = id
    if (!ok(user.status) || !userId) throw new Error()
    for (let index = 0; index < 2; index++) {
      stage = "create order"
      const created = await call("POST", "/v3/order", {
        user_id: userId,
        patient_details: {
          first_name: "Emulates",
          last_name: `Probe${runId.replace(/[^a-z]/gi, "")}`,
          dob: "1990-01-01",
          gender: "female",
          phone_number: `+120255501${String([...runId].reduce((sum, character) => sum + character.charCodeAt(0), 0) % 100).padStart(2, "0")}`,
          email: `probe-${runId}@example.com`,
        },
        patient_address: {
          first_line: address.first_line,
          city: address.city,
          state: address.state,
          zip: address.zip_code,
          country: "US",
        },
        order_set: { lab_test_ids: [test.id] },
      })
      const orderId = record(record(created.body).order).id
      if (typeof orderId === "string") orders.push(orderId)
      if (!ok(created.status) || typeof orderId !== "string") throw new Error()
      stage = "create requisition"
      const simulated = await call(
        "POST",
        `/v3/order/${orderId}/test?final_status=received.at_home_phlebotomy.requisition_created`,
        {},
      )
      if (!ok(simulated.status)) throw new Error()
    }
    const path = (index: number) => `/v3/order/${orders[index]}/phlebotomy/appointment`
    const first = await observe("book first", "POST", `${path(0)}/book`, {
      booking_key: await key(),
    })
    if (!ok(first.status)) throw new Error()
    const duplicate = await observe("duplicate same patient", "POST", `${path(1)}/book`, {
      booking_key: await key(),
    })
    if (ok(duplicate.status)) {
      const reset = await observe("cancel accepted duplicate", "PATCH", `${path(1)}/cancel`, {
        cancellation_reason_id: reasonId,
      })
      if (!ok(reset.status)) throw new Error()
    }
    const cancelled = await observe("cancel first", "PATCH", `${path(0)}/cancel`, {
      cancellation_reason_id: reasonId,
    })
    if (!ok(cancelled.status)) throw new Error()
    const verified = await observe("verify cancelled", "GET", path(0))
    if (!ok(verified.status) || record(verified.body).status !== "cancelled") throw new Error()
    await observe("book after cancellation", "POST", `${path(1)}/book`, {
      booking_key: await key(),
    })
  } catch {
    failure = stage
  } finally {
    for (const id of orders) {
      if (reasonId) {
        const cancelled = await call("PATCH", `/v3/order/${id}/phlebotomy/appointment/cancel`, {
          cancellation_reason_id: reasonId,
        }).catch(() => null)
        cleanup.push({ resource: "appointment", status: cancelled?.status ?? null })
      }
      const cancelled = await call("POST", `/v3/order/${id}/cancel`).catch(() => null)
      cleanup.push({ resource: "order", status: cancelled?.status ?? null })
    }
    if (userId) {
      const deleted = await call("DELETE", `/v2/user/${userId}`).catch(() => null)
      cleanup.push({ resource: "user", status: deleted?.status ?? null })
      if (!deleted || !ok(deleted.status)) failure ??= "cleanup user"
    }
  }
  return { complete: failure === null, failure, observations, cleanup }
}
