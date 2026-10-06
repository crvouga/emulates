import { createConnection, createServer, type Server, type Socket } from "node:net"
import type { ConfigService, FleetChild } from "@emulators/adapter-node"
import { matchNamespacePath, resolveAdminPrefix } from "@emulators/service"
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

const isHealth = (pathname: string, adminPrefix: string): boolean => {
  const path = pathname.replace(/\/+$/, "") || "/"
  return (
    path === `${adminPrefix}/health` ||
    matchNamespacePath(path, adminPrefix)?.[2] === `${adminPrefix}/health`
  )
}

/**
 * Fleet entry for `serve --config`. HTTP `GET /__admin/health` reports `service: redis`.
 * RESP listens on an ephemeral port named in the startup banner.
 */
export const serveTarget = {
  name: "redis",
  protocol: "redis" as const,
  defaultPort: 6379,
  start: startProtocol,
  async create(
    _values: unknown = {},
    common: { adminPrefix?: string } = {},
  ): Promise<FleetRuntime> {
    const redis = createRedis()
    const tcp = await serve(redis, { host: "127.0.0.1", port: 0 })
    const runtime: FleetRuntime = {
      respPort: tcp.port,
      close: () => tcp.close(),
      fetch: async (request: Request) => {
        if (
          request.method === "GET" &&
          isHealth(new URL(request.url).pathname, resolveAdminPrefix(common.adminPrefix))
        ) {
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
  const namespaces = new Map<string, { redis: Redis; listener: RedisListening; database: number }>()
  const selectors = { default: 0, ...entry.namespaces }
  try {
    for (const [name, database] of Object.entries(selectors)) {
      if (!/^[A-Za-z0-9_.-]{1,64}$/.test(name)) throw new Error("invalid Redis namespace")
      if (
        typeof database !== "number" ||
        !Number.isInteger(database) ||
        database < 0 ||
        database > 15
      )
        throw new Error("invalid Redis database index")
      const redis = createRedis({
        ...(entry.password !== undefined ? { password: entry.password } : {}),
        ...(entry.seed !== undefined ? { seed: Number(entry.seed) } : {}),
      })
      const listener = await serve(redis, {
        host: entry.host ?? "127.0.0.1",
        port: name === "default" ? (entry.port ?? 6379) : 0,
      })
      namespaces.set(name, { redis, listener, database })
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
    const { listener, database } = get(name)
    const host = listener.host.includes(":") ? `[${listener.host}]` : listener.host
    const auth =
      privateUrl && entry.password !== undefined ? `:${encodeURIComponent(entry.password)}@` : ""
    return `redis://${auth}${host}:${listener.port}/${database}`
  }
  return {
    protocol: "redis",
    url: url("default"),
    connection: url("default", true),
    connections: Object.fromEntries([...namespaces.keys()].map((name) => [name, url(name, true)])),
    namespaces: {
      mechanism: "endpoint",
      endpoints: Object.fromEntries([...namespaces.keys()].map((name) => [name, url(name)])),
    },
    async ready() {
      return (
        await Promise.all(
          [...namespaces.values()].map(({ listener, database }) =>
            probe(listener, database, entry.password),
          ),
        )
      ).every(Boolean)
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
        activeJobs: redis.activeJobs(),
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

/** Readiness checks the actual RESP listener, including configured authentication and SELECT. */
function probe(
  listener: RedisListening,
  database: number,
  password: string | undefined,
): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: listener.host, port: listener.port })
    const parser = new RespParser()
    const commands = [
      ...(password !== undefined ? [["AUTH", password]] : []),
      ["SELECT", String(database)],
      ["PING"],
    ]
    const expected = commands.map((command) => (command[0] === "PING" ? "PONG" : "OK"))
    let result = false
    const finish = (ok: boolean) => {
      result = ok
      socket.destroy()
    }
    const timeout = setTimeout(() => finish(false), 2000)
    socket.once("close", () => {
      clearTimeout(timeout)
      resolve(result)
    })
    socket.on("error", () => finish(false))
    socket.once("connect", () => {
      for (const command of commands)
        socket.write(
          `*${command.length}\r\n${command.map((arg) => `$${Buffer.byteLength(arg)}\r\n${arg}\r\n`).join("")}`,
        )
    })
    socket.on("data", (data) => {
      try {
        for (const reply of parser.push(data)) {
          if (reply.t !== "simple" || reply.v !== expected.shift()) {
            finish(false)
            return
          }
          if (expected.length === 0) {
            finish(true)
            return
          }
        }
      } catch {
        finish(false)
      }
    })
  })
}
