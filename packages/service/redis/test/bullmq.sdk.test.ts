import { expect, test } from "bun:test"
import { DelayedError, FlowProducer, Queue, QueueEvents, UnrecoverableError, Worker } from "bullmq"
import { Redis as IORedis } from "ioredis"
import { createRedis } from "../src/index.ts"
import { serve } from "../src/server.ts"

test("BullMQ 5.67 Queue, Worker and QueueEvents complete a job and close", async () => {
  const redis = createRedis()
  const server = await serve(redis, { port: 0 })
  const connection = { host: server.host, port: server.port, maxRetriesPerRequest: null }
  const queue = new Queue("compat", { connection })
  const events = new QueueEvents("compat", { connection })
  const worker = new Worker("compat", async (job) => ({ value: job.data.value + 1 }), { connection })
  const errors: Error[] = []
  for (const client of [queue, events, worker]) client.on("error", (error) => errors.push(error))
  try {
    await events.waitUntilReady()
    const job = await queue.add("increment", { value: 7 })
    expect(await job.waitUntilFinished(events, 2000)).toEqual({ value: 8 })
    expect(await job.getState()).toBe("completed")
    expect(errors).toEqual([])
  } finally {
    await worker.close(true)
    await events.close()
    await queue.close()
    await server.close()
  }
  expect(redis.waiterCount()).toBe(0)
}, 5000)

async function manual(run: (queue: Queue, worker: Worker, redis: ReturnType<typeof createRedis>, connection: { host: string; port: number; maxRetriesPerRequest: null }) => Promise<void>) {
  const redis = createRedis()
  const server = await serve(redis, { port: 0 })
  const connection = { host: server.host, port: server.port, maxRetriesPerRequest: null }
  const queue = new Queue("manual", { connection })
  const worker = new Worker("manual", undefined, { connection, autorun: false })
  try { await run(queue, worker, redis, connection) }
  finally { await worker.close(true); await queue.close(); await server.close() }
}

test("BullMQ delayed jobs, backoff and attempts follow an injected client/server clock", async () => {
  await manual(async (queue, worker, redis) => {
    const original = Date.now
    let time = original()
    Date.now = () => time
    redis.clock.freeze(); redis.clock.set(time)
    try {
      const late = await queue.add("late", {}, { delay: 2000 })
      const early = await queue.add("early", {}, { delay: 1000, attempts: 3, backoff: { type: "fixed", delay: 500 } })
      expect(await worker.getNextJob("owner", { block: false })).toBeUndefined()
      time += 1000; redis.advance(1000)
      const first = await worker.getNextJob("owner", { block: false })
      expect(first?.id).toBe(early.id)
      await first?.moveToFailed(new Error("retry fixture"), "owner", false)
      expect(await early.getState()).toBe("delayed")
      time += 500; redis.advance(500)
      const retry = await worker.getNextJob("retry-owner", { block: false })
      expect(retry?.attemptsMade).toBe(1)
      await retry?.moveToCompleted("done", "retry-owner", false)
      time += 500; redis.advance(500)
      const last = await worker.getNextJob("last-owner", { block: false })
      expect(last?.id).toBe(late.id)
      await last?.moveToCompleted("done", "last-owner", false)
    } finally { Date.now = original }
  })
})

test("BullMQ duplicate IDs, deduplication, auto removal and NOSCRIPT recovery", async () => {
  await manual(async (queue, worker, redis, connection) => {
    const one = await queue.add("one", { value: 1 }, { jobId: "unique", removeOnComplete: true })
    const duplicate = await queue.add("two", { value: 2 }, { jobId: "unique" })
    expect(duplicate.id).toBe(one.id)
    const dedup = await queue.add("dedup", {}, { deduplication: { id: "fixture" } })
    const skipped = await queue.add("dedup", {}, { deduplication: { id: "fixture" } })
    expect(skipped.id).toBe(dedup.id)
    const client = new IORedis(connection)
    try { await client.script("FLUSH") } finally { client.disconnect() }
    redis.fault("noscript")
    const job = await worker.getNextJob("owner", { block: false })
    expect(job?.id).toBe("unique")
    await job?.moveToCompleted("ok", "owner", false)
    expect(await queue.getJob("unique")).toBeUndefined()
  })
})

