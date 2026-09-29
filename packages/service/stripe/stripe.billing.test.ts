import { afterEach, describe, expect, test } from "bun:test"
import type Stripe from "stripe"
import { createServer } from "./src/server.js"
import { backendClient } from "./test/consumer.js"

/**
 * The subscription lifecycle beyond create/renew/cancel — paused collection, trials that end
 * without a card, resuming, trial reminders, prorated cancellation — and the hosted Checkout
 * flows around it, driven through stripe-node and the hosted page exactly as an app would.
 */

const KEY = "sk_test_billingSuite1"

const closers: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of closers.splice(0)) await close()
})

const harness = async () => {
  const server = await createServer({
    accounts: [{ id: "acct_billing", keys: [KEY], displayName: "Acme Fitness" }],
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
  const advance = (duration: string) => admin("POST", "/clock", { advance: duration })
  const events = async (type: string) =>
    (await stripe.events.list({ type, limit: 100 })).data.map(
      (event) => event.data.object as unknown as Record<string, unknown>,
    )
  const now = async () => Number((await admin("GET", "/clock")).body.now) / 1000
  return { server, stripe, admin, advance, events, now }
}

type Harness = Awaited<ReturnType<typeof harness>>

const monthly = async (stripe: Stripe, amount = 2_000, name = "Pro") => {
  const product = await stripe.products.create({ name })
  return stripe.prices.create({
    product: product.id,
    currency: "usd",
    unit_amount: amount,
    recurring: { interval: "month" },
  })
}

const payingCustomer = async (stripe: Stripe, card = "pm_card_visa") => {
  const customer = await stripe.customers.create({ email: "member@example.com" })
  const method = await stripe.paymentMethods.attach(card, { customer: customer.id })
  await stripe.customers.update(customer.id, {
    invoice_settings: { default_payment_method: method.id },
  })
  return customer
}

const subscribe = async ({ stripe }: Harness, amount = 2_000) => {
  const customer = await payingCustomer(stripe)
  const price = await monthly(stripe, amount)
  const subscription = await stripe.subscriptions.create({
    customer: customer.id,
    items: [{ price: price.id }],
  })
  expect(subscription.status).toBe("active")
  return { customer, price, subscription }
}

const expectStripeError = async (promise: Promise<unknown>) =>
  promise.then(
    () => {
      throw new Error("expected a Stripe error")
    },
    (error: unknown) => error as Stripe.errors.StripeError,
  )

const renewalInvoices = async (stripe: Stripe, subscription: string) =>
  (await stripe.invoices.list({ subscription, limit: 100 })).data.filter(
    (invoice) => invoice.billing_reason === "subscription_cycle",
  )

describe("pause_collection", () => {
  test("void: renewals keep the period moving but void their invoice; clearing it collects again", async () => {
    const h = await harness()
    const { subscription } = await subscribe(h)
    const paused = await h.stripe.subscriptions.update(subscription.id, {
      pause_collection: { behavior: "void" },
    })
    expect(paused.pause_collection).toEqual({ behavior: "void", resumes_at: null })
    expect(paused.status).toBe("active")
    await h.advance("32d")
    const [voided] = await renewalInvoices(h.stripe, subscription.id)
    expect(voided?.status).toBe("void")
    const during = await h.stripe.subscriptions.retrieve(subscription.id)
    expect(during.status).toBe("active")
    expect(during.current_period_start).toBe(subscription.current_period_end)
    expect((await h.events("invoice.voided")).length).toBe(1)
    expect((await h.events("invoice.paid")).length).toBe(1) // only the first invoice
    const cleared = await h.stripe.subscriptions.update(subscription.id, { pause_collection: "" })
    expect(cleared.pause_collection).toBeNull()
    await h.advance("31d")
    const renewals = await renewalInvoices(h.stripe, subscription.id)
    expect(renewals.map((invoice) => invoice.status)).toEqual(["paid", "void"])
  })

  test("mark_uncollectible and keep_as_draft settle renewals without charging", async () => {
    const h = await harness()
    const first = await subscribe(h)
    const second = await subscribe(h)
    await h.stripe.subscriptions.update(first.subscription.id, {
      pause_collection: { behavior: "mark_uncollectible" },
    })
    await h.stripe.subscriptions.update(second.subscription.id, {
      pause_collection: { behavior: "keep_as_draft" },
    })
    await h.advance("32d")
    const [uncollectible] = await renewalInvoices(h.stripe, first.subscription.id)
    expect(uncollectible?.status).toBe("uncollectible")
    expect(uncollectible?.status_transitions.marked_uncollectible_at).toBeNumber()
    expect((await h.events("invoice.marked_uncollectible")).length).toBe(1)
    const [draft] = await renewalInvoices(h.stripe, second.subscription.id)
    expect(draft?.status).toBe("draft")
    expect(draft?.auto_advance).toBe(false)
    expect((await h.events("invoice.paid")).length).toBe(2) // the two first invoices only
  })

  test("resumes_at lifts the pause on its own before the renewal it precedes", async () => {
    const h = await harness()
    const { subscription } = await subscribe(h)
    const at = subscription.current_period_start + 10 * 86_400
    const paused = await h.stripe.subscriptions.update(subscription.id, {
      pause_collection: { behavior: "void", resumes_at: at },
    })
    expect(paused.pause_collection?.resumes_at).toBe(at)
    await h.advance("32d")
    const current = await h.stripe.subscriptions.retrieve(subscription.id)
    expect(current.pause_collection).toBeNull()
    const [renewal] = await renewalInvoices(h.stripe, subscription.id)
    expect(renewal?.status).toBe("paid")
    const updates = await h.events("customer.subscription.updated")
    expect(updates.some((object) => object.pause_collection === null)).toBe(true)
  })

  test("a resumes_at in the past and a missing behavior are refused", async () => {
    const h = await harness()
    const { subscription } = await subscribe(h)
    const past = await expectStripeError(
      h.stripe.subscriptions.update(subscription.id, {
        pause_collection: { behavior: "void", resumes_at: subscription.created - 60 },
      }),
    )
    expect(past.statusCode).toBe(400)
    expect(past.param).toBe("pause_collection[resumes_at]")
    const missing = await fetch(`${h.server.url}/v1/subscriptions/${subscription.id}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${KEY}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: "pause_collection[resumes_at]=4102444800",
    })
    expect(missing.status).toBe(400)
  })
})

describe("trials that end without a payment method", () => {
  test("trial_settings pause: the trial ends paused, then /resume starts a new paid period", async () => {
    const h = await harness()
    const customer = await h.stripe.customers.create({ email: "trial@example.com" })
    const price = await monthly(h.stripe)
    const trialEnd = Math.floor((await h.now()) + 2 * 86_400)
    const subscription = await h.stripe.subscriptions.create({
      customer: customer.id,
      items: [{ price: price.id }],
      trial_end: trialEnd,
      trial_settings: { end_behavior: { missing_payment_method: "pause" } },
    })
    expect(subscription.status).toBe("trialing")
    expect(subscription.trial_settings?.end_behavior.missing_payment_method).toBe("pause")
    await h.advance("3d")
    const paused = await h.stripe.subscriptions.retrieve(subscription.id)
    expect(paused.status).toBe("paused")
    expect((await h.events("customer.subscription.paused")).length).toBe(1)
    // No renewal invoice is created for a paused subscription.
    expect(await renewalInvoices(h.stripe, subscription.id)).toEqual([])
    const refused = await expectStripeError(
      h.stripe.subscriptions.resume(
        (await subscribe(h)).subscription.id, // an active one
      ),
    )
    expect(refused.statusCode).toBe(400)
    const card = await h.stripe.paymentMethods.attach("pm_card_visa", { customer: customer.id })
    await h.stripe.customers.update(customer.id, {
      invoice_settings: { default_payment_method: card.id },
    })
    const resumed = await h.stripe.subscriptions.resume(subscription.id, {
      billing_cycle_anchor: "now",
    })
    expect(resumed.status).toBe("active")
    expect(resumed.current_period_start).toBeGreaterThan(trialEnd)
    const latest = await h.stripe.invoices.retrieve(resumed.latest_invoice as string)
    expect(latest.status).toBe("paid")
    expect(latest.amount_paid).toBe(2_000)
    expect(latest.billing_reason).toBe("subscription_update")
    expect((await h.events("customer.subscription.resumed")).length).toBe(1)
  })

  test("resume with billing_cycle_anchor=unchanged keeps the anchor and prorates the rest", async () => {
    const h = await harness()
    const customer = await h.stripe.customers.create({ email: "trial@example.com" })
    const price = await monthly(h.stripe, 3_000)
    const trialEnd = Math.floor((await h.now()) + 2 * 86_400)
    const subscription = await h.stripe.subscriptions.create({
      customer: customer.id,
      items: [{ price: price.id }],
      trial_end: trialEnd,
      trial_settings: { end_behavior: { missing_payment_method: "pause" } },
    })
    await h.advance("12d")
    expect((await h.stripe.subscriptions.retrieve(subscription.id)).status).toBe("paused")
    const resumed = await h.stripe.subscriptions.resume(subscription.id, {
      billing_cycle_anchor: "unchanged",
      proration_behavior: "create_prorations",
    })
    expect(resumed.status).toBe("active")
    expect(resumed.current_period_start).toBe(trialEnd)
    const pending = await h.stripe.invoiceItems.list({ customer: customer.id, pending: true })
    expect(pending.data.length).toBe(1)
    const amount = pending.data[0]?.amount ?? 0
    // About two thirds of the month is left: 20 of ~30 days.
    expect(amount).toBeGreaterThan(1_800)
    expect(amount).toBeLessThan(2_200)
  })

  test("trial_settings cancel cancels at the trial's end; create_invoice (the default) goes past_due", async () => {
    const h = await harness()
    const price = await monthly(h.stripe)
    const trialEnd = Math.floor((await h.now()) + 2 * 86_400)
    const canceling = await h.stripe.subscriptions.create({
      customer: (await h.stripe.customers.create({})).id,
      items: [{ price: price.id }],
      trial_end: trialEnd,
      trial_settings: { end_behavior: { missing_payment_method: "cancel" } },
    })
    const invoicing = await h.stripe.subscriptions.create({
      customer: (await h.stripe.customers.create({})).id,
      items: [{ price: price.id }],
      trial_end: trialEnd,
    })
    await h.advance("3d")
    const canceled = await h.stripe.subscriptions.retrieve(canceling.id)
    expect(canceled.status).toBe("canceled")
    expect(canceled.ended_at).toBe(trialEnd)
    expect((await h.stripe.subscriptions.retrieve(invoicing.id)).status).toBe("past_due")
  })

  test("customer.subscription.trial_will_end fires once, three days before the trial ends", async () => {
    const h = await harness()
    const customer = await payingCustomer(h.stripe)
    const price = await monthly(h.stripe)
    const subscription = await h.stripe.subscriptions.create({
      customer: customer.id,
      items: [{ price: price.id }],
      trial_period_days: 7,
    })
    await h.advance("2d")
    expect(await h.events("customer.subscription.trial_will_end")).toEqual([])
    await h.advance("3d")
    const reminders = await h.events("customer.subscription.trial_will_end")
    expect(reminders.map((object) => object.id)).toEqual([subscription.id])
    await h.advance("1d")
    expect((await h.events("customer.subscription.trial_will_end")).length).toBe(1)
  })
})

describe("canceling and updating", () => {
  test("DELETE with prorate + invoice_now credits unused time; cancellation_details are kept", async () => {
    const h = await harness()
    const { customer, subscription } = await subscribe(h, 3_000)
    await h.advance("10d")
    const canceled = await h.stripe.subscriptions.cancel(subscription.id, {
      prorate: true,
      invoice_now: true,
      cancellation_details: { feedback: "too_expensive", comment: "Budget cuts" },
    })
    expect(canceled.status).toBe("canceled")
    expect(canceled.cancellation_details).toEqual({
      comment: "Budget cuts",
      feedback: "too_expensive",
      reason: "cancellation_requested",
    })
    const final = await h.stripe.invoices.retrieve(canceled.latest_invoice as string)
    expect(final.id).not.toBe(subscription.latest_invoice)
    expect(final.subtotal).toBeLessThan(0)
    const refreshed = await h.stripe.customers.retrieve(customer.id)
    expect((refreshed as Stripe.Customer).balance).toBe(final.subtotal)
  })

  test("update: cancellation_details, description and trial_end", async () => {
    const h = await harness()
    const { subscription } = await subscribe(h)
    const canceling = await h.stripe.subscriptions.update(subscription.id, {
      cancel_at_period_end: true,
      cancellation_details: { feedback: "unused" },
      description: "Gym membership",
    })
    expect(canceling.cancellation_details?.feedback).toBe("unused")
    expect(canceling.cancellation_details?.reason).toBe("cancellation_requested")
    expect(canceling.description).toBe("Gym membership")
    const past = await expectStripeError(
      h.stripe.subscriptions.update(subscription.id, { trial_end: subscription.created - 10 }),
    )
    expect(past.param).toBe("trial_end")
    const extended = await h.stripe.subscriptions.update(subscription.id, {
      trial_end: subscription.current_period_end + 86_400,
      proration_behavior: "none",
    })
    expect(extended.status).toBe("trialing")
  })

  test("items must be active, recurring, and share a currency and interval", async () => {
    const h = await harness()
    const customer = await payingCustomer(h.stripe)
    const price = await monthly(h.stripe)
    const yearly = await h.stripe.prices.create({
      product: price.product as string,
      currency: "usd",
      unit_amount: 20_000,
      recurring: { interval: "year" },
    })
    const mixed = await expectStripeError(
      h.stripe.subscriptions.create({
        customer: customer.id,
        items: [{ price: price.id }, { price: yearly.id }],
      }),
    )
    expect(mixed.message).toContain("interval")
    const archived = await monthly(h.stripe)
    await h.stripe.prices.update(archived.id, { active: false })
    const inactive = await expectStripeError(
      h.stripe.subscriptions.create({ customer: customer.id, items: [{ price: archived.id }] }),
    )
    expect(inactive.message).toContain("inactive")
    const subscription = await h.stripe.subscriptions.create({
      customer: customer.id,
      items: [{ price: price.id }],
    })
    const oneTime = await h.stripe.prices.create({
      product: price.product as string,
      currency: "usd",
      unit_amount: 500,
    })
    const refused = await expectStripeError(
      h.stripe.subscriptions.update(subscription.id, {
        items: [{ id: subscription.items.data[0]?.id as string, price: oneTime.id }],
      }),
    )
    expect(refused.param).toBe("items[0][price]")
  })
})

describe("review regressions", () => {
  test("a refused item change writes nothing; staying on an archived price is allowed", async () => {
    const h = await harness()
    const customer = await payingCustomer(h.stripe)
    const seat = await monthly(h.stripe, 1_000)
    const addOn = await monthly(h.stripe, 500)
    const yearly = await h.stripe.prices.create({
      product: seat.product as string,
      currency: "usd",
      unit_amount: 10_000,
      recurring: { interval: "year" },
    })
    const subscription = await h.stripe.subscriptions.create({
      customer: customer.id,
      items: [{ price: seat.id }, { price: addOn.id }],
    })
    const first = subscription.items.data[0]?.id as string
    const refused = await expectStripeError(
      h.stripe.subscriptions.update(subscription.id, {
        items: [{ id: first, price: yearly.id, quantity: 4 }],
      }),
    )
    expect(refused.statusCode).toBe(400)
    const unchanged = await h.stripe.subscriptions.retrieve(subscription.id)
    expect(unchanged.items.data[0]?.price.id).toBe(seat.id)
    expect(unchanged.items.data[0]?.quantity).toBe(1)
    await h.stripe.prices.update(seat.id, { active: false })
    const more = await h.stripe.subscriptions.update(subscription.id, {
      items: [{ id: first, price: seat.id, quantity: 3 }],
      proration_behavior: "none",
    })
    expect(more.items.data[0]?.quantity).toBe(3)
    const badDiscount = await expectStripeError(
      h.stripe.subscriptions.update(subscription.id, {
        items: [{ id: first, quantity: 5 }],
        discounts: [{ coupon: "coupon_nope" }],
      }),
    )
    expect(badDiscount.statusCode).toBe(404)
    expect((await h.stripe.subscriptions.retrieve(subscription.id)).items.data[0]?.quantity).toBe(3)
  })

  test("trial_end=now ends the trial through the API and sends the trial reminder", async () => {
    const h = await harness()
    const customer = await payingCustomer(h.stripe)
    const price = await monthly(h.stripe)
    const subscription = await h.stripe.subscriptions.create({
      customer: customer.id,
      items: [{ price: price.id }],
      trial_period_days: 30,
    })
    const ended = await h.stripe.subscriptions.update(subscription.id, { trial_end: "now" })
    expect(ended.status).toBe("active")
    expect((await h.events("customer.subscription.trial_will_end")).length).toBe(1)
    const invoice = await h.stripe.invoices.retrieve(ended.latest_invoice as string)
    expect(invoice.amount_paid).toBe(2_000)
  })

  test("a prorated cancel credits what was paid after discounts", async () => {
    const h = await harness()
    const customer = await payingCustomer(h.stripe)
    const price = await monthly(h.stripe, 2_000)
    const coupon = await h.stripe.coupons.create({ percent_off: 50, duration: "forever" })
    const subscription = await h.stripe.subscriptions.create({
      customer: customer.id,
      items: [{ price: price.id }],
      discounts: [{ coupon: coupon.id }],
    })
    await h.advance("15d")
    await h.stripe.subscriptions.cancel(subscription.id, { prorate: true, invoice_now: true })
    const balance = ((await h.stripe.customers.retrieve(customer.id)) as Stripe.Customer).balance
    // Half the period of a $10 (discounted) plan: about $5 back, not $10.
    expect(balance).toBeLessThan(-400)
    expect(balance).toBeGreaterThan(-600)
  })
})

// --- hosted Checkout ------------------------------------------------------------------------------

const post = (url: string, fields: Record<string, string>) =>
  fetch(url, { method: "POST", redirect: "manual", body: new URLSearchParams(fields) })

const pay = (url: string, card: string, extra: Record<string, string> = {}) =>
  post(url, { action: "pay", card, exp: "12 / 34", cvc: "123", zip: "94107", ...extra })

describe("hosted Checkout", () => {
  test("subscription mode completes a 3-D Secure card on the page and bills one-time lines once", async () => {
    const h = await harness()
    const price = await monthly(h.stripe, 4_900, "Studio")
    const session = await h.stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [
        { price: price.id, quantity: 1 },
        {
          price_data: { currency: "usd", unit_amount: 1_500, product_data: { name: "Setup fee" } },
          quantity: 1,
        },
      ],
      client_reference_id: "user_42",
      success_url: "http://localhost/done?session={CHECKOUT_SESSION_ID}",
    })
    const lines = await h.stripe.checkout.sessions.listLineItems(session.id)
    expect(lines.data.every((line) => typeof line.price?.id === "string")).toBe(true)
    const paid = await pay(session.url as string, "4000002760003184", {
      email: "shopper@example.com",
      name: "Jenny Rosen",
    })
    expect(paid.status).toBe(302)
    const done = await h.stripe.checkout.sessions.retrieve(session.id)
    expect(done.status).toBe("complete")
    expect(done.payment_status).toBe("paid")
    expect(done.client_reference_id).toBe("user_42")
    expect(done.customer_details?.email).toBe("shopper@example.com")
    const subscription = await h.stripe.subscriptions.retrieve(done.subscription as string)
    expect(subscription.status).toBe("active")
    expect(subscription.items.data.map((item) => item.price.id)).toEqual([price.id])
    const invoice = await h.stripe.invoices.retrieve(subscription.latest_invoice as string)
    expect(invoice.amount_paid).toBe(6_400)
    const customer = (await h.stripe.customers.retrieve(done.customer as string)) as Stripe.Customer
    expect(customer.email).toBe("shopper@example.com")
    expect(customer.name).toBe("Jenny Rosen")
  })

  test("recurring price_data creates an inline recurring price the subscription uses", async () => {
    const h = await harness()
    const session = await h.stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [
        {
          price_data: {
            currency: "usd",
            unit_amount: 999,
            recurring: { interval: "month" },
            product_data: { name: "Inline plan" },
          },
          quantity: 2,
        },
      ],
      success_url: "http://localhost/done",
    })
    expect((await pay(session.url as string, "4242424242424242")).status).toBe(302)
    const done = await h.stripe.checkout.sessions.retrieve(session.id)
    const subscription = await h.stripe.subscriptions.retrieve(done.subscription as string)
    expect(subscription.items.data[0]?.quantity).toBe(2)
    expect(subscription.items.data[0]?.price.unit_amount).toBe(999)
    expect(subscription.items.data[0]?.price.active).toBe(false)
  })

  test("a free trial with payment_method_collection=if_required asks for no card", async () => {
    const h = await harness()
    const price = await monthly(h.stripe)
    const session = await h.stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [{ price: price.id, quantity: 1 }],
      payment_method_collection: "if_required",
      subscription_data: {
        trial_period_days: 14,
        trial_settings: { end_behavior: { missing_payment_method: "pause" } },
      },
      success_url: "http://localhost/done",
    })
    expect(session.payment_method_collection).toBe("if_required")
    const page = await (await fetch(session.url as string)).text()
    expect(page).toContain('data-testid="stripe-mock-no-card"')
    expect(page).not.toContain('data-testid="stripe-mock-card"')
    expect(page).toContain("Start trial")
    const done = await post(session.url as string, {
      action: "pay",
      email: "trialist@example.com",
    })
    expect(done.status).toBe(302)
    const completed = await h.stripe.checkout.sessions.retrieve(session.id)
    expect(completed.payment_status).toBe("no_payment_required")
    const subscription = await h.stripe.subscriptions.retrieve(completed.subscription as string)
    expect(subscription.status).toBe("trialing")
    expect(subscription.default_payment_method).toBeNull()
    expect(subscription.trial_settings?.end_behavior.missing_payment_method).toBe("pause")
    expect(
      (await h.stripe.paymentMethods.list({ customer: completed.customer as string })).data,
    ).toEqual([])
  })

  test("promotion codes: the page applies, refuses and removes them; payment reflects the discount", async () => {
    const h = await harness()
    const product = await h.stripe.products.create({ name: "Mat" })
    const coupon = await h.stripe.coupons.create({ percent_off: 25, duration: "once" })
    await h.stripe.promotionCodes.create({ coupon: coupon.id, code: "SPRING25" })
    const session = await h.stripe.checkout.sessions.create({
      mode: "payment",
      allow_promotion_codes: true,
      line_items: [
        { price_data: { currency: "usd", unit_amount: 4_000, product: product.id }, quantity: 1 },
      ],
      success_url: "http://localhost/done",
    })
    expect(session.allow_promotion_codes).toBe(true)
    const url = session.url as string
    const refused = await (
      await post(url, { action: "apply_promotion_code", promotion_code: "NOPE" })
    ).text()
    expect(refused).toContain('data-testid="stripe-mock-promotion-error"')
    expect(refused).toContain("This code is invalid.")
    const applied = await (
      await post(url, { action: "apply_promotion_code", promotion_code: "spring25" })
    ).text()
    expect(applied).toContain('data-testid="stripe-mock-promotion-applied"')
    expect(applied).toContain("Pay $30.00")
    expect((await h.stripe.checkout.sessions.retrieve(session.id)).amount_total).toBe(3_000)
    const removed = await (await post(url, { action: "remove_promotion_code" })).text()
    expect(removed).toContain("Pay $40.00")
    await post(url, { action: "apply_promotion_code", promotion_code: "SPRING25" })
    expect((await pay(url, "4242424242424242")).status).toBe(302)
    const done = await h.stripe.checkout.sessions.retrieve(session.id, {
      expand: ["payment_intent"],
    })
    expect((done.payment_intent as Stripe.PaymentIntent).amount).toBe(3_000)
    expect(done.total_details?.amount_discount).toBe(1_000)
    expect((await h.stripe.coupons.retrieve(coupon.id)).times_redeemed).toBe(1)
  })

  test("a trial with a one-time setup fee charges the fee and stays trialing", async () => {
    const h = await harness()
    const price = await monthly(h.stripe)
    const session = await h.stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [
        { price: price.id, quantity: 1 },
        {
          price_data: { currency: "usd", unit_amount: 500, product_data: { name: "Setup" } },
          quantity: 1,
        },
      ],
      subscription_data: { trial_period_days: 14 },
      success_url: "http://localhost/done",
    })
    const page = await (await fetch(session.url as string)).text()
    expect(page).toContain('data-testid="stripe-mock-due">$5.00')
    expect((await pay(session.url as string, "4242424242424242")).status).toBe(302)
    const done = await h.stripe.checkout.sessions.retrieve(session.id)
    const subscription = await h.stripe.subscriptions.retrieve(done.subscription as string)
    expect(subscription.status).toBe("trialing")
    const invoice = await h.stripe.invoices.retrieve(subscription.latest_invoice as string)
    expect(invoice.amount_paid).toBe(500)
  })

  test("promotion codes are refused on a session that did not allow them", async () => {
    const h = await harness()
    const coupon = await h.stripe.coupons.create({ percent_off: 50, duration: "once" })
    await h.stripe.promotionCodes.create({ coupon: coupon.id, code: "HALF" })
    const session = await h.stripe.checkout.sessions.create({
      mode: "payment",
      line_items: [
        {
          price_data: { currency: "usd", unit_amount: 1_000, product_data: { name: "Mat" } },
          quantity: 1,
        },
      ],
      success_url: "http://localhost/done",
    })
    const refused = await (
      await post(session.url as string, { action: "apply_promotion_code", promotion_code: "HALF" })
    ).text()
    expect(refused).toContain("Promotion codes are not accepted")
    expect((await h.stripe.checkout.sessions.retrieve(session.id)).amount_total).toBe(1_000)
  })

  test("the page checks card fields, and a decline creates no customer", async () => {
    const h = await harness()
    const price = await monthly(h.stripe)
    const session = await h.stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [{ price: price.id, quantity: 1 }],
      success_url: "http://localhost/done",
    })
    const url = session.url as string
    const expired = await (await pay(url, "4242424242424242", { exp: "01 / 20" })).text()
    expect(expired).toContain("Your card&#39;s expiration year is in the past.")
    const cvc = await (await pay(url, "4242424242424242", { cvc: "1" })).text()
    expect(cvc).toContain("Your card&#39;s security code is incomplete.")
    const email = await (await pay(url, "4242424242424242", { email: "nope" })).text()
    expect(email).toContain("Your email address is invalid.")
    const declined = await (await pay(url, "4000000000000002")).text()
    expect(declined).toContain('data-testid="stripe-mock-error"')
    expect((await h.stripe.customers.list({ limit: 100 })).data).toEqual([])
    expect((await h.stripe.checkout.sessions.retrieve(session.id)).status).toBe("open")
  })

  test("session parameters are validated like Stripe's", async () => {
    const h = await harness()
    const customer = await h.stripe.customers.create({ email: "a@example.com" })
    const price = await monthly(h.stripe)
    const oneTime = await h.stripe.prices.create({
      product: price.product as string,
      currency: "usd",
      unit_amount: 500,
    })
    const cases: Array<[Stripe.Checkout.SessionCreateParams, string]> = [
      [
        {
          mode: "payment",
          customer: customer.id,
          customer_email: "a@example.com",
          line_items: [{ price: oneTime.id, quantity: 1 }],
        },
        "customer_email",
      ],
      [{ mode: "payment", line_items: [{ price: price.id, quantity: 1 }] }, "recurring price"],
      [
        {
          mode: "payment",
          allow_promotion_codes: true,
          discounts: [
            { coupon: (await h.stripe.coupons.create({ percent_off: 5, duration: "once" })).id },
          ],
          line_items: [{ price: oneTime.id, quantity: 1 }],
        },
        "allow_promotion_codes",
      ],
      [
        {
          mode: "payment",
          subscription_data: { trial_period_days: 3 },
          line_items: [{ price: oneTime.id, quantity: 1 }],
        },
        "subscription_data",
      ],
      [
        {
          mode: "subscription",
          customer_creation: "always",
          line_items: [{ price: price.id, quantity: 1 }],
        },
        "customer_creation",
      ],
      [{ mode: "payment", line_items: [{ price: oneTime.id, quantity: 0 }] }, "greater than"],
    ]
    for (const [params, fragment] of cases) {
      const error = await expectStripeError(
        h.stripe.checkout.sessions.create({ success_url: "http://localhost/s", ...params }),
      )
      expect(error.statusCode).toBe(400)
      expect(error.message).toContain(fragment)
    }
  })
})

describe("changing to a price with a different billing interval", () => {
  // https://docs.stripe.com/billing/subscriptions/change-price#billing-periods and
  // https://docs.stripe.com/billing/subscriptions/billing-cycle#changing: the billing cycle anchor
  // resets to the moment of the change and the new period is invoiced and paid at once.
  const yearly = async (stripe: Stripe, amount = 6_000) => {
    const product = await stripe.products.create({ name: "Plus" })
    return stripe.prices.create({
      product: product.id,
      currency: "usd",
      unit_amount: amount,
      recurring: { interval: "year" },
    })
  }

  for (const proration_behavior of ["always_invoice", "create_prorations"] as const) {
    test(`monthly to yearly (${proration_behavior}) restarts the period now and invoices the year`, async () => {
      const h = await harness()
      const { subscription, price } = await subscribe(h, 700)
      const year = await yearly(h.stripe)
      await h.advance("10d")
      const updated = await h.stripe.subscriptions.update(subscription.id, {
        items: [{ id: subscription.items.data[0]?.id ?? "", price: year.id }],
        proration_behavior,
      })
      const now = await h.now()
      const item = updated.items.data[0]
      expect(item?.price.id).toBe(year.id)
      expect(Math.abs(updated.billing_cycle_anchor - now)).toBeLessThan(5)
      expect(Math.abs(updated.current_period_start - now)).toBeLessThan(5)
      const period = new Date(updated.billing_cycle_anchor * 1000)
      period.setUTCFullYear(period.getUTCFullYear() + 1)
      expect(updated.current_period_end).toBe(Math.floor(period.getTime() / 1000))
      expect(updated.status).toBe("active")
      expect(updated.latest_invoice).not.toBe(subscription.latest_invoice)
      const invoice = await h.stripe.invoices.retrieve(updated.latest_invoice as string)
      expect(invoice.billing_reason).toBe("subscription_update")
      expect(invoice.status).toBe("paid")
      const credit = invoice.lines.data.find((line) => line.amount < 0)
      expect(credit?.amount).toBeLessThan(0)
      expect(credit?.amount).toBeGreaterThan(-(price.unit_amount ?? 0))
      expect(invoice.lines.data.find((line) => line.amount > 0)?.amount).toBe(6_000)
      expect(invoice.total).toBe(6_000 + (credit?.amount ?? 0))
      const sent = (await h.events("customer.subscription.updated")).find(
        (object) => object.id === subscription.id,
      )
      expect(sent?.billing_cycle_anchor).toBe(updated.billing_cycle_anchor)
    })
  }

  test("proration_behavior=none bills the full new period with no credit", async () => {
    const h = await harness()
    const { subscription } = await subscribe(h, 700)
    const year = await yearly(h.stripe)
    await h.advance("10d")
    const updated = await h.stripe.subscriptions.update(subscription.id, {
      items: [{ id: subscription.items.data[0]?.id ?? "", price: year.id }],
      proration_behavior: "none",
    })
    const invoice = await h.stripe.invoices.retrieve(updated.latest_invoice as string)
    expect(invoice.total).toBe(6_000)
    expect(invoice.lines.data.every((line) => line.amount >= 0)).toBe(true)
  })

  test("a declined charge leaves the change made and the subscription past_due", async () => {
    const h = await harness()
    const customer = await payingCustomer(h.stripe)
    const price = await monthly(h.stripe, 700)
    const subscription = await h.stripe.subscriptions.create({
      customer: customer.id,
      items: [{ price: price.id }],
    })
    const declined = await h.stripe.paymentMethods.attach("pm_card_chargeCustomerFail", {
      customer: customer.id,
    })
    await h.stripe.customers.update(customer.id, {
      invoice_settings: { default_payment_method: declined.id },
    })
    const year = await yearly(h.stripe)
    const updated = await h.stripe.subscriptions.update(subscription.id, {
      items: [{ id: subscription.items.data[0]?.id ?? "", price: year.id }],
    })
    expect(updated.items.data[0]?.price.id).toBe(year.id)
    expect(updated.status).toBe("past_due")
    const invoice = await h.stripe.invoices.retrieve(updated.latest_invoice as string)
    expect(invoice.status).toBe("open")
    // The decline starts the automatic retries: a working card pays the invoice on the next one.
    expect(invoice.attempt_count).toBe(1)
    expect(invoice.next_payment_attempt).not.toBeNull()
    const good = await h.stripe.paymentMethods.attach("pm_card_visa", { customer: customer.id })
    await h.stripe.customers.update(customer.id, {
      invoice_settings: { default_payment_method: good.id },
    })
    await h.advance("4d")
    const retried = await h.stripe.invoices.retrieve(invoice.id)
    expect(retried.status).toBe("paid")
    expect((await h.stripe.subscriptions.retrieve(subscription.id)).status).toBe("active")
  })

  test("the same interval keeps the anchor and period; a trial keeps its end", async () => {
    const h = await harness()
    const { subscription } = await subscribe(h, 700)
    const other = await monthly(h.stripe, 1_500, "Max")
    await h.advance("10d")
    const same = await h.stripe.subscriptions.update(subscription.id, {
      items: [{ id: subscription.items.data[0]?.id ?? "", price: other.id }],
      proration_behavior: "always_invoice",
    })
    expect(same.billing_cycle_anchor).toBe(subscription.billing_cycle_anchor)
    expect(same.current_period_end).toBe(subscription.current_period_end)

    const customer = await payingCustomer(h.stripe)
    const trialing = await h.stripe.subscriptions.create({
      customer: customer.id,
      items: [{ price: other.id }],
      trial_period_days: 14,
    })
    const year = await yearly(h.stripe)
    const switched = await h.stripe.subscriptions.update(trialing.id, {
      items: [{ id: trialing.items.data[0]?.id ?? "", price: year.id }],
    })
    expect(switched.status).toBe("trialing")
    expect(switched.trial_end).toBe(trialing.trial_end)
    expect(switched.billing_cycle_anchor).toBe(trialing.billing_cycle_anchor)
    expect(switched.latest_invoice).toBe(trialing.latest_invoice)
  })
})
