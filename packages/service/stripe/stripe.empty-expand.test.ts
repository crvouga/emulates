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

// Live parity: on a search, Stripe refuses an empty `query` before an empty `expand`.
test("a search with empty query and empty expand names the query", async () => {
  const server = await createServer({ accounts: [{ id: "acct_ee2", keys: [KEY] }] })
  closers.push(() => server.close())
  const response = await fetch(`${server.url}/v1/payment_intents/search?query=&expand=`, {
    headers: { authorization: `Bearer ${KEY}` },
  })
  const { error } = (await response.json()) as { error: { code: string; param: string } }
  expect(response.status).toBe(400)
  expect(error.code).toBe("parameter_invalid_empty")
  expect(error.param).toBe("query")
})

// Live parity: an out-of-range limit is refused before an empty `expand`.
test("a search with limit 0 and empty expand names the limit", async () => {
  const server = await createServer({ accounts: [{ id: "acct_ee3", keys: [KEY] }] })
  closers.push(() => server.close())
  const response = await fetch(`${server.url}/v1/payment_intents/search?query=a&limit=0&expand=`, {
    headers: { authorization: `Bearer ${KEY}` },
  })
  const { error } = (await response.json()) as { error: { code: string; param: string } }
  expect(response.status).toBe(400)
  expect(error.code).toBe("parameter_invalid_integer")
  expect(error.param).toBe("limit")
})

// Live parity: an empty customer_account on the schedules list is refused before the filters.
test("listing schedules with an empty customer_account and a bad released_at names customer_account", async () => {
  const server = await createServer({ accounts: [{ id: "acct_ee4", keys: [KEY] }] })
  closers.push(() => server.close())
  const response = await fetch(
    `${server.url}/v1/subscription_schedules?customer_account=&released_at=`,
    { headers: { authorization: `Bearer ${KEY}` } },
  )
  const { error } = (await response.json()) as { error: { code: string; param: string } }
  expect(response.status).toBe(400)
  expect(error.code).toBe("parameter_invalid_empty")
  expect(error.param).toBe("customer_account")
})