test("BullMQ two workers, lock ownership, renewal, stalled recovery and concurrency", async () => {
  await manual(async (queue, worker, redis, connection) => {
    const other = new Worker("manual", undefined, { connection, autorun: false })
    try {
      await queue.setGlobalConcurrency(1)
      const job = await queue.add("exclusive", {})
      await queue.add("next", {})
      const owner = await worker.getNextJob("owner", { block: false })
      expect(owner?.id).toBe(job.id)
      expect(await other.getNextJob("other", { block: false })).toBeUndefined()
      expect(await owner?.extendLock("owner", 1000)).toBe(1)
      expect(await owner?.extendLock("wrong", 1000)).toBe(0)
      redis.advance(1001)
      await worker.scripts.moveStalledJobsToWait()
      redis.advance(30001)
      await worker.scripts.moveStalledJobsToWait()
      expect(await job.getState()).toBe("waiting")
      const recovered = await other.getNextJob("recovered", { block: false })
      expect(recovered?.id).toBe(job.id)
      await recovered?.moveToCompleted("ok", "recovered", false)
    } finally { await other.close(true) }
  })
})

test("BullMQ flow dependencies release a parent after its child completes", async () => {
  await manual(async (queue, worker, _redis, connection) => {
    const flow = new FlowProducer({ connection })
    try {
      const result = await flow.add({ name: "parent", queueName: queue.name, data: {},
        children: [{ name: "child", queueName: queue.name, data: {} }] })
      expect(await result.job.getState()).toBe("waiting-children")
      const child = await worker.getNextJob("child-owner", { block: false })
      expect(child?.name).toBe("child")
      await child?.moveToCompleted("child result", "child-owner", false)
      const parent = await worker.getNextJob("parent-owner", { block: false })
      expect(parent?.id).toBe(result.job.id)
      expect(Object.values(await parent?.getChildrenValues() ?? {})).toEqual(["child result"])
      await parent?.moveToCompleted("parent result", "parent-owner", false)
    } finally { await flow.close() }
  })
})

test("BullMQ worker treats retryable, DelayedError and UnrecoverableError separately", async () => {
  const redis = createRedis()
  const server = await serve(redis, { port: 0 })
  const connection = { host: server.host, port: server.port, maxRetriesPerRequest: null }
  const queue = new Queue("errors", { connection })
  const events = new QueueEvents("errors", { connection })
  let delayed = false
  const worker = new Worker("errors", async (job, token) => {
    if (job.name === "fatal") throw new UnrecoverableError("fixture fatal")
    if (job.name === "retry" && job.attemptsMade === 0) throw new Error("fixture retry")
    if (job.name === "delayed" && !delayed) {
      delayed = true
      await job.moveToDelayed(Date.now(), token)
      throw new DelayedError()
    }
    return "ok"
  }, { connection })
  const errors: Error[] = []
  for (const client of [queue, events, worker]) client.on("error", (error) => errors.push(error))
  try {
    await events.waitUntilReady()
    const retry = await queue.add("retry", {}, { attempts: 3 })
    expect(await retry.waitUntilFinished(events, 2000)).toBe("ok")
    expect((await queue.getJob(retry.id as string))?.attemptsMade).toBe(2)
    const moved = await queue.add("delayed", {}, { attempts: 3 })
    expect(await moved.waitUntilFinished(events, 2000)).toBe("ok")
    expect((await queue.getJob(moved.id as string))?.attemptsMade).toBe(1)
    const fatal = await queue.add("fatal", {}, { attempts: 3 })
    expect(fatal.waitUntilFinished(events, 2000)).rejects.toThrow("fixture fatal")
    // Await the failure before tearing down the QueueEvents connection.
    try { await fatal.waitUntilFinished(events, 2000) } catch { /* expected */ }
    expect((await queue.getJob(fatal.id as string))?.attemptsMade).toBe(1)
    expect(errors).toEqual([])
  } finally { await worker.close(true); await events.close(); await queue.close(); await server.close() }
}, 10000)
