import { createServer, type Server, type Socket } from "node:net"
import { type Redis, RedisConnectionError } from "./engine.ts"
import { asCommand, encodeReply, type Reply, RespParser } from "./protocol.ts"

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
    session.dead = true
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
