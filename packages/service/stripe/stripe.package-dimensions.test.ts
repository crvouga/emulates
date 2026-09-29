import { afterEach, expect, test } from "bun:test"
import { createServer } from "./src/server.js"

const KEY = "sk_test_packageDimensions1"

const closers: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of closers.splice(0)) await close()
})

const createProduct = async (packageDimensions: Record<string, string>) => {
  const server = await createServer({ accounts: [{ id: "acct_pd", keys: [KEY] }] })
  closers.push(() => server.close())
  const body = new URLSearchParams({ name: "a" })
  for (const [field, value] of Object.entries(packageDimensions))
    body.set(`package_dimensions[${field}]`, value)
  const response = await fetch(`${server.url}/v1/products`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${KEY}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body,
  })
  return (await response.json()) as { error: { message: string; param: string } }
}

// Live parity: Stripe reads exponent notation as a valid number, so a later field's places
// complaint is reported instead of the exponent value being called an invalid decimal.
test("an exponent-notation dimension does not mask an earlier field's decimal-places error", async () => {
  const { error } = await createProduct({
    length: "-0.000063313667828",
    width: "9.14881318165e-276",
    height: "0",
    weight: "0",
  })
  expect(error.param).toBe("package_dimensions[length]")
  expect(error.message).toBe(
    "Invalid decimal: -6.3313667828e-05; must contain at maximum two decimal places.",
  )
})

test("a non-numeric dimension is still an invalid decimal", async () => {
  const { error } = await createProduct({ length: "abc", width: "1" })
  expect(error.param).toBe("package_dimensions[length]")
  expect(error.message).toBe("Invalid decimal: abc")
})

// Live parity: a scalar `metadata` on a product gets Stripe's metadata message, not "Invalid object".
test("a scalar metadata on a product names the metadata rule", async () => {
  const server = await createServer({ accounts: [{ id: "acct_pd2", keys: [KEY] }] })
  closers.push(() => server.close())
  const response = await fetch(`${server.url}/v1/products`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${KEY}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ name: "!", metadata: "0" }),
  })
  const { error } = (await response.json()) as { error: { message: string; param: string } }
  expect(error.param).toBe("metadata")
  expect(error.message).toStartWith("Invalid value for `metadata`.")
})

// Live parity: exponent-notation values are still invalid decimals, reported in field order.
test("exponent-notation dimensions are reported in field order once the places check passes", async () => {
  const { error } = await createProduct({
    length: "0",
    width: "5e-324",
    height: "0",
    weight: "5e-324",
  })
  expect(error.param).toBe("package_dimensions[width]")
})
