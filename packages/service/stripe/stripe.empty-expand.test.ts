import { afterEach, expect, test } from "bun:test"
import { createServer } from "./src/server.js"

const KEY = "sk_test_emptyExpand1"

const closers: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of closers.splice(0)) await close()
})

// Live parity: Stripe validates `expand=` before it looks the subscription item up.
test("retrieving a subscription item with an empty expand is refused before the lookup", async () => {
  const server = await createServer({ accounts: [{ id: "acct_ee", keys: [KEY] }] })
  closers.push(() => server.close())
  const response = await fetch(`${server.url}/v1/subscription_items/si_missing?expand=`, {
    headers: { authorization: `Bearer ${KEY}` },
  })
  const { error } = (await response.json()) as { error: { code: string; param: string } }
  expect(response.status).toBe(400)
  expect(error.code).toBe("parameter_invalid_empty")
  expect(error.param).toBe("expand")
})
