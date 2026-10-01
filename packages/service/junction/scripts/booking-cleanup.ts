import type { SimulationProbeCall } from "./simulation-probes.js"

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {}

/** Cancel and verify known walk appointments before deleting their users. */
export async function cancelWalkAppointments(
  call: SimulationProbeCall,
  orderIds: readonly string[],
) {
  let reasonId: string | undefined
  for (const id of new Set(orderIds)) {
    const path = `/v3/order/${encodeURIComponent(id)}/phlebotomy/appointment`
    const read = await call("GET", path)
    if (read.status === 404) continue
    if (read.status !== 200) throw new Error(`appointment cleanup read failed (${read.status})`)
    const status = record(read.body).status
    if (status === "cancelled" || status === "completed") continue
    if (!reasonId) {
      const reasons = await call("GET", "/v3/order/phlebotomy/appointment/cancellation-reasons")
      const reason = Array.isArray(reasons.body)
        ? reasons.body
            .map(record)
            .find((entry) => typeof entry.id === "string" && entry.name !== "Other")
        : undefined
      if (reasons.status !== 200 || typeof reason?.id !== "string")
        throw new Error("appointment cleanup reasons unavailable")
      reasonId = reason.id
    }
    const cancelled = await call("PATCH", `${path}/cancel`, { cancellation_reason_id: reasonId })
    if (cancelled.status !== 200)
      throw new Error(`appointment cleanup cancellation failed (${cancelled.status})`)
    const verified = await call("GET", path)
    if (verified.status !== 200 || record(verified.body).status !== "cancelled")
      throw new Error("appointment cleanup could not verify cancellation")
  }
}
