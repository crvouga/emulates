/// <reference types="node" />
import type { IncomingMessage, ServerResponse } from "node:http"
import { Agent, createServer } from "node:https"
import type { Socket } from "node:net"
import { connect as tlsConnect } from "node:tls"
import { type FcmAccessCredential, fcmCredential } from "./index.js"
import { selfSignedCertificate } from "./tls.js"

/**
 * Local TLS material so firebase-admin can keep calling `fcm.googleapis.com` while the
 * bytes land on the mock. Generated in memory; not a credential for any Google project.
 */
const { cert: CERT, key: KEY } = selfSignedCertificate(["fcm.googleapis.com"])

export type AdminTransport = {
  credential: FcmAccessCredential
  agent: Agent
  port: number
  close(): Promise<void>
}

const skipHeader = (name: string) =>
  name === "host" ||
  name === "connection" ||
  name === "transfer-encoding" ||
  name === "content-length"

const forward = async (origin: string, req: IncomingMessage, body: Buffer, res: ServerResponse) => {
  const headers = new Headers()
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined || skipHeader(key.toLowerCase())) continue
    if (Array.isArray(value)) for (const item of value) headers.append(key, item)
    else headers.set(key, value)
  }
  const method = req.method ?? "GET"
  if (body.length > 0) headers.set("content-length", String(body.length))
  try {
    const init: RequestInit = { method, headers }
    if (method !== "GET" && method !== "HEAD") init.body = new Uint8Array(body)
    const response = await fetch(new URL(req.url ?? "/", origin), init)
    const payload = Buffer.from(await response.arrayBuffer())
    const out: Record<string, string> = { "content-length": String(payload.length) }
    response.headers.forEach((value, key) => {
      if (key === "transfer-encoding" || key === "content-length" || key === "content-encoding")
        return
      out[key] = value
    })
    res.writeHead(response.status, out)
    res.end(payload)
  } catch {
    res.destroy()
  }
}

/**
 * HTTPS proxy plus an `https.Agent` whose sockets dial that proxy with TLS already
 * done. firebase-admin keeps its hardcoded `fcm.googleapis.com` host and uses the
 * agent only when `enableLegacyHttpTransport()` is on (`send` is already HTTP/1.1).
 * Pass `origin` as the HTTP mock (`createServer().url`).
 */
export const createAdminTransport = async (options: {
  origin: string
  token?: string
}): Promise<AdminTransport> => {
  const server = createServer({ key: KEY, cert: CERT }, (req, res) => {
    const chunks: Buffer[] = []
    req.on("data", (chunk: Buffer) => {
      chunks.push(chunk)
    })
    req.on("end", () => {
      void forward(options.origin, req, Buffer.concat(chunks), res)
    })
  })
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve())
  })
  const address = server.address()
  const port = typeof address === "object" && address ? address.port : 0
  const agent = new Agent({ keepAlive: false })
  agent.createConnection = () =>
    tlsConnect({
      host: "127.0.0.1",
      port,
      rejectUnauthorized: false,
      servername: "fcm.googleapis.com",
    }) as Socket
  return {
    credential: fcmCredential(options.token ?? "fixture-token"),
    agent,
    port,
    close: async () => {
      agent.destroy()
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error && (error as { code?: string }).code !== "ERR_SERVER_NOT_RUNNING") reject(error)
          else resolve()
        })
        server.closeAllConnections?.()
      })
    },
  }
}
