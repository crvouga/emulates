/// <reference types="node" />
import { createHash } from "node:crypto"
import type { IncomingMessage, Server } from "node:http"
import type { Socket } from "node:net"
import {
  bindSocketTransport,
  claimSocketTicket,
  markSocketClosed,
  openSocketCount,
  type SocketRecord,
  unbindSocketTransport,
} from "./sockets.js"

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
/** Under Socket Mode's default 30s server-ping timeout, and frequent enough to test quickly. */
const SERVER_PING_MS = 2_000
const MAX_FRAME = 1_000_000
const HOST = "applink-mockingbird"

const attached = new WeakSet<Server>()

const encodeFrame = (opcode: number, payload: Buffer): Buffer => {
  const length = payload.length
  let header: Buffer
  if (length < 126) {
    header = Buffer.alloc(2)
    header[1] = length
  } else if (length < 65_536) {
    header = Buffer.alloc(4)
    header[1] = 126
    header.writeUInt16BE(length, 2)
  } else {
    header = Buffer.alloc(10)
    header[1] = 127
    header.writeBigUInt64BE(BigInt(length), 2)
  }
  header[0] = 0x80 | opcode
  return Buffer.concat([header, payload])
}

const acceptKey = (key: string): string =>
  createHash("sha1")
    .update(key + GUID)
    .digest("base64")

const rejectHttp = (socket: Socket, status: number, reason: string): void => {
  const body = Buffer.from(reason)
  socket.end(
    `HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Type: text/plain\r\nContent-Length: ${body.length}\r\n\r\n${reason}`,
  )
}

const startedAt = (ms: number): string =>
  new Date(ms).toISOString().replace("T", " ").replace("Z", "")

type Session = {
  ticket: string
  socket: Socket
  done: boolean
  ping: ReturnType<typeof setInterval> | undefined
  lifetime: ReturnType<typeof setTimeout> | undefined
  hello: ReturnType<typeof setTimeout> | undefined
}

const live = new Map<string, Session>()

