/**
 * Optional differential check against a real Redis or Valkey. The URL comes from the
 * environment (`.env.local` locally, the `REDIS_URL` repo secret in the parity workflow).
 * This script never prints that URL.
 */

import { connect, type Socket } from "node:net"
import { CredentialError, loadCredentials } from "@crvouga/mockingbird-credentials"
import { createRedis } from "../src/index.ts"
import { asCommand, encodeReply, type Reply, RespParser } from "../src/protocol.ts"

const spec = { provider: "redis", fields: { REDIS_URL: "REDIS_URL" } }

let url: string
try {
  const credentials = await loadCredentials(spec, { env: process.env })
  url = credentials.values.REDIS_URL
} catch (error) {
  if (error instanceof CredentialError) {
    console.error(`redis parity: ${error.message}`)
    process.exit(2)
  }
  throw error
}

const commands = ["PING", "SET parity 1", "GET parity", "INCR parity", "DEL parity"]

try {
  const real = await sendAll(url, commands)
  const redis = createRedis()
  const client = redis.client()
  const mock: string[] = []
  for (const command of commands) {
    const [name, ...args] = command.split(" ")
    if (!name) continue
    const reply = await client.raw(name, ...args)
    mock.push(Buffer.from(encodeReply(reply, 2)).toString("latin1"))
  }
  redis.close()
  const mismatches = commands.filter((_, index) => real[index] !== mock[index])
  if (mismatches.length > 0) {
    console.error(
      `redis parity: ${mismatches.length} command(s) diverged: ${mismatches.join(", ")}`,
    )
    process.exit(1)
  }
  console.log(`redis parity: ${commands.length} commands matched`)
} catch (error) {
  console.error(
    `redis parity: could not compare against REDIS_URL (${error instanceof Error ? error.name : "Error"})`,
  )
  process.exit(1)
}

function sendAll(target: string, commands: string[]): Promise<string[]> {
  const parsed = new URL(target)
  const port = parsed.port ? Number(parsed.port) : 6379
  return new Promise((resolve, reject) => {
    const socket: Socket = connect(port, parsed.hostname)
    const parser = new RespParser()
    const got: string[] = []
    socket.setTimeout(5000)
    socket.on("timeout", () => {
      socket.destroy()
      reject(new Error("timeout"))
    })
    socket.on("error", reject)
    const password = decodeURIComponent(parsed.password)
    const prefix = password ? 1 : 0
    socket.on("data", (chunk: Uint8Array) => {
      for (const reply of parser.push(chunk))
        got.push(Buffer.from(encodeReply(reply, 2)).toString("latin1"))
      if (got.length >= commands.length + prefix) {
        socket.end()
        resolve(got.slice(prefix, prefix + commands.length))
      }
    })
    socket.on("connect", () => {
      if (password) {
        socket.write(encodeCommand("AUTH", [password]))
      }
      for (const command of commands) {
        const [name, ...args] = command.split(" ")
        if (name) socket.write(encodeCommand(name, args))
      }
    })
  })
}

function encodeCommand(name: string, args: string[]): Uint8Array {
  const reply: Reply = {
    t: "array",
    v: [name, ...args].map((part) => ({ t: "bulk", v: Buffer.from(part) })),
  }
  const encoded = encodeReply(reply, 2)
  const parsed = new RespParser().push(encoded)
  const command = parsed[0] ? asCommand(parsed[0]) : null
  if (!command || "t" in command) return encoded
  return encoded
}
