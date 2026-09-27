import { jsonRes } from "@crvouga/mockingbird-service"
import { DockerInputError, type DockerState, isRunning, record } from "./state.js"

type Waiter = { id: string; condition: string; finish(exitCode: number): void; cancel(): void }

/** Persist transitions; keep only live response handles outside shared storage. */
export class DockerLifecycle {
  private closed = false
  private readonly waiters = new Set<Waiter>()
  constructor(
    private readonly state: DockerState,
    private readonly now: () => number,
  ) {}
  get pending(): number {
    return this.waiters.size
  }

  start(id: string, url: URL): Response {
    for (const key of ["checkpoint", "checkpoint-dir", "detachKeys"])
      if (url.searchParams.get(key))
        throw new DockerInputError(501, `Mockingbird: start ${key} is not implemented`)
    const c = this.state.find(id)
    if (c.status === "paused")
      throw new DockerInputError(409, "cannot start a paused container, try unpause instead")
    if (isRunning(c)) return new Response(null, { status: 304 })
    if (c.status === "removing" || c.status === "dead")
      throw new DockerInputError(409, "container is marked for removal and cannot be started")
    this.state.containers.update(c.id, {
      ...c,
      status: "running",
      exitCode: 0,
      startedAt: new Date(this.now()).toISOString(),
    })
    return new Response(null, { status: 204 })
  }

  complete(id: string, value: unknown) {
    if (
      !record(value) ||
      Object.keys(value).some((k) => k !== "exitCode") ||
      !Number.isSafeInteger(value.exitCode)
    )
      throw new DockerInputError(400, "completion: expected {exitCode: integer}")
    const c = this.state.find(id)
    if (!isRunning(c)) throw new DockerInputError(409, "container is not running")
    const exitCode = value.exitCode as number
    this.state.containers.update(c.id, {
      ...c,
      status: "exited",
      exitCode,
      finishedAt: new Date(this.now()).toISOString(),
    })
    const removed = c.hostConfig.AutoRemove === true
    if (removed) this.state.containers.delete(c.id)
    for (const waiter of this.waiters)
      if (waiter.id === c.id && (removed || waiter.condition !== "removed")) waiter.finish(exitCode)
    return { id: c.id, exitCode, removed, simulated: true }
  }

  wait(id: string, url: URL, signal: AbortSignal): Response {
    if (this.closed) throw new DOMException("Docker runtime is closed", "AbortError")
    const condition = url.searchParams.get("condition") || "not-running"
    if (!["not-running", "next-exit", "removed"].includes(condition))
      throw new DockerInputError(400, `invalid condition: ${JSON.stringify(condition)}`)
    const c = this.state.find(id)
    if (signal.aborted) throw new DOMException("The operation was aborted", "AbortError")
    if (condition === "not-running" && !isRunning(c))
      return jsonRes(200, { StatusCode: c.exitCode })
    let cleanup = () => {}
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        let settled = false
        const release = () => {
          if (settled) return false
          settled = true
          this.waiters.delete(waiter)
          signal.removeEventListener("abort", abort)
          return true
        }
        const abort = () => {
          if (release()) controller.error(new DOMException("Docker wait canceled", "AbortError"))
        }
        const waiter: Waiter = {
          id: c.id,
          condition,
          finish: (exitCode) => {
            if (!release()) return
            controller.enqueue(
              new TextEncoder().encode(`${JSON.stringify({ StatusCode: exitCode })}\n`),
            )
            controller.close()
          },
          cancel: abort,
        }
        cleanup = () => {
          release()
        }
        this.waiters.add(waiter)
        signal.addEventListener("abort", abort, { once: true })
        if (signal.aborted) abort()
      },
      cancel: () => cleanup(),
    })
    return new Response(stream, { headers: { "content-type": "application/json" } })
  }

  close(): void {
    this.closed = true
    this.cancelWaits()
  }

  cancelWaits(): void {
    for (const waiter of this.waiters) waiter.cancel()
  }
}
