export interface RedisClock {
  now(): number
  advance(ms: number): void
  subscribe(listener: () => void): () => void
  readonly manual: boolean
}

export function manualClock(start = 0): RedisClock {
  let current = start
  const listeners = new Set<() => void>()
  return {
    manual: true,
    now: () => current,
    advance(ms: number) {
      current += ms
      for (const listener of [...listeners]) listener()
    },
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

export function wallClock(): RedisClock {
  let offset = 0
  const listeners = new Set<() => void>()
  return {
    manual: false,
    now: () => Date.now() + offset,
    advance(ms: number) {
      offset += ms
      for (const listener of [...listeners]) listener()
    },
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}
