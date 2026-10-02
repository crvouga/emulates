import { FlowProducer, Queue, QueueEvents, UnrecoverableError, Worker } from "bullmq"
import { Redis } from "ioredis"

export const admissionScript = `
  if redis.call('GET', KEYS[2]) then return 0 end
  redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1] - 1000)
  if redis.call('ZCARD', KEYS[1]) >= 2 then return -1 end
  redis.call('ZADD', KEYS[1], ARGV[1], ARGV[2])
  redis.call('PEXPIRE', KEYS[1], 1000)
  redis.call('SET', KEYS[2], 'fixture', 'PX', 1000)
  return 1
`

/** Identical unmodified public-client walk for the mock and a native Redis oracle. */
export async function bullmqContract(connection: {
  host: string
  port: number
  maxRetriesPerRequest: null
}) {
  const queue = new Queue("contract", { connection })
  const events = new QueueEvents(queue.name, { connection })
  const worker = new Worker(queue.name, undefined, { connection, autorun: false })
  const flow = new FlowProducer({ connection })
  const contenders = [new Redis(connection), new Redis(connection), new Redis(connection)]
  const errors: string[] = []
  const onError = (error: Error) => errors.push(error.message)
  queue.on("error", onError)
  events.on("error", onError)
  worker.on("error", onError)
  flow.on("error", onError)
  try {
    await events.waitUntilReady()
    await queue.pause()
    await queue.add("paused", {}, { jobId: "job-paused" })
    const paused = await queue.isPaused()
    await queue.resume()
    const active = await worker.getNextJob("owner", { block: false })
    if (!active) throw new Error("no active fixture job")
    const completion = active.waitUntilFinished(events, 2000)
    await active.moveToCompleted({ value: 7 }, "owner", false)
    const completed = await completion
    const same = await queue.add("different", {}, { jobId: "job-paused" })
    const original = await queue.getJob(same.id as string)
    const dedup = await queue.add("dedup", {}, { deduplication: { id: "fixture" } })
    const duplicate = await queue.add("dedup", {}, { deduplication: { id: "fixture" } })
    const one = await worker.getNextJob("dedup-owner", { block: false })
    await one.moveToCompleted("ok", "dedup-owner", false)

    const delayed = await queue.add(
      "delayed",
      {},
      { delay: 60_000, attempts: 3, backoff: { type: "fixed", delay: 60_000 } },
    )
    const delayedState = await delayed.getState()
    await delayed.promote()
    const retry = await worker.getNextJob("retry", { block: false })
    await retry.moveToFailed(new Error("fixture retry"), "retry", false)
    const backoffState = await delayed.getState()
    await delayed.promote()
    const second = await worker.getNextJob("second", { block: false })
    const attemptsMade = second.attemptsMade
    await second.moveToCompleted("ok", "second", false)

    const fatal = await queue.add("fatal", {}, { attempts: 3 })
    const failed = await worker.getNextJob("fatal", { block: false })
    await failed.moveToFailed(new UnrecoverableError("fixture fatal"), "fatal", false)
    const failedJob = await queue.getJob(fatal.id as string)
    await queue.add("removed", {}, { jobId: "removed", removeOnComplete: true })
    const removed = await worker.getNextJob("removed", { block: false })
    await removed.moveToCompleted("ok", "removed", false)

    const parent = await flow.add({
      name: "parent",
      queueName: queue.name,
      data: {},
      opts: { jobId: "parent" },
      children: [{ name: "child", queueName: queue.name, data: {}, opts: { jobId: "child" } }],
    })
    const parentBefore = await parent.job.getState()
    const child = await worker.getNextJob("child", { block: false })
    await child.moveToCompleted("child result", "child", false)
    const parentJob = await worker.getNextJob("parent", { block: false })
    const childValues = Object.values(await parentJob.getChildrenValues())
    await parentJob.moveToCompleted("ok", "parent", false)

    const client = await queue.client
    await client.script("FLUSH")
    await queue.add("reloaded", {}, { jobId: "reload" })
    const reloaded = await worker.getNextJob("reload", { block: false })
    await reloaded.moveToCompleted("ok", "reload", false)
    await Promise.all(contenders.map((client) => client.ping()))
    const now = Date.now()
    const codes = await Promise.all(
      contenders.map((client) =>
        client.eval(admissionScript, 2, "admission-window", "admission-receipt", now, "first"),
      ),
    )
    const secondAdmission = await client.eval(
      admissionScript,
      2,
      "admission-window",
      "admission-second",
      now,
      "second",
    )
    const rejectedAdmission = await client.eval(
      admissionScript,
      2,
      "admission-window",
      "admission-third",
      now,
      "third",
    )
    const receiptTtl = await client.pttl("admission-receipt")
    const admission = {
      codes: codes.sort((a, b) => Number(b) - Number(a)),
      secondAdmission,
      rejectedAdmission,
      windowSize: await client.zcard("admission-window"),
      rejectedReceipt: await client.get("admission-third"),
      receiptHasTtl: receiptTtl > 0 && receiptTtl <= 1000,
    }
    return {
      admission,
      paused,
      completed,
      duplicateName: original?.name,
      deduplicated: dedup.id === duplicate.id,
      delayedState,
      backoffState,
      attemptsMade,
      fatalState: await fatal.getState(),
      fatalAttempts: failedJob?.attemptsMade,
      removed: (await queue.getJob("removed")) === undefined,
      parentBefore,
      childValues,
      reloadState: await reloaded.getState(),
      errors,
    }
  } finally {
    for (const client of contenders) client.disconnect()
    await worker.close(true)
    await events.close()
    await queue.close()
    await flow.close()
  }
}
