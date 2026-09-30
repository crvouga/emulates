import { afterEach, expect, test } from "bun:test"
import { Redis } from "ioredis"
import { createRedis } from "../src/index.ts"
import { serve } from "../src/server.ts"

let closeServer: (() => Promise<void>) | undefined

afterEach(async () => {
  await closeServer?.()
  closeServer = undefined
})

test("ioredis 5.11.1 speaks to the TCP server", async () => {
  const redis = createRedis()
  const listening = await serve(redis, { port: 0, host: "127.0.0.1" })
  closeServer = () => listening.close()
  const client = new Redis({
    host: listening.host,
    port: listening.port,
    lazyConnect: true,
    retryStrategy: () => null,
    maxRetriesPerRequest: 1,
    connectTimeout: 2_000,
  })
  await client.connect()
  expect(await client.ping()).toBe("PONG")
  expect(await client.set("k", "v")).toBe("OK")
  expect(await client.get("k")).toBe("v")
  const piped = await client.pipeline().set("a", "1").incr("a").exec()
  expect(piped).toEqual([
    [null, "OK"],
    [null, 2],
  ])
  const multi = await client.multi().set("b", "1").get("b").exec()
  expect(multi).toEqual([
    [null, "OK"],
    [null, "1"],
  ])
  const message = new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("no pubsub message")), 1_000)
    client.once("message", (_channel, payload) => {
      clearTimeout(timer)
      resolve(payload)
    })
  })
  await client.subscribe("ch")
  const other = new Redis({
    host: listening.host,
    port: listening.port,
    lazyConnect: true,
    retryStrategy: () => null,
    maxRetriesPerRequest: 1,
  })
  await other.connect()
  expect(await other.publish("ch", "hi")).toBe(1)
  expect(await message).toBe("hi")
  await other.quit()
  await client.quit()
})
