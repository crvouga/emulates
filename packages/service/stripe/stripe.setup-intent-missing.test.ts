import { afterEach, expect, test } from "bun:test"
import { createServer } from "./src/server.js"
import { backendClient } from "./test/consumer.js"

/** Stripe answers an unknown SetupIntent id with a 404 that names the resource "setupintent". */

const KEY = "sk_test_setupIntentMissing1"

const closers: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of closers.splice(0)) await close()
})

test("retrieving an unknown SetupIntent is a 404 resource_missing", async () => {
  const server = await createServer({
    accounts: [{ id: "acct_setup", keys: [KEY], displayName: "Acme Fitness" }],
  })
  closers.push(() => server.close())
  const stripe = backendClient(KEY, new URL(server.url))
  const error = await stripe.setupIntents.retrieve("seti_missing").catch((caught) => caught)
  expect(error.statusCode).toBe(404)
  expect(error.code).toBe("resource_missing")
  expect(error.message).toBe("No such setupintent: 'seti_missing'")
  expect(error.param).toBe("intent")
})
