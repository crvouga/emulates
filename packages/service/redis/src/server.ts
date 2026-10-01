import { createServer, type Server, type Socket } from "node:net"
import type { ConfigService, FleetChild } from "@crvouga/mockingbird-adapter-node"
import { createRedis, type Redis, RedisConnectionError } from "./engine.ts"
import { asCommand, encodeReply, type Reply, RespParser } from "./protocol.ts"

/** HTTP port for `serve --config`. The RESP socket binds an ephemeral port. */
export const DEFAULT_PORT = 8827

export interface ServeOptions {
  port?: number
  host?: string
}

export interface RedisListening {
  host: string
  port: number
  close(): Promise<void>
}

export function serve(redis: Redis, options: ServeOptions = {}): Promise<RedisListening> {
  const host = options.host ?? "127.0.0.1"
  const port = options.port ?? 6379
  const sockets = new Set<Socket>()
  const server = createServer({ keepAlive: true }, (socket) => {
    sockets.add(socket)
    attach(redis, socket, () => sockets.delete(socket))
  })
  return new Promise((resolve, reject) => {
    const fail = (error: Error) => reject(error)
    server.once("error", fail)
    server.listen(port, host, () => {
      server.off("error", fail)
      const address = server.address()
      const actual = address && typeof address === "object" ? address.port : port
      resolve({
        host,
        port: actual,
        close: () => shutdown(server, sockets, redis),
      })
    })
  })
}

function attach(redis: Redis, socket: Socket, onGone: () => void): void {
  const session = redis.createSession()
  const parser = new RespParser()
  const pending: Array<{ name: string; args: Uint8Array[] }> = []
  let pumping = false
  const write = (reply: Reply) => {
    if (!socket.destroyed) socket.write(encodeReply(reply, session.protocol))
  }
  session.onPush = write
  const stop = redis.onDisconnect((dropped) => {
    if (dropped === session) socket.destroy()
  })
  const finish = () => {
    redis.disconnect(session)
    stop()
    onGone()
  }
  socket.on("data", (chunk: Uint8Array) => {
    for (const reply of parser.push(chunk)) {
      const command = asCommand(reply)
      if ("t" in command) {
        write(command)
        continue
      }
      pending.push(command)
    }
    void pump()
  })
  const pump = async () => {
    if (pumping) return
    pumping = true
    try {
      while (pending.length > 0) {
        const command = pending.shift()
        if (!command) break
        try {
          const reply = await redis.perform(session, command.name, command.args)
          write(reply)
          if (session.quit) {
            socket.end()
            break
          }
        } catch (error) {
          if (error instanceof RedisConnectionError) {
            socket.destroy()
            break
          }
          socket.destroy()
          break
        }
      }
    } finally {
      pumping = false
      if (pending.length > 0 && !socket.destroyed) void pump()
    }
  }
  socket.on("close", finish)
  socket.on("error", finish)
}

function shutdown(server: Server, sockets: Set<Socket>, redis: Redis): Promise<void> {
  redis.close()
  for (const socket of sockets) socket.destroy()
  return new Promise((resolve) => {
    server.close(() => resolve())
  })
}

type FleetRuntime = {
  fetch(request: Request): Promise<Response>
  respPort: number
  close(): Promise<void>
}

const isHealth = (pathname: string): boolean => {
  const path = pathname.replace(/\/+$/, "") || "/"
  return path === "/health" || /^\/ns\/[^/]+\/health$/.test(path)
}

/**
 * Fleet entry for `serve --config`. HTTP `GET /health` reports `service: redis`.
 * RESP listens on an ephemeral port named in the startup banner.
 */
export const serveTarget = {
  name: "redis",
  protocol: "redis" as const,
  defaultPort: 6379,
  start: startProtocol,
  async create(): Promise<FleetRuntime> {
    const redis = createRedis()
    const tcp = await serve(redis, { host: "127.0.0.1", port: 0 })
    const runtime: FleetRuntime = {
      respPort: tcp.port,
      close: () => tcp.close(),
      fetch: async (request: Request) => {
        if (isHealth(new URL(request.url).pathname)) {
          return Response.json({ status: "ok", service: "redis" })
        }
        return new Response("not found", { status: 404 })
      },
    }
    return runtime
  },
  banner(runtime: FleetRuntime) {
    return [`resp: redis://127.0.0.1:${runtime.respPort}`]
  },
}

/** Each fleet namespace owns a listener and an engine; Redis SELECT retains vendor semantics. */
async function startProtocol(entry: ConfigService): Promise<FleetChild> {
  const namespaces = new Map<string, { redis: Redis; listener: RedisListening }>()
  const selectors = { default: 0, ...entry.namespaces }
  try {
    for (const [name] of Object.entries(selectors)) {
      if (!/^[A-Za-z0-9_.-]{1,64}$/.test(name)) throw new Error("invalid Redis namespace")
      const redis = createRedis({
        ...(entry.password !== undefined ? { password: entry.password } : {}),
        ...(entry.seed !== undefined ? { seed: Number(entry.seed) } : {}),
      })
      const listener = await serve(redis, {
        host: entry.host ?? "127.0.0.1",
        port: name === "default" ? (entry.port ?? 6379) : 0,
      })
      namespaces.set(name, { redis, listener })
    }
  } catch (error) {
    await Promise.allSettled([...namespaces.values()].map(({ listener }) => listener.close()))
    throw error
  }
  const get = (name: string) => {
    const found = namespaces.get(name)
    if (!found) throw new Error(`Redis namespace ${name} is not configured`)
    return found
  }
  const url = (name: string, privateUrl = false) => {
    const { listener } = get(name)
    const host = listener.host.includes(":") ? `[${listener.host}]` : listener.host
    const auth =
      privateUrl && entry.password !== undefined ? `:${encodeURIComponent(entry.password)}@` : ""
    return `redis://${auth}${host}:${listener.port}`
  }
  return {
    protocol: "redis",
    url: url("default"),
    connection: url("default", true),
    namespaces: {
      mechanism: "endpoint",
      endpoints: Object.fromEntries([...namespaces.keys()].map((name) => [name, url(name)])),
    },
    async ready() {
      for (const { redis } of namespaces.values()) {
        const session = redis.createSession()
        try {
          if (entry.password !== undefined)
            await redis.perform(session, "AUTH", [new TextEncoder().encode(entry.password)])
          const reply = await redis.perform(session, "PING", [])
          if (reply.t !== "simple" || reply.v !== "PONG") return false
        } finally {
          redis.disconnect(session)
        }
      }
      return true
    },
    async close() {
      await Promise.all([...namespaces.values()].map(({ listener }) => listener.close()))
    },
    lock: (name) => get(name).redis.fence(),
    diagnostics(name) {
      const { redis } = get(name)
      return {
        activeRequests: redis.activeCommands(),
        activeConnections: redis.connections(),
        blockedCommands: redis.waiterCount(),
        pendingJobs: redis.pendingJobs(),
        pendingWebhooks: 0,
        unmatchedRequests: 0,
      }
    },
    async checkpoint(name) {
      return get(name).redis.snapshot()
    },
    async restore(name, point) {
      get(name).redis.restore(point)
    },
    async reset(name) {
      get(name).redis.reset()
    },
    clock: (name) => get(name).redis.clock,
  }
}
