import { expect, test } from "bun:test"
import { createRequire } from "node:module"
import { twilioMockUrl } from "./src/index.js"
import { createServer } from "./src/server.js"

// Keep the established 5.10.0 coverage and independently test the reporter's exact SDK.
// Use the SDK's own CommonJS entry and declarations for its NodeNext exports map.
type ReconciliationSdk = typeof import("./node_modules/twilio-reconciliation/lib/index.js")
const sdk = createRequire(import.meta.url)("twilio-reconciliation") as ReconciliationSdk

test("twilio@5.13.1 lists messages and follows forward/backward links over HTTP (#257)", async () => {
  const server = await createServer()
  try {
    class Rewrite extends sdk.RequestClient {
      override request(
        options: Parameters<InstanceType<ReconciliationSdk["RequestClient"]>["request"]>[0],
      ): Promise<never> {
        return super.request({
          ...options,
          uri: twilioMockUrl(options.uri, `${server.url}/ns/reconciliation-sdk`),
        }) as Promise<never>
      }
    }
    const account = `AC${"0".repeat(32)}`
    const client = new sdk.Twilio(account, "fixture-token", { httpClient: new Rewrite() })
    const ids = []
    for (let i = 0; i < 3; i++) {
      ids.push(
        (
          await client.messages.create({
            to: "+12025550123",
            from: "+12025550124",
            body: `synthetic-${i}`,
          })
        ).sid,
      )
    }
    const messages = await client.messages.list({ pageSize: 1, limit: 10 })
    expect(messages.map((message) => message.sid)).toEqual([...ids].reverse())
    expect(
      messages.every(
        (message) => message.accountSid === account && message.dateCreated instanceof Date,
      ),
    ).toBe(true)
    const first = await client.messages.page({ pageSize: 1 })
    const second = await first.nextPage()
    const previous = await second.previousPage()
    expect(previous.instances[0]?.sid).toBe(first.instances[0]?.sid)
    // New inserts do not shift the position of the SID cursor while enumeration continues.
    await client.messages.create({
      to: "+12025550123",
      from: "+12025550124",
      body: "newer synthetic fixture",
    })
    const third = await second.nextPage()
    expect(third.instances[0]?.sid).toBe(ids[0])
    expect(third.nextPageUrl).toBeUndefined()
    const emptyNamespaceClient = new sdk.Twilio(account, "fixture-token", {
      httpClient: new (class extends sdk.RequestClient {
        override request(
          options: Parameters<InstanceType<ReconciliationSdk["RequestClient"]>["request"]>[0],
        ): Promise<never> {
          return super.request({
            ...options,
            uri: twilioMockUrl(options.uri, `${server.url}/ns/other-sdk`),
          }) as Promise<never>
        }
      })(),
    })
    expect(await emptyNamespaceClient.messages.list()).toEqual([])
  } finally {
    await server.close()
  }
})
