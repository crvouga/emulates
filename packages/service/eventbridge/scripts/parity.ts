import { EventBridgeClient, ListRulesCommand } from "@aws-sdk/client-eventbridge"
import { loadCredentials } from "@emulates/credentials"
import { EventBridgeAPI } from "../src/index.js"

const credentials = await loadCredentials(
  {
    provider: "eventbridge",
    fields: {
      accessKeyId: "EVENTBRIDGE_ACCESS_KEY_ID",
      secretAccessKey: "EVENTBRIDGE_SECRET_ACCESS_KEY",
    },
  },
  { env: process.env },
).catch(() => undefined)
if (!credentials) {
  console.error("Missing EVENTBRIDGE_ACCESS_KEY_ID and/or EVENTBRIDGE_SECRET_ACCESS_KEY")
  process.exit(2)
}
const client = new EventBridgeClient({
  credentials: credentials.values,
  region: process.env.EVENTBRIDGE_REGION ?? "us-east-1",
})
try {
  const input = { NamePrefix: "emulates-oracle-nonexistent-fixture", Limit: 1 }
  const actual = await client.send(new ListRulesCommand(input))
  const expected = (await (
    await new EventBridgeAPI().fetch(
      new Request("http://mock.local/", {
        method: "POST",
        headers: {
          "content-type": "application/x-amz-json-1.1",
          "x-amz-target": "AWSEvents.ListRules",
        },
        body: JSON.stringify(input),
      }),
    )
  ).json()) as { Rules: unknown[]; NextToken?: string }
  if (
    JSON.stringify(actual.Rules) !== JSON.stringify(expected.Rules) ||
    actual.NextToken !== expected.NextToken
  )
    throw new Error("Safe empty discovery differs or fixture prefix exists")
  console.log("EventBridge safe empty discovery contract passed")
} finally {
  client.destroy()
}
