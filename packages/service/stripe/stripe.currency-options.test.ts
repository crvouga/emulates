import { afterEach, describe, expect, test } from "bun:test"
import type Stripe from "stripe"
import { createServer } from "./src/server.js"
import { backendClient } from "./test/consumer.js"

/**
 * Multi-currency prices: `currency_options` are stored when a price is created or updated, and
 * come back only when expanded (`expand[]=currency_options`), one entry per currency including
 * the price's own. Checkout charges the option's amount when the session asks for its currency.
 * Oracle: https://docs.stripe.com/api/prices/object#price_object-currency_options.
 */

const KEY = "sk_test_currencyOptions1"

const closers: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of closers.splice(0)) await close()
})

const harness = async () => {
  const server = await createServer({
    accounts: [{ id: "acct_currency", keys: [KEY], displayName: "Acme Fitness" }],
  })
  closers.push(() => server.close())
  const stripe = backendClient(KEY, new URL(server.url))
  return { stripe, url: server.url }
}

const plusPrice = async (stripe: Stripe, extra: Partial<Stripe.PriceCreateParams> = {}) => {
  const product = await stripe.products.create({ name: "Plus" })
  return stripe.prices.create({
    product: product.id,
    unit_amount: 700,
    currency: "usd",
    lookup_key: "plus_monthly",
    currency_options: { inr: { unit_amount: 29_900 }, eur: { unit_amount: 650 } },
    ...extra,
  })
}

describe("price currency_options", () => {
  test("are stored on create and returned, with the default currency, when expanded", async () => {
    const { stripe } = await harness()
    const price = await plusPrice(stripe, { recurring: { interval: "month" } })
    expect(price.currency_options).toBeUndefined()
    const again = await stripe.prices.retrieve(price.id, { expand: ["currency_options"] })
    expect(again.currency_options).toEqual({
      eur: {
        custom_unit_amount: null,
        tax_behavior: "unspecified",
        unit_amount: 650,
        unit_amount_decimal: "650",
      },
      inr: {
        custom_unit_amount: null,
        tax_behavior: "unspecified",
        unit_amount: 29_900,
        unit_amount_decimal: "29900",
      },
      usd: {
        custom_unit_amount: null,
        tax_behavior: "unspecified",
        unit_amount: 700,
        unit_amount_decimal: "700",
      },
    })
    expect(Object.keys(again.currency_options ?? {})).toEqual(["eur", "inr", "usd"])
    expect(again.unit_amount).toBe(700)
  })

  test("are echoed on create and update, and listed, only when expanded", async () => {
    const { stripe } = await harness()
    const product = await stripe.products.create({ name: "Plus" })
    const created = await stripe.prices.create({
      product: product.id,
      unit_amount: 700,
      currency: "usd",
      currency_options: { inr: { unit_amount: 29_900 } },
      expand: ["currency_options"],
    })
    expect(Object.keys(created.currency_options ?? {})).toEqual(["inr", "usd"])
    const plain = await stripe.prices.update(created.id, { nickname: "Plus" })
    expect(plain.currency_options).toBeUndefined()
    const listed = await stripe.prices.list({
      product: product.id,
      expand: ["data.currency_options"],
    })
    expect(Object.keys(listed.data[0]?.currency_options ?? {})).toEqual(["inr", "usd"])
    const unexpanded = await stripe.prices.list({ product: product.id })
    expect(unexpanded.data[0]?.currency_options).toBeUndefined()
  })

  test("a price created without options expands to its own currency alone", async () => {
    const { stripe } = await harness()
    const product = await stripe.products.create({ name: "Basic" })
    const price = await stripe.prices.create({
      product: product.id,
      unit_amount_decimal: "12.5",
      currency: "usd",
      tax_behavior: "exclusive",
    })
    const again = await stripe.prices.retrieve(price.id, { expand: ["currency_options"] })
    expect(again.currency_options).toEqual({
      usd: {
        custom_unit_amount: null,
        tax_behavior: "exclusive",
        unit_amount: null,
        unit_amount_decimal: "12.5",
      },
    })
  })

  test("update adds and replaces the currencies it names and keeps the rest", async () => {
    const { stripe } = await harness()
    const price = await plusPrice(stripe)
    const updated = await stripe.prices.update(price.id, {
      currency_options: { inr: { unit_amount: 31_900 }, gbp: { unit_amount_decimal: "550" } },
      expand: ["currency_options"],
    })
    expect(
      Object.fromEntries(
        Object.entries(updated.currency_options ?? {}).map(([code, option]) => [
          code,
          option.unit_amount,
        ]),
      ),
    ).toEqual({ eur: 650, gbp: 550, inr: 31_900, usd: 700 })
  })

  test("are validated like Stripe's", async () => {
    const { stripe } = await harness()
    const product = await stripe.products.create({ name: "Plus" })
    const base = { product: product.id, unit_amount: 700, currency: "usd" }
    const badCurrency = await stripe.prices
      .create({ ...base, currency_options: { zzz: { unit_amount: 1 } } })
      .catch((error: Stripe.errors.StripeError) => error)
    expect((badCurrency as Stripe.errors.StripeError).message).toContain("Invalid currency: zzz")
    const noAmount = await stripe.prices
      .create({ ...base, currency_options: { eur: { tax_behavior: "exclusive" } } })
      .catch((error: Stripe.errors.StripeError) => error)
    expect((noAmount as Stripe.errors.StripeError).statusCode).toBe(400)
    const both = await stripe.prices
      .create({
        ...base,
        currency_options: { eur: { unit_amount: 1, unit_amount_decimal: "1" } },
      })
      .catch((error: Stripe.errors.StripeError) => error)
    expect((both as Stripe.errors.StripeError).message).toContain(
      "You may only specify one of these parameters: unit_amount, unit_amount_decimal.",
    )
  })
})

describe("Checkout with a price's currency option", () => {
  test("currency=<option> charges the option's amount in that currency", async () => {
    const { stripe } = await harness()
    const price = await plusPrice(stripe)
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      currency: "inr",
      line_items: [{ price: price.id, quantity: 2 }],
      success_url: "http://localhost/done",
    })
    expect(session.currency).toBe("inr")
    expect(session.amount_total).toBe(59_800)
    const lines = await stripe.checkout.sessions.listLineItems(session.id)
    expect(lines.data[0]?.currency).toBe("inr")
    expect(lines.data[0]?.amount_total).toBe(59_800)
  })

  test("without a currency the price's own currency and amount apply", async () => {
    const { stripe } = await harness()
    const price = await plusPrice(stripe)
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: [{ price: price.id, quantity: 1 }],
      success_url: "http://localhost/done",
    })
    expect(session.currency).toBe("usd")
    expect(session.amount_total).toBe(700)
  })

  test("a currency the price does not offer is refused", async () => {
    const { stripe } = await harness()
    const price = await plusPrice(stripe)
    const refused = await stripe.checkout.sessions
      .create({
        mode: "payment",
        currency: "jpy",
        line_items: [{ price: price.id, quantity: 1 }],
        success_url: "http://localhost/done",
      })
      .catch((error: Stripe.errors.StripeError) => error)
    expect((refused as Stripe.errors.StripeError).statusCode).toBe(400)
    expect((refused as Stripe.errors.StripeError).message).toContain(
      "This doesn't match the expected currency: `jpy`",
    )
  })
})
