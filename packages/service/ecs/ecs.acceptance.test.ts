import { expect, test } from "bun:test"
import { createClock } from "@crvouga/mockingbird-service"
import { createRuntime, DEFAULT_CLUSTER, DEFAULT_TASK_DEFINITION } from "./src/index.js"
import { createServer } from "./src/server.js"
import { call, input } from "./test/consumer.js"

const admin = (
  runtime: ReturnType<typeof createRuntime>,
  path: string,
  body?: unknown,
  method = "POST",
) =>
  runtime.fetch(
    new Request(`http://mock.local/__admin/${path}`, {
      method,
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  )
test("accepted tasks preserve seeded ARNs, overrides, count and mock time without execution", async () => {
  const runtime = createRuntime({ clock: createClock(() => 1700000000000) })
  const data = await (await call(runtime.fetch, { ...input, count: 2 })).json()
  expect(data.failures).toEqual([])
  expect(data.tasks).toHaveLength(2)
  expect(new Set(data.tasks.map((t: { taskArn: string }) => t.taskArn)).size).toBe(2)
  expect(data.tasks[0]).toMatchObject({
    clusterArn: DEFAULT_CLUSTER.clusterArn,
    taskDefinitionArn: DEFAULT_TASK_DEFINITION.taskDefinitionArn,
    overrides: input.overrides,
    createdAt: 1700000000,
    lastStatus: "PROVISIONING",
  })
  expect(runtime.instance().tasks.list()).toHaveLength(2)
  expect(runtime.instance().requests.list()[0]?.value.networkConfiguration).toEqual(
    input.networkConfiguration,
  )
})
test("missing resources and invalid inputs never accept tasks; seeded failures stay separate", async () => {
  const runtime = createRuntime()
  for (const [body, code] of [
    [{ ...input, cluster: "missing" }, "ClusterNotFoundException"],
    [{ ...input, taskDefinition: "missing" }, "ClientException"],
    [{ ...input, count: 11 }, "InvalidParameterException"],
    [{ ...input, networkConfiguration: {} }, "InvalidParameterException"],
    [
      { ...input, overrides: { containerOverrides: [{ name: "missing" }] } },
      "InvalidParameterException",
    ],
  ] as const) {
    const res = await call(runtime.fetch, body)
    expect(res.status).toBe(400)
    expect((await res.json()).__type).toBe(code)
  }
  expect(runtime.instance().tasks.list()).toHaveLength(0)
  await admin(runtime, "state/placementFailures", {
    id: "capacity",
    value: {
      arn: DEFAULT_CLUSTER.clusterArn,
      reason: "RESOURCE:MEMORY",
      detail: "Scripted placement failure",
    },
  })
  const partial = await (await call(runtime.fetch, { ...input, count: 2 })).json()
  expect(partial.tasks).toHaveLength(1)
  expect(partial.failures).toHaveLength(1)
  expect(runtime.instance().tasks.list()).toHaveLength(1)
})
test("clientToken replays the result and conflicts do not create more tasks", async () => {
  const runtime = createRuntime()
  const body = { ...input, clientToken: "fixture-token" }
  const first = await (await call(runtime.fetch, body)).json()
  expect(await (await call(runtime.fetch, body)).json()).toEqual(first)
  const conflict = await call(runtime.fetch, { ...body, count: 2 })
  expect(conflict.status).toBe(400)
  expect((await conflict.json()).resourceIds).toEqual(
    first.tasks.map((t: { taskArn: string }) => t.taskArn),
  )
  expect(runtime.instance().tasks.list()).toHaveLength(1)
})
test("namespace carriers, reset and Timeline isolate accepted tasks; journal omits bodies and credentials", async () => {
  const runtime = createRuntime()
  await call(runtime.fetch, input, { "x-mockingbird-namespace": "alpha" })
  expect(runtime.instance("alpha").tasks.list()).toHaveLength(1)
  expect(runtime.instance().tasks.list()).toHaveLength(0)
  await admin(runtime, "credentials", { credentials: { fixture: "alpha" } }, "PUT")
  await call(runtime.fetch, input, {
    authorization:
      "AWS4-HMAC-SHA256 Credential=fixture/20260101/us-east-1/ecs/aws4_request, SignedHeaders=host, Signature=mock",
  })
  expect(runtime.instance("alpha").tasks.list()).toHaveLength(2)
  const prefixed = (r: Request) =>
    runtime.fetch(new Request(r.url.replace("mock.local/", "mock.local/__admin/ns/alpha/"), r))
  await call(prefixed)
  expect(runtime.instance("alpha").tasks.list()).toHaveLength(3)
  await runtime.instance("alpha").reset()
  expect(runtime.instance("alpha").tasks.list()).toHaveLength(0)
  await call(runtime.fetch)
  const checkpoint = await (await admin(runtime, "snapshots")).json()
  await call(runtime.fetch)
  await admin(runtime, `snapshots/${checkpoint.id}/restore`)
  expect(runtime.instance().tasks.list()).toHaveLength(1)
  const journal = await (await admin(runtime, "requests", undefined, "GET")).text()
  expect(journal).not.toContain("Signature=mock")
  expect(journal).not.toContain("containerOverrides")
})
test("all presets return AWS errors or disconnect without accepting tasks", async () => {
  const runtime = createRuntime()
  for (const [preset, status] of [
    ["access_denied", 400],
    ["throttled", 400],
    ["rate_limited", 429],
    ["internal_error", 500],
  ] as const) {
    await admin(runtime, "faults", { preset, count: 1 })
    expect((await call(runtime.fetch)).status).toBe(status)
  }
  await admin(runtime, "faults", { preset: "connection_drop", count: 1 })
  await expect(call(runtime.fetch)).rejects.toThrow()
  expect(runtime.instance().tasks.list()).toHaveLength(0)
})
test("served HTTP exposes RunTask and standard controls", async () => {
  const server = await createServer()
  try {
    expect((await fetch(server.url + "/__admin/health")).status).toBe(200)
    const res = await call((r) => fetch(new Request(server.url, r)))
    expect((await res.json()).tasks).toHaveLength(1)
  } finally {
    await server.close()
  }
})
