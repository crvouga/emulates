import type { Clock } from "@crvouga/mockingbird-service"

/**
 * Timers that count down on a mock clock instead of the wall clock: the webhook hub's retry
 * backoff and attempt timeout, for a runtime whose clock the caller injected. A timer fires
 * when `run()` finds the clock at or past its due time, never on its own.
 */
export type ClockTimers = {
  schedule(callback: () => void, delayMs: number): unknown
  cancel(handle: unknown): void
  /** Fire every timer that is due now, earliest first. */
  run(): void
}

export const createClockTimers = (clock: Pick<Clock, "now">): ClockTimers => {
  type Timer = { due: number; callback: () => void }
  const timers = new Set<Timer>()
  return {
    schedule(callback, delayMs) {
      const timer: Timer = { due: clock.now() + delayMs, callback }
      timers.add(timer)
      return timer
    },
    cancel(handle) {
      timers.delete(handle as Timer)
    },
    run() {
      const now = clock.now()
      const due = [...timers].filter((timer) => timer.due <= now).sort((a, b) => a.due - b.due)
      for (const timer of due) {
        // A callback can cancel a sibling that is also due.
        if (!timers.delete(timer)) continue
        timer.callback()
      }
    },
  }
}
