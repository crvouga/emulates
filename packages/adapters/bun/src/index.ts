import type { FetchAPI } from "@emulators/core"

/** Options for {@link serve}. */
export type BunServeOptions = {
  port?: number
  hostname?: string
}

export type BunAdapterServer = ReturnType<typeof Bun.serve>

/**
 * Serve any Emulators {@link FetchAPI} over `Bun.serve`.
 * Port defaults to `0`, so the OS assigns an ephemeral port (read from `server.port`).
 */
export const serve = (api: FetchAPI, options: BunServeOptions = {}): BunAdapterServer => {
  return Bun.serve({
    port: options.port ?? 0,
    ...(options.hostname !== undefined ? { hostname: options.hostname } : {}),
    fetch: (request) => api.fetch(request),
  })
}
