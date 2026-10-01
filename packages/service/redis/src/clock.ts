export interface RedisClock {
  now(): number
  advance(ms: number): void
  subscribe(listener: () => void): () => void
  readonly manual: boolean
  set(ms: number): void
  freeze(): void
  unfreeze(): void
  reset(): void
  state(): { now: number; frozen: boolean; offsetMs: number }
}

export function manualClock(start = 0): RedisClock {
  return controlledClock(start)
}

export function wallClock(): RedisClock {
  return controlledClock()
}

function controlledClock(start?: number): RedisClock {
  let offset = 0
  let frozen = start
  const listeners = new Set<() => void>()
  const now = () => frozen ?? Date.now() + offset
  const notify = () => {
    for (const listener of [...listeners]) listener()
  }
  return {
    get manual() {
      return frozen !== undefined
    },
    now,
    set(ms) {
      if (!Number.isFinite(ms)) throw new Error("invalid clock instant")
      if (frozen !== undefined) frozen = ms
      else offset = ms - Date.now()
      notify()
    },
    advance(ms: number) {
      if (!Number.isFinite(ms)) throw new Error("invalid clock advance")
      if (frozen !== undefined) frozen += ms
      else offset += ms
      notify()
    },
    freeze() {
      frozen = now()
      notify()
    },
    unfreeze() {
      if (frozen !== undefined) {
        offset = frozen - Date.now()
        frozen = undefined
      }
      notify()
    },
    reset() {
      offset = 0
      frozen = start
      notify()
    },
    state: () => ({ now: now(), frozen: frozen !== undefined, offsetMs: offset }),
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}
