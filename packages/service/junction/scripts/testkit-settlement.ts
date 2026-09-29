/** Wait only at the observed asynchronous testkit completion boundary, never retry writes. */
export const withTestkitSettlement = (
  fetcher: (request: Request) => Promise<Response>,
  options: {
    now?: () => number
    sleep?: (ms: number) => Promise<unknown>
    timeoutMs?: number
    intervalMs?: number
  } = {},
): ((request: Request) => Promise<Response>) => {
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)))
  const timeout = options.timeoutMs ?? 15_000
  const interval = options.intervalMs ?? 250
  if (!(timeout > 0) || !(interval > 0)) throw new Error("Settlement intervals must be positive")
  return async (request) => {
    const url = new URL(request.url)
    const eligible =
      request.method === "POST" &&
      /^\/v3\/order\/[^/]+\/test$/.test(url.pathname) &&
      (url.searchParams.get("final_status") ?? "completed.at_home_phlebotomy.completed").endsWith(
        ".completed",
      ) &&
      Number(url.searchParams.get("delay") ?? 0) === 0
    const response = await fetcher(request)
    if (!eligible || !response.ok) return response
    url.pathname = url.pathname.replace(/\/test$/, "")
    url.search = ""
    const deadline = now() + timeout
    for (;;) {
      const remaining = deadline - now()
      if (remaining <= 0)
        throw new Error("Junction testkit simulation did not complete before settlement deadline")
      const observed = await fetcher(
        new Request(url, {
          headers: request.headers,
          signal: AbortSignal.any([request.signal, AbortSignal.timeout(Math.ceil(remaining))]),
        }),
      )
      if (!observed.ok)
        throw new Error(`Junction testkit settlement read failed (HTTP ${observed.status})`)
      const order = (await observed.json()) as { lab_test?: { method?: string }; status?: string }
      if (!order.lab_test?.method || !order.status)
        throw new Error("Junction testkit settlement returned an invalid order")
      if (order.lab_test.method !== "testkit" || order.status === "completed") return response
      if (order.status === "cancelled" || order.status === "failed")
        throw new Error("Junction testkit stopped before completion")
      await sleep(Math.min(interval, Math.max(0, deadline - now())))
    }
  }
}
