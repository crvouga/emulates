import { afterEach, describe, expect, test } from "bun:test"
import type Stripe from "stripe"
import type { AccountConfig } from "./src/accounts.js"
import { createServer } from "./src/server.js"
import { backendClient } from "./test/consumer.js"

/**
 * Automatic collection retries for a failed subscription renewal and the outcome once every
 * retry has failed (https://docs.stripe.com/billing/revenue-recovery/smart-retries, "Manage
 * failed payments for subscriptions"), driven through stripe-node and the mock clock.
 */

const KEY = "sk_test_dunningSuite1"
const DAY = 86_400

const closers: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of closers.splice(0)) await close()
})

const harness = async (
  billing?: AccountConfig["billing"],
  lifecycle?: NonNullable<Parameters<typeof createServer>[0]>["lifecycle"],
) => {
  const server = await createServer({
    accounts: [{ id: "acct_dunning", keys: [KEY], ...(billing ? { billing } : {}) }],
    ...(lifecycle ? { lifecycle } : {}),
  })
  closers.push(() => server.close())
  const stripe = backendClient(KEY, new URL(server.url))
  const admin = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${server.url}/__admin${path}`, {
      method,
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    return { status: response.status, body: (await response.json()) as Record<string, unknown> }
  }
  const now = async () => Number((await admin("GET", "/clock")).body.now) / 1000
  /** Move the clock to an absolute time (seconds); the lifecycle runs on every move. */
  const advanceTo = async (at: number) => {
    await admin("POST", "/clock", { advance: Math.max(0, at - (await now())) * 1000 })
  }
  const events = async (type: string) =>
    (await stripe.events.list({ type, limit: 100 })).data.map((event) => event.data.object)
  return { server, stripe, admin, now, advanceTo, events }
}

type Harness = Awaited<ReturnType<typeof harness>>

/** An active subscription whose default card then starts declining, and the clock at its renewal. */
const failingRenewal = async (h: Harness) => {
  const { stripe } = h
  const customer = await stripe.customers.create({ email: "member@example.com" })
  const good = await stripe.paymentMethods.attach("pm_card_visa", { customer: customer.id })
  await stripe.customers.update(customer.id, {
    invoice_settings: { default_payment_method: good.id },
  })
  const product = await stripe.products.create({ name: "Pro" })
  const price = await stripe.prices.create({
    product: product.id,
    currency: "usd",
    unit_amount: 2_000,
    recurring: { interval: "month" },
  })
  const subscription = await stripe.subscriptions.create({
    customer: customer.id,
    items: [{ price: price.id }],
  })
  expect(subscription.status).toBe("active")
  const declining = await stripe.paymentMethods.create({
    type: "card",
    card: { token: "tok_chargeCustomerFail" },
  })
  await stripe.paymentMethods.attach(declining.id, { customer: customer.id })
  await stripe.customers.update(customer.id, {
    invoice_settings: { default_payment_method: declining.id },
  })
  const failedAt = subscription.current_period_end
  await h.advanceTo(failedAt)
  return { customer, subscription, failedAt }
}

const renewalInvoice = async (h: Harness, subscriptionId: string) => {
  const subscription = await h.stripe.subscriptions.retrieve(subscriptionId)
  return h.stripe.invoices.retrieve(subscription.latest_invoice as string)
}

describe("payment retries for failed renewals", () => {
  test("1. the failed renewal is open, attempt 1, with next_payment_attempt three days out", async () => {
    const h = await harness()
    const { subscription, failedAt } = await failingRenewal(h)
    const invoice = await renewalInvoice(h, subscription.id)
    expect(invoice.status).toBe("open")
    expect(invoice.attempt_count).toBe(1)
    expect(invoice.next_payment_attempt).toBe(failedAt + 3 * DAY)
    expect((await h.stripe.subscriptions.retrieve(subscription.id)).status).toBe("past_due")
    expect((await h.events("invoice.payment_failed")).length).toBe(1)
  })

  test("2. a retry that still declines bumps attempt_count and schedules the next one", async () => {
    const h = await harness()
    const { subscription, failedAt } = await failingRenewal(h)
    await h.advanceTo(failedAt + 3 * DAY - 1)
    expect((await renewalInvoice(h, subscription.id)).attempt_count).toBe(1)
    await h.advanceTo(failedAt + 3 * DAY)
    const retried = await renewalInvoice(h, subscription.id)
    expect(retried.attempt_count).toBe(2)
    expect(retried.status).toBe("open")
    expect(retried.next_payment_attempt).toBe(failedAt + 5 * DAY)
    expect((await h.events("invoice.payment_failed")).length).toBe(2)
    expect((await h.stripe.subscriptions.retrieve(subscription.id)).status).toBe("past_due")
  })

  test("3. a working default card before a retry pays the invoice and reactivates the subscription", async () => {
    const h = await harness()
    const { customer, subscription, failedAt } = await failingRenewal(h)
    const good = await h.stripe.paymentMethods.attach("pm_card_mastercard", {
      customer: customer.id,
    })
    await h.stripe.customers.update(customer.id, {
      invoice_settings: { default_payment_method: good.id },
    })
    const updatedBefore = (await h.events("customer.subscription.updated")).length
    await h.advanceTo(failedAt + 3 * DAY)
    const invoice = await renewalInvoice(h, subscription.id)
    expect(invoice.status).toBe("paid")
    expect(invoice.attempt_count).toBe(2)
    expect(invoice.next_payment_attempt).toBeNull()
    expect((await h.stripe.subscriptions.retrieve(subscription.id)).status).toBe("active")
    expect((await h.events("invoice.paid")).length).toBe(2)
    expect((await h.events("customer.subscription.updated")).length).toBe(updatedBefore + 1)
    expect((await h.events("invoice.payment_failed")).length).toBe(1)
  })

  test("4. after every retry fails the subscription is canceled by default", async () => {
    const h = await harness()
    const { subscription, failedAt } = await failingRenewal(h)
    await h.advanceTo(failedAt + 7 * DAY)
    const invoice = await renewalInvoice(h, subscription.id)
    expect(invoice.attempt_count).toBe(4)
    expect(invoice.next_payment_attempt).toBeNull()
    const canceled = await h.stripe.subscriptions.retrieve(subscription.id)
    expect(canceled.status).toBe("canceled")
    expect(canceled.ended_at).not.toBeNull()
    expect(canceled.cancellation_details?.reason).toBe("payment_failed")
    expect((await h.events("customer.subscription.deleted")).length).toBe(1)
    expect((await h.events("invoice.payment_failed")).length).toBe(4)
    // Nothing more happens afterwards.
    await h.advanceTo(failedAt + 20 * DAY)
    expect((await h.events("invoice.payment_failed")).length).toBe(4)
  })

  test("4. afterAllFail unpaid marks the subscription unpaid and stops retrying", async () => {
    const h = await harness({ retries: { afterAllFail: "unpaid" } })
    const { subscription, failedAt } = await failingRenewal(h)
    await h.advanceTo(failedAt + 6 * DAY)
    expect((await h.stripe.subscriptions.retrieve(subscription.id)).status).toBe("past_due")
    await h.advanceTo(failedAt + 7 * DAY)
    expect((await renewalInvoice(h, subscription.id)).next_payment_attempt).toBeNull()
    expect((await h.stripe.subscriptions.retrieve(subscription.id)).status).toBe("unpaid")
    expect((await h.events("customer.subscription.deleted")).length).toBe(0)
    const statuses = (await h.events("customer.subscription.updated")).map(
      (object) => (object as Stripe.Subscription).status,
    )
    expect(statuses).toContain("unpaid")
    await h.advanceTo(failedAt + 20 * DAY)
    expect((await h.events("invoice.payment_failed")).length).toBe(4)
  })

  test("4. afterAllFail past_due leaves the subscription past_due", async () => {
    const h = await harness({ retries: { afterAllFail: "past_due" } })
    const { subscription, failedAt } = await failingRenewal(h)
    await h.advanceTo(failedAt + 10 * DAY)
    const invoice = await renewalInvoice(h, subscription.id)
    expect(invoice.next_payment_attempt).toBeNull()
    expect(invoice.attempt_count).toBe(4)
    expect((await h.stripe.subscriptions.retrieve(subscription.id)).status).toBe("past_due")
    expect((await h.events("customer.subscription.deleted")).length).toBe(0)
  })

  test("5. the schedule is configurable and one clock jump runs every due retry in order", async () => {
    const h = await harness({ retries: { scheduleDays: [1, 2], afterAllFail: "cancel" } })
    const { subscription, failedAt } = await failingRenewal(h)
    expect((await renewalInvoice(h, subscription.id)).next_payment_attempt).toBe(failedAt + DAY)
    await h.advanceTo(failedAt + DAY)
    expect((await renewalInvoice(h, subscription.id)).next_payment_attempt).toBe(failedAt + 2 * DAY)
    await h.advanceTo(failedAt + 10 * DAY)
    const invoice = await renewalInvoice(h, subscription.id)
    expect(invoice.attempt_count).toBe(3)
    expect(invoice.next_payment_attempt).toBeNull()
    expect((await h.stripe.subscriptions.retrieve(subscription.id)).status).toBe("canceled")
  })

  test("5. an empty schedule applies the outcome at the first failure", async () => {
    const h = await harness({ retries: { scheduleDays: [], afterAllFail: "unpaid" } })
    const { subscription } = await failingRenewal(h)
    const invoice = await renewalInvoice(h, subscription.id)
    expect(invoice.attempt_count).toBe(1)
    expect(invoice.next_payment_attempt).toBeNull()
    expect((await h.stripe.subscriptions.retrieve(subscription.id)).status).toBe("unpaid")
  })

  test("createRuntime's lifecycle.paymentRetries is the default; an account's billing overrides it", async () => {
    const paymentRetries = { scheduleDays: [2], afterAllFail: "unpaid" as const }
    const h = await harness(undefined, { paymentRetries })
    const { subscription, failedAt } = await failingRenewal(h)
    expect((await renewalInvoice(h, subscription.id)).next_payment_attempt).toBe(failedAt + 2 * DAY)
    await h.advanceTo(failedAt + 2 * DAY)
    expect((await h.stripe.subscriptions.retrieve(subscription.id)).status).toBe("unpaid")
    const override = await harness({ retries: { afterAllFail: "past_due" } }, { paymentRetries })
    const kept = await failingRenewal(override)
    await override.advanceTo(kept.failedAt + 2 * DAY)
    expect((await override.stripe.subscriptions.retrieve(kept.subscription.id)).status).toBe(
      "past_due",
    )
  })

  test("the schedule and outcome are set through PUT /__admin/accounts and validated", async () => {
    const h = await harness()
    const put = (retries: unknown) =>
      h.admin("PUT", "/accounts", {
        accounts: [{ id: "acct_dunning", keys: [KEY], billing: { retries } }],
      })
    expect((await put({ scheduleDays: [1, 4], afterAllFail: "unpaid" })).status).toBe(200)
    const listed = (await h.admin("GET", "/accounts")).body.accounts as Array<{
      billing?: unknown
    }>
    expect(listed[0]?.billing).toEqual({
      retries: { scheduleDays: [1, 4], afterAllFail: "unpaid" },
    })
    expect((await put({ afterAllFail: "forgive" })).status).toBe(400)
    expect((await put({ scheduleDays: [3, 1] })).status).toBe(400)
    expect((await put({ scheduleDays: [0] })).status).toBe(400)
  })
})
