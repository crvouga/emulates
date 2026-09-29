import { afterEach, describe, expect, test } from "bun:test"
import { createServer } from "./src/server.js"
import { backendClient } from "./test/consumer.js"

/**
 * Product `images` are checked element by element in index order, so an invalid URL at an
 * earlier index wins over an empty string later in the array (observed against Stripe test mode).
 */

const KEY = "sk_test_productImages1"

const closers: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of closers.splice(0)) await close()
})

const create = async (images: string[]) => {
  const server = await createServer({
    accounts: [{ id: "acct_images", keys: [KEY], displayName: "Acme Fitness" }],
  })
  closers.push(() => server.close())
  const stripe = backendClient(KEY, new URL(server.url))
  return stripe.products.create({ name: "a", images }).catch((error) => error)
}

describe("product images validation order", () => {
  test("an invalid URL before an empty element is the reported error", async () => {
    const error = await create([" ", "", ""])
    expect(error.code).toBe("url_invalid")
    expect(error.param).toBe("images[0]")
  })

  test("an empty element before an invalid URL is the reported error", async () => {
    const error = await create(["", " "])
    expect(error.code).toBe("parameter_invalid_empty")
    expect(error.param).toBe("images[0]")
  })
})
