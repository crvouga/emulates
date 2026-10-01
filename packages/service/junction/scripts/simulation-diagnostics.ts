const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}

const methods = ["at_home_phlebotomy", "walk_in_test", "testkit", "on_site_collection"]
const knownMethod = (value: unknown) =>
  typeof value === "string" && methods.includes(value) ? value : null

/** Only lifecycle facts: never serialize patient data, identifiers, URLs, or arbitrary strings. */
export const simulationOrderSummary = (value: unknown) => {
  const order = record(value)
  const events = Array.isArray(order.events) ? order.events.map(record) : []
  const hasEvent = (suffix: string) =>
    events.some((event) =>
      methods.some(
        (method) => event.status === `${suffix.split(".")[0]}.${method}.${suffix.split(".")[1]}`,
      ),
    )
  return {
    method: knownMethod(record(order.lab_test).method),
    detailsType: knownMethod(record(order.details).type),
    eventCount: events.length,
    requisitionCreated: hasEvent("received.requisition_created"),
    appointmentScheduled: hasEvent("collecting_sample.appointment_scheduled"),
    completed: hasEvent("completed.completed"),
    cancelled: hasEvent("cancelled.cancelled"),
    hasRequisitionUrl: typeof order.requisition_form_url === "string",
  }
}

/** Enrich exhausted simulation failures without consuming or replacing the failing response. */
export const diagnoseSimulationFailure = async (
  request: Request,
  response: Response,
  fetcher: (request: Request) => Promise<Response>,
  log: (message: string) => void,
): Promise<void> => {
  const url = new URL(request.url)
  if (
    request.method !== "POST" ||
    response.status < 500 ||
    !/^\/v3\/order\/[^/]+\/test$/.test(url.pathname)
  )
    return
  url.pathname = url.pathname.slice(0, -"/test".length)
  url.search = ""
  const headers = new Headers(request.headers)
  headers.delete("content-length")
  headers.delete("transfer-encoding")
  try {
    const observed = await fetcher(
      new Request(url, {
        headers,
        signal: AbortSignal.timeout(10_000),
      }),
    )
    const summary = observed.ok ? simulationOrderSummary(await observed.json()) : null
    log(
      `junction simulation failure state: ${JSON.stringify({ readStatus: observed.status, order: summary })}`,
    )
  } catch {
    log("junction simulation failure state: unavailable")
  }
}