const createParser = (onFrame: (opcode: number, data: Buffer) => void, onError: () => void) => {
  let buffer = Buffer.alloc(0) as Buffer
  let fragments: Buffer[] = []
  let fragmentOpcode = 0
  return {
    push(chunk: Buffer) {
      buffer = Buffer.concat([buffer, chunk])
      if (buffer.length > MAX_FRAME) {
        onError()
        return
      }
      for (;;) {
        if (buffer.length < 2) return
        const first = buffer[0] ?? 0
        const second = buffer[1] ?? 0
        if ((first & 0x70) !== 0) {
          onError()
          return
        }
        const fin = (first & 0x80) !== 0
        const opcode = first & 0x0f
        const masked = (second & 0x80) !== 0
        let length = second & 0x7f
        let offset = 2
        if (length === 126) {
          if (buffer.length < 4) return
          length = buffer.readUInt16BE(2)
          offset = 4
        } else if (length === 127) {
          if (buffer.length < 10) return
          const wide = buffer.readBigUInt64BE(2)
          if (wide > BigInt(MAX_FRAME)) {
            onError()
            return
          }
          length = Number(wide)
          offset = 10
        }
        if (length > MAX_FRAME) {
          onError()
          return
        }
        const maskLength = masked ? 4 : 0
        if (buffer.length < offset + maskLength + length) return
        const raw = buffer.subarray(offset + maskLength, offset + maskLength + length)
        let payload: Buffer
        if (masked) {
          const mask = buffer.subarray(offset, offset + 4)
          payload = Buffer.alloc(length)
          for (let i = 0; i < length; i++) payload[i] = (raw[i] ?? 0) ^ (mask[i % 4] ?? 0)
        } else payload = Buffer.from(raw)
        buffer = Buffer.from(buffer.subarray(offset + maskLength + length))
        if (opcode === 0x0) {
          if (fragmentOpcode === 0) {
            onError()
            return
          }
          fragments.push(payload)
          if (fin) {
            const message = Buffer.concat(fragments)
            const op = fragmentOpcode
            fragments = []
            fragmentOpcode = 0
            onFrame(op, message)
          }
          continue
        }
        if (opcode === 0x1 || opcode === 0x2) {
          if (!fin) {
            fragmentOpcode = opcode
            fragments = [payload]
          } else onFrame(opcode, payload)
          continue
        }
        onFrame(opcode, payload)
      }
    },
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const writeFrame = (socket: Socket, opcode: number, payload: Buffer): void => {
  if (socket.destroyed || !socket.writable) return
  socket.write(encodeFrame(opcode, payload))
}

const helloBody = (record: SocketRecord, approximate: number) =>
  JSON.stringify({
    type: "hello",
    num_connections: openSocketCount(record.namespace),
    debug_info: {
      host: HOST,
      started: startedAt(Date.now()),
      build_number: 1,
      approximate_connection_time: approximate,
    },
    connection_info: { app_id: record.appId },
  })

const disconnectBody = (reason: string) =>
  JSON.stringify({ type: "disconnect", reason, debug_info: { host: HOST } })

const acceptUpgrade = (
  req: IncomingMessage,
  socket: Socket,
  head: Buffer,
  owned: Set<string>,
): void => {
  const url = new URL(req.url ?? "/", "http://localhost")
  if (url.pathname !== "/link" && url.pathname !== "/link/") {
    rejectHttp(socket, 404, "not_found")
    return
  }
  const ticket = url.searchParams.get("ticket")
  const key = req.headers["sec-websocket-key"]
  if (!ticket || typeof key !== "string" || key.length === 0) {
    rejectHttp(socket, 400, "bad_request")
    return
  }
  const record = claimSocketTicket(ticket)
  if (!record) {
    rejectHttp(socket, 404, "ticket_used")
    return
  }
  socket.setNoDelay(true)
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n` +
      "\r\n",
  )
  const session: Session = {
    ticket,
    socket,
    done: false,
    ping: undefined,
    lifetime: undefined,
    hello: undefined,
  }
  live.set(ticket, session)
  owned.add(ticket)
  const cleanup = () => {
    if (session.done) return
    session.done = true
    if (session.ping) clearInterval(session.ping)
    if (session.lifetime) clearTimeout(session.lifetime)
    if (session.hello) clearTimeout(session.hello)
    live.delete(ticket)
    owned.delete(ticket)
    unbindSocketTransport(ticket)
    markSocketClosed(ticket)
  }
  const finish = (code: number) => {
    if (session.done) return
    if (code === 1006) socket.destroy()
    else {
      const payload = Buffer.alloc(2)
      payload.writeUInt16BE(code, 0)
      writeFrame(socket, 0x8, payload)
      socket.end()
    }
    cleanup()
  }
  bindSocketTransport(ticket, {
    disconnect(reason, code) {
      if (session.done) return
      writeFrame(socket, 0x1, Buffer.from(disconnectBody(reason)))
      const timer = setTimeout(() => finish(code), 20)
      timer.unref()
    },
    destroy() {
      socket.destroy()
      cleanup()
    },
  })
  const parser = createParser(
    (opcode, data) => {
      if (session.done) return
      if (opcode === 0x8) {
        finish(1000)
        return
      }
      if (opcode === 0x9) {
        writeFrame(socket, 0xa, data)
        return
      }
      if (opcode !== 0x1) return
      let parsed: unknown
      try {
        parsed = JSON.parse(data.toString("utf8"))
      } catch {
        return
      }
      // An acknowledgement. Socket Mode does not reply, and a stray ack must not drop the socket.
      if (isRecord(parsed) && typeof parsed.envelope_id === "string" && parsed.type === undefined)
        return
    },
    () => finish(1002),
  )
  socket.on("data", (chunk: Buffer | string) => {
    if (session.done) return
    parser.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk)
  })
  socket.on("close", cleanup)
  socket.on("error", cleanup)
  socket.on("end", cleanup)
  if (head.length > 0) parser.push(head)

  const approximate =
    url.searchParams.get("debug_reconnects") === "true"
      ? 360
      : record.lifetimeMs !== null && record.lifetimeMs > 0
        ? Math.max(1, Math.ceil(record.lifetimeMs / 1000))
        : 3600
  const deliverHello = () => {
    if (session.done) return
    const frame = Buffer.from(helloBody(record, approximate))
    socket.write(encodeFrame(0x1, frame), () => {
      if (session.done) return
      if (record.abnormalClose) {
        socket.destroy()
        cleanup()
        return
      }
      if (record.closeAfterHello) {
        finish(1000)
        return
      }
      session.ping = setInterval(() => {
        if (session.done) return
        writeFrame(socket, 0x9, Buffer.from("ping"))
      }, SERVER_PING_MS)
      session.ping.unref()
      if (record.lifetimeMs !== null && record.lifetimeMs > 0) {
        session.lifetime = setTimeout(() => {
          if (session.done) return
          writeFrame(socket, 0x1, Buffer.from(disconnectBody("warning")))
          const timer = setTimeout(() => finish(1000), 20)
          timer.unref()
        }, record.lifetimeMs)
        session.lifetime.unref()
      }
    })
  }
  if (record.helloLatencyMs > 0) {
    session.hello = setTimeout(deliverHello, record.helloLatencyMs)
    session.hello.unref()
  } else deliverHello()
}

/** Accept Socket Mode WebSocket upgrades on a Node HTTP server. Idempotent per server. */
export const attachSocketServer = (server: Server): void => {
  if (attached.has(server)) return
  attached.add(server)
  const owned = new Set<string>()
  server.on("upgrade", (req, socket, head) => {
    acceptUpgrade(req, socket as Socket, head, owned)
  })
  server.on("close", () => {
    for (const ticket of owned) live.get(ticket)?.socket.destroy()
    owned.clear()
  })
}
