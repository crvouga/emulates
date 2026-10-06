import { expect, test } from "bun:test"
import { createClock } from "@emulates/service"
import { createRuntime, type SeedRule } from "./src/index.js"
import { createServer } from "./src/server.js"
import { call } from "./test/consumer.js"

test("shared Timeline restores seeded discovery rows", async () => {
  const runtime = createRuntime()
  const request = (path: string, method: string, body?: unknown) =>
    runtime.fetch(
      new Request(`http://mock.local/__admin/${path}`, {
        method,
        headers: { "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    )
  expect(
    (
      await request("state/rules", "POST", {
        id: "default:kept",
        value: {
          rule: { Name: "kept", Arn: "arn:aws:events:us-east-1:000000000000:rule/kept" },
          targets: [],
        },
      })
    ).status,
  ).toBe(201)
  const { id } = await (await request("snapshots", "POST")).json()
  expect((await request("state/rules/default:kept", "DELETE")).status).toBe(200)
  expect((await (await call(runtime.fetch, "ListRules")).json()).Rules).toEqual([])
  await request(`snapshots/${id}/restore`, "POST")
  expect((await (await call(runtime.fetch, "ListRules")).json()).Rules[0].Name).toBe("kept")
})

const rules: SeedRule[] = ["batch-a", "batch-b"].map((Name) => ({
  rule: { Name, Arn: `arn:aws:events:us-east-1:000000000000:rule/${Name}` },
  targets: ["a", "b"].map((Id) => ({
    Id,
    Arn: "arn:aws:ecs:us-east-1:000000000000:cluster/mock",
    EcsParameters: {
      TaskDefinitionArn: "arn:aws:ecs:us-east-1:000000000000:task-definition/mock:1",
      NetworkConfiguration: {
        awsvpcConfiguration: { Subnets: ["subnet-fixture"], AssignPublicIp: "DISABLED" },
      },
    },
  })),
}))
test("seeded rule/target ARNs and ECS network metadata survive paginated discovery", async () => {
  const runtime = createRuntime({ rules })
  const first = await (
    await call(runtime.fetch, "ListRules", { NamePrefix: "batch", Limit: 1 })
  ).json()
  expect(first.Rules).toEqual([rules[0]?.rule])
  const last = await (
    await call(runtime.fetch, "ListRules", {
      NamePrefix: "batch",
      Limit: 1,
      NextToken: first.NextToken,
    })
  ).json()
  expect(last.Rules).toEqual([rules[1]?.rule])
  expect(last.NextToken).toBeUndefined()
  const targets = await (
    await call(runtime.fetch, "ListTargetsByRule", { Rule: "batch-a", Limit: 1 })
  ).json()
  expect(targets.Targets).toEqual([rules[0]?.targets[0]])
  const next = await (
    await call(runtime.fetch, "ListTargetsByRule", {
      Rule: "batch-a",
      Limit: 1,
      NextToken: targets.NextToken,
    })
  ).json()
  expect(next.Targets).toEqual([rules[0]?.targets[1]])
  expect(next.NextToken).toBeUndefined()
})
test("missing rules/buses, denial, quota, invalid and expired tokens are AWS errors", async () => {
  const clock = createClock(() => 1700000000000)
  const runtime = createRuntime({ rules, clock })
  for (const body of [{ Rule: "missing" }, { Rule: "batch-a", EventBusName: "missing" }]) {
    const response = await call(runtime.fetch, "ListTargetsByRule", body)
    expect(response.status).toBe(400)
    expect((await response.json()).__type).toBe("ResourceNotFoundException")
  }
  const first = await (await call(runtime.fetch, "ListRules", { Limit: 1 })).json()
  expect(
    (await call(runtime.fetch, "ListRules", { Limit: 2, NextToken: first.NextToken })).status,
  ).toBe(400)
  clock.advance(3600000)
  expect(
    (
      await (
        await call(runtime.fetch, "ListRules", { Limit: 1, NextToken: first.NextToken })
      ).json()
    ).__type,
  ).toBe("InvalidToken")
  for (const [preset, status] of [
    ["access_denied", 403],
    ["throttled", 400],
    ["rate_limited", 429],
    ["internal_error", 500],
  ] as const) {
    await runtime.fetch(
      new Request("http://mock.local/__admin/faults", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ preset, count: 1 }),
      }),
    )
    expect((await call(runtime.fetch, "ListRules")).status).toBe(status)
  }
  await runtime.fetch(
    new Request("http://mock.local/__admin/faults", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ preset: "connection_drop", count: 1 }),
    }),
  )
  await expect(call(runtime.fetch, "ListRules")).rejects.toThrow()
})
test("header, path and SigV4 namespaces isolate state; reset restores seeds; journals omit credentials", async () => {
  const runtime = createRuntime({ rules })
  runtime.instance("alpha").rules.delete("default:batch-a")
  const headers = { "x-emulates-namespace": "alpha" }
  expect((await (await call(runtime.fetch, "ListRules", {}, headers)).json()).Rules).toHaveLength(1)
  expect((await (await call(runtime.fetch, "ListRules")).json()).Rules).toHaveLength(2)
  const pathFetch = (request: Request) =>
    runtime.fetch(
      new Request(request.url.replace("mock.local/", "mock.local/__admin/ns/alpha/"), request),
    )
  expect((await (await call(pathFetch, "ListRules")).json()).Rules).toHaveLength(1)
  await runtime.fetch(
    new Request("http://mock.local/__admin/credentials", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ credentials: { fixture: "alpha" } }),
    }),
  )
  const auth = {
    authorization:
      "AWS4-HMAC-SHA256 Credential=fixture/20260101/us-east-1/events/aws4_request, SignedHeaders=host, Signature=mock",
  }
  expect((await (await call(runtime.fetch, "ListRules", {}, auth)).json()).Rules).toHaveLength(1)
  await runtime.instance("alpha").reset()
  expect((await (await call(runtime.fetch, "ListRules", {}, headers)).json()).Rules).toHaveLength(2)
  const journal = await runtime.fetch(new Request("http://mock.local/__admin/requests"))
  expect(await journal.text()).not.toContain("Signature=mock")
})
test("served HTTP and admin state seed shape", async () => {
  const server = await createServer()
  try {
    expect((await fetch(`${server.url}/__admin/health`)).status).toBe(200)
    await fetch(`${server.url}/__admin/state/rules`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "default:batch-a", value: rules[0] }),
    })
    const response = await fetch(server.url, {
      method: "POST",
      headers: {
        "x-amz-target": "AWSEvents.ListTargetsByRule",
        "content-type": "application/x-amz-json-1.1",
      },
      body: JSON.stringify({ Rule: "batch-a" }),
    })
    expect((await response.json()).Targets).toEqual(rules[0]?.targets)
  } finally {
    await server.close()
  }
})
