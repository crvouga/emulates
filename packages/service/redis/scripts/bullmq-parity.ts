import { deepStrictEqual } from "node:assert"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { createServer } from "node:net"
import { Redis as IORedis } from "ioredis"
import { createRedis } from "../src/index.ts"
import { serve } from "../src/server.ts"
import { bullmqContract } from "../test/bullmq-contract.ts"

// Native local oracle: no account, credential or external service is required.
const reserve = createServer()
await new Promise<void>((resolve) => reserve.listen(0, "127.0.0.1", resolve))
const address = reserve.address()
if (!address || typeof address === "string") throw new Error("no oracle port")
const port = address.port
await new Promise<void>((resolve) => reserve.close(() => resolve()))
const oracle = spawn(
  "redis-server",
  ["--port", String(port), "--bind", "127.0.0.1", "--save", "", "--appendonly", "no"],
  { stdio: "ignore" },
)
let bootError: Error | undefined
oracle.on("error", (error) => {
  bootError = error
})
const probe = new IORedis({
  host: "127.0.0.1",
  port,
  maxRetriesPerRequest: null,
  connectTimeout: 2000,
  retryStrategy: (attempt) => (attempt < 20 ? 25 : null),
})
probe.on("error", () => {})
const mock = await serve(createRedis(), { port: 0 })
try {
  await probe.ping()
  if (bootError) throw bootError
  const version = (await probe.info("server")).match(/redis_version:([^\r\n]+)/)?.[1]
  const actual = await bullmqContract({
    host: mock.host,
    port: mock.port,
    maxRetriesPerRequest: null,
  })
  const expected = await bullmqContract({ host: "127.0.0.1", port, maxRetriesPerRequest: null })
  deepStrictEqual(actual, expected)
  console.log(
    `BullMQ 5.67.1: public Queue/Worker/QueueEvents/FlowProducer contract matches Redis ${version}`,
  )
} finally {
  probe.disconnect()
  await mock.close()
  if (oracle.exitCode === null && oracle.signalCode === null) {
    const exited = once(oracle, "exit")
    oracle.kill("SIGTERM")
    await exited
  }
}
