import { expect, test } from "bun:test"
import {
  EventBridgeClient,
  ListRulesCommand,
  ListTargetsByRuleCommand,
  ResourceNotFoundException,
} from "@aws-sdk/client-eventbridge"
import { createServer } from "./src/server.js"

test("official JS SDK serializes AWS JSON and decodes modeled errors", async () => {
  const server = await createServer({
    rules: [
      {
        rule: { Name: "fixture", Arn: "arn:aws:events:us-east-1:000000000000:rule/fixture" },
        targets: [],
      },
    ],
  })
  const client = new EventBridgeClient({
    endpoint: server.url,
    region: "us-east-1",
    credentials: { accessKeyId: "fixture", secretAccessKey: "fixture" },
    maxAttempts: 1,
  })
  try {
    expect((await client.send(new ListRulesCommand({}))).Rules?.[0]?.Name).toBe("fixture")
    expect((await client.send(new ListTargetsByRuleCommand({ Rule: "fixture" }))).Targets).toEqual(
      [],
    )
    await expect(
      client.send(new ListTargetsByRuleCommand({ Rule: "missing" })),
    ).rejects.toBeInstanceOf(ResourceNotFoundException)
  } finally {
    client.destroy()
    await server.close()
  }
})
