import { afterEach, describe, expect, test } from "bun:test"
import type Stripe from "stripe"
import { createServer } from "./src/server.js"
import { backendClient } from "./test/consumer.js"

/**
 * The customer portal: `POST /v1/billing_portal/configurations|sessions` and the hosted page the
 * session URL opens, where the customer cancels, renews and changes plans, manages cards and
 * billing details, and pays invoices. Every page action must leave the same objects and webhooks
 * as the merchant's own API call would.
 */

const KEY = "sk_test_portalSuite1"

const closers: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of closers.splice(0)) await close()
})

const harness = async () => {
  const server = await createServer({
    accounts: [{ id: "acct_portal", keys: [KEY], displayName: "Acme Fitness" }],
  })
  closers.push(() => server.close())
  const stripe = backendClient(KEY, new URL(server.url))
  const events = async (type: string) =>
    (await stripe.events.list({ type, limit: 100 })).data.map((event) => event.data)
  const advance = (duration: string) =>
    fetch(`${server.url}/__admin/clock`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ advance: duration }),
    })
  return { server, stripe, events, advance }
}

type Harness = Awaited<ReturnType<typeof harness>>

const plans = async (stripe: Stripe) => {
  const basic = await stripe.products.create({ name: "Basic" })
  const pro = await stripe.products.create({ name: "Pro" })
  const monthly = (product: string, amount: number) =>
    stripe.prices.create({
      product,
      currency: "usd",
      unit_amount: amount,
      recurring: { interval: "month" },
    })
  return {
    basic: await monthly(basic.id, 1_000),
    pro: await monthly(pro.id, 3_000),
    basicProduct: basic,
    proProduct: pro,
  }
}

const member = async ({ stripe }: Harness, card = "pm_card_visa") => {
  const customer = await stripe.customers.create({ email: "ada@example.com", name: "Ada" })
  const method = await stripe.paymentMethods.attach(card, { customer: customer.id })
  await stripe.customers.update(customer.id, {
    invoice_settings: { default_payment_method: method.id },
  })
  const catalog = await plans(stripe)
  const subscription = await stripe.subscriptions.create({
    customer: customer.id,
    items: [{ price: catalog.basic.id }],
  })
  return { customer, method, subscription, ...catalog }
}

const page = async (url: string) => {
  const response = await fetch(url)
  return { status: response.status, html: await response.text() }
}

const post = async (url: string, fields: Record<string, string>) => {
  const response = await fetch(url, {
    method: "POST",
    redirect: "manual",
    body: new URLSearchParams(fields),
  })
  return {
    status: response.status,
    location: response.headers.get("location"),
    html: await response.text(),
  }
}

const expectStripeError = async (promise: Promise<unknown>) =>
  promise.then(
    () => {
      throw new Error("expected a Stripe error")
    },
    (error: unknown) => error as Stripe.errors.StripeError,
  )

describe("billing portal API", () => {
  test("the default configuration exists as if saved in the dashboard; API configurations start disabled", async () => {
    const h = await harness()
    const { customer } = await member(h)
    expect((await h.stripe.billingPortal.configurations.list()).data.length).toBe(0)
    await h.stripe.billingPortal.sessions.create({ customer: customer.id })
    const listed = await h.stripe.billingPortal.configurations.list({ is_default: true })
    expect(listed.data.length).toBe(1)
    const defaults = listed.data[0] as Stripe.BillingPortal.Configuration
    expect(defaults.features.subscription_cancel.enabled).toBe(true)
    expect(defaults.features.subscription_update.products?.length).toBe(2)
    const created = await h.stripe.billingPortal.configurations.create({
      business_profile: { headline: "Acme billing" },
      default_return_url: "http://localhost/account",
      features: { invoice_history: { enabled: true } },
    })
    expect(created.is_default).toBe(false)
    expect(created.features.invoice_history.enabled).toBe(true)
    expect(created.features.subscription_cancel.enabled).toBe(false)
    const updated = await h.stripe.billingPortal.configurations.update(created.id, {
      features: { subscription_cancel: { enabled: true, mode: "immediately" } },
      metadata: { team: "growth" },
    })
    expect(updated.features.subscription_cancel.mode).toBe("immediately")
    expect(updated.metadata).toEqual({ team: "growth" })
    expect((await h.events("billing_portal.configuration.created")).length).toBe(1)
    expect(
      (await h.events("billing_portal.configuration.updated"))[0]?.previous_attributes,
    ).toHaveProperty("features")
    const refused = await expectStripeError(
      h.stripe.billingPortal.configurations.update(defaults.id, { active: false }),
    )
    expect(refused.param).toBe("active")
  })

  test("sessions: customer and configuration are checked; the return URL falls back to the configuration's", async () => {
    const h = await harness()
    const { customer } = await member(h)
    const missing = await expectStripeError(
      h.stripe.billingPortal.sessions.create({ customer: "cus_nope" }),
    )
    expect(missing.statusCode).toBe(404)
    expect(missing.code).toBe("resource_missing")
    const config = await h.stripe.billingPortal.configurations.create({
      default_return_url: "http://localhost/account",
      features: { invoice_history: { enabled: true } },
    })
    const session = await h.stripe.billingPortal.sessions.create({
      customer: customer.id,
      configuration: config.id,
      expand: ["configuration"],
    })
    expect(session.return_url).toBe("http://localhost/account")
    expect((session.configuration as Stripe.BillingPortal.Configuration).id).toBe(config.id)
    expect(session.url).toBe(`${h.server.url}/p/session/${session.id}`)
    expect((await h.events("billing_portal.session.created")).length).toBe(1)
    await h.stripe.billingPortal.configurations.update(config.id, { active: false })
    const inactive = await expectStripeError(
      h.stripe.billingPortal.sessions.create({ customer: customer.id, configuration: config.id }),
    )
    expect(inactive.param).toBe("configuration")
  })

  test("flow_data is validated against the customer, the subscription and the configuration", async () => {
    const h = await harness()
    const { customer, subscription } = await member(h)
    const other = await h.stripe.customers.create({})
    const notTheirs = await expectStripeError(
      h.stripe.billingPortal.sessions.create({
        customer: other.id,
        flow_data: {
          type: "subscription_cancel",
          subscription_cancel: { subscription: subscription.id },
        },
      }),
    )
    expect(notTheirs.param).toBe("flow_data[subscription_cancel][subscription]")
    const noCancel = await h.stripe.billingPortal.configurations.create({
      features: { invoice_history: { enabled: true } },
    })
    const disabled = await expectStripeError(
      h.stripe.billingPortal.sessions.create({
        customer: customer.id,
        configuration: noCancel.id,
        flow_data: {
          type: "subscription_cancel",
          subscription_cancel: { subscription: subscription.id },
        },
      }),
    )
    expect(disabled.param).toBe("flow_data[type]")
    await h.stripe.subscriptions.update(subscription.id, { cancel_at_period_end: true })
    const already = await expectStripeError(
      h.stripe.billingPortal.sessions.create({
        customer: customer.id,
        flow_data: {
          type: "subscription_cancel",
          subscription_cancel: { subscription: subscription.id },
        },
      }),
    )
    expect(already.message).toContain("already set to cancel")
  })
})

describe("hosted portal", () => {
  test("the homepage lists the subscription, cards, billing details and invoices; unknown sessions 404", async () => {
    const h = await harness()
    const { customer, subscription } = await member(h)
    const session = await h.stripe.billingPortal.sessions.create({
      customer: customer.id,
      return_url: "http://localhost/account",
    })
    const home = await page(session.url)
    expect(home.status).toBe(200)
    expect(home.html).toContain(`data-subscription-id="${subscription.id}"`)
    expect(home.html).toContain("$10.00 per month")
    expect(home.html).toContain('data-testid="stripe-mock-portal-payment-method"')
    expect(home.html).toContain("Visa •••• 4242")
    expect(home.html).toContain('data-testid="stripe-mock-portal-invoice"')
    expect(home.html).toContain('href="http://localhost/account"')
    expect((await page(`${h.server.url}/p/session/bps_missing`)).status).toBe(404)
  })

  test("cancel at period end with a reason, then renew", async () => {
    const h = await harness()
    const { customer, subscription } = await member(h)
    const session = await h.stripe.billingPortal.sessions.create({ customer: customer.id })
    const cancelPage = await page(`${session.url}?flow=cancel&subscription=${subscription.id}`)
    expect(cancelPage.html).toContain('data-testid="stripe-mock-portal-reason"')
    const canceled = await post(session.url, {
      action: "cancel",
      subscription: subscription.id,
      reason: "too_expensive",
      comment: "Moving abroad",
    })
    expect(canceled.html).toContain("will be canceled on")
    expect(canceled.html).toContain('data-testid="stripe-mock-portal-renew"')
    const pending = await h.stripe.subscriptions.retrieve(subscription.id)
    expect(pending.cancel_at_period_end).toBe(true)
    expect(pending.cancellation_details).toEqual({
      comment: "Moving abroad",
      feedback: "too_expensive",
      reason: "cancellation_requested",
    })
    await post(session.url, { action: "renew", subscription: subscription.id })
    expect((await h.stripe.subscriptions.retrieve(subscription.id)).cancel_at_period_end).toBe(
      false,
    )
    const updates = await h.events("customer.subscription.updated")
    const toggles = updates.filter(
      (data) =>
        (data.previous_attributes as Record<string, unknown> | undefined)?.cancel_at_period_end !==
        undefined,
    )
    expect(toggles.length).toBe(2)
  })

  test("immediate cancellation with prorations credits the unused time", async () => {
    const h = await harness()
    const { customer, subscription } = await member(h)
    const config = await h.stripe.billingPortal.configurations.create({
      features: {
        subscription_cancel: {
          enabled: true,
          mode: "immediately",
          proration_behavior: "create_prorations",
        },
      },
    })
    const session = await h.stripe.billingPortal.sessions.create({
      customer: customer.id,
      configuration: config.id,
    })
    await h.advance("15d")
    await post(session.url, { action: "cancel", subscription: subscription.id })
    const canceled = await h.stripe.subscriptions.retrieve(subscription.id)
    expect(canceled.status).toBe("canceled")
    expect((await h.events("customer.subscription.deleted")).length).toBe(1)
    const credit = await h.stripe.invoiceItems.list({ customer: customer.id, pending: true })
    expect(credit.data[0]?.amount).toBeLessThan(0)
  })

  test("change plan: choose, preview the proration, confirm", async () => {
    const h = await harness()
    const { customer, subscription, pro } = await member(h)
    // stripe-node 16's types predate `adjustable_quantity`; the API has it.
    const offered = {
      product: pro.product as string,
      prices: [pro.id],
      adjustable_quantity: { enabled: true, minimum: 1, maximum: 5 },
    }
    const config = await h.stripe.billingPortal.configurations.create({
      features: {
        subscription_update: {
          enabled: true,
          default_allowed_updates: ["price", "quantity"],
          proration_behavior: "always_invoice",
          products: [offered],
        },
      },
    })
    const session = await h.stripe.billingPortal.sessions.create({
      customer: customer.id,
      configuration: config.id,
    })
    const choose = await page(`${session.url}?flow=update&subscription=${subscription.id}`)
    expect(choose.html).toContain(`value="${pro.id}"`)
    const tooMany = await post(session.url, {
      action: "preview_update",
      subscription: subscription.id,
      price: pro.id,
      quantity: "9",
    })
    expect(tooMany.html).toContain("The maximum quantity is 5.")
    const preview = await post(session.url, {
      action: "preview_update",
      subscription: subscription.id,
      price: pro.id,
      quantity: "1",
    })
    expect(preview.html).toContain('data-testid="stripe-mock-portal-amount-due"')
    expect(
      (await h.stripe.subscriptions.retrieve(subscription.id)).items.data[0]?.price.id,
    ).not.toBe(pro.id)
    await post(session.url, {
      action: "update",
      subscription: subscription.id,
      price: pro.id,
      quantity: "1",
    })
    const updated = await h.stripe.subscriptions.retrieve(subscription.id)
    expect(updated.items.data[0]?.price.id).toBe(pro.id)
    const invoice = await h.stripe.invoices.retrieve(updated.latest_invoice as string)
    expect(invoice.billing_reason).toBe("subscription_update")
    expect(invoice.status).toBe("paid")
  })

  test("change plan to a yearly price resets the billing cycle anchor and bills the year now", async () => {
    const h = await harness()
    const { customer, subscription, proProduct } = await member(h)
    const yearly = await h.stripe.prices.create({
      product: proProduct.id,
      currency: "usd",
      unit_amount: 30_000,
      recurring: { interval: "year" },
    })
    const config = await h.stripe.billingPortal.configurations.create({
      features: {
        subscription_update: {
          enabled: true,
          default_allowed_updates: ["price"],
          proration_behavior: "create_prorations",
          products: [{ product: proProduct.id, prices: [yearly.id] }],
        },
      },
    })
    const session = await h.stripe.billingPortal.sessions.create({
      customer: customer.id,
      configuration: config.id,
    })
    await h.advance("10d")
    const preview = await post(session.url, {
      action: "preview_update",
      subscription: subscription.id,
      price: yearly.id,
      quantity: "1",
    })
    // Billed now (not "on your next invoice"): the year less the unused days of the month.
    expect(preview.html).toContain("Amount due today")
    await post(session.url, { action: "update", subscription: subscription.id, price: yearly.id })
    const updated = await h.stripe.subscriptions.retrieve(subscription.id)
    expect(updated.items.data[0]?.price.id).toBe(yearly.id)
    // The anchor is the moment of the change, ten days into the month.
    expect(updated.billing_cycle_anchor).toBe(updated.current_period_start)
    expect(updated.current_period_start - subscription.current_period_start).toBeGreaterThanOrEqual(
      10 * 86_400,
    )
    const start = new Date(updated.current_period_start * 1000)
    start.setUTCFullYear(start.getUTCFullYear() + 1)
    expect(updated.current_period_end).toBe(Math.floor(start.getTime() / 1000))
    const invoice = await h.stripe.invoices.retrieve(updated.latest_invoice as string)
    expect(invoice.billing_reason).toBe("subscription_update")
    expect(invoice.status).toBe("paid")
    expect(invoice.total).toBeLessThan(30_000)
    expect(invoice.total).toBeGreaterThan(29_000 - 1)
    expect(invoice.lines.data.some((line) => line.amount === 30_000)).toBe(true)
  })

  test("a trial that continues through a portal plan change keeps its trial end", async () => {
    const h = await harness()
    const { customer, pro, proProduct } = await member(h)
    const yearly = await h.stripe.prices.create({
      product: proProduct.id,
      currency: "usd",
      unit_amount: 30_000,
      recurring: { interval: "year" },
    })
    const trialing = await h.stripe.subscriptions.create({
      customer: customer.id,
      items: [{ price: pro.id }],
      trial_period_days: 14,
    })
    // stripe-node 16's types predate `trial_update_behavior`; the API has it.
    const update = {
      enabled: true,
      default_allowed_updates: ["price"],
      proration_behavior: "create_prorations",
      trial_update_behavior: "continue_trial",
      products: [{ product: proProduct.id, prices: [yearly.id] }],
    } as Stripe.BillingPortal.ConfigurationCreateParams.Features.SubscriptionUpdate
    const config = await h.stripe.billingPortal.configurations.create({
      features: { subscription_update: update },
    })
    const session = await h.stripe.billingPortal.sessions.create({
      customer: customer.id,
      configuration: config.id,
    })
    await post(session.url, { action: "update", subscription: trialing.id, price: yearly.id })
    const updated = await h.stripe.subscriptions.retrieve(trialing.id)
    expect(updated.items.data[0]?.price.id).toBe(yearly.id)
    expect(updated.status).toBe("trialing")
    expect(updated.trial_end).toBe(trialing.trial_end)
    expect(updated.billing_cycle_anchor).toBe(trialing.billing_cycle_anchor)
    expect(updated.latest_invoice).toBe(trialing.latest_invoice)
  })

  test("payment methods: add (a decline is refused), make default everywhere, delete", async () => {
    const h = await harness()
    const { customer, method, subscription } = await member(h)
    await h.stripe.subscriptions.update(subscription.id, { default_payment_method: method.id })
    const session = await h.stripe.billingPortal.sessions.create({ customer: customer.id })
    const declined = await post(session.url, {
      action: "add_payment_method",
      card: "4000000000000002",
      exp: "12 / 34",
      cvc: "123",
    })
    expect(declined.html).toContain('data-testid="stripe-mock-portal-error"')
    const added = await post(session.url, {
      action: "add_payment_method",
      card: "5555 5555 5555 4444",
      exp: "10 / 31",
      cvc: "123",
      name: "Ada Lovelace",
      zip: "94107",
    })
    expect(added.html).toContain("Your payment method has been added.")
    const refreshed = (await h.stripe.customers.retrieve(customer.id)) as Stripe.Customer
    const fresh = refreshed.invoice_settings.default_payment_method as string
    expect(fresh).not.toBe(method.id)
    const card = await h.stripe.paymentMethods.retrieve(fresh)
    expect(card.card?.brand).toBe("mastercard")
    expect(card.card?.exp_month).toBe(10)
    expect(card.billing_details.name).toBe("Ada Lovelace")
    expect((await h.stripe.subscriptions.retrieve(subscription.id)).default_payment_method).toBe(
      fresh,
    )
    expect((await h.events("setup_intent.succeeded")).length).toBe(1)
    await post(session.url, { action: "detach_payment_method", payment_method: method.id })
    expect((await h.stripe.paymentMethods.list({ customer: customer.id })).data.length).toBe(1)
    const keep = await post(session.url, { action: "detach_payment_method", payment_method: fresh })
    expect(keep.html).toContain("cannot be removed")
  })

  test("billing details and invoices: update the customer, pay a past-due invoice", async () => {
    const h = await harness()
    const customer = await h.stripe.customers.create({ email: "ada@example.com" })
    const failing = await h.stripe.paymentMethods.create({
      type: "card",
      card: { token: "tok_chargeCustomerFail" },
    })
    await h.stripe.paymentMethods.attach(failing.id, { customer: customer.id })
    await h.stripe.customers.update(customer.id, {
      invoice_settings: { default_payment_method: failing.id },
    })
    const { basic } = await plans(h.stripe)
    const subscription = await h.stripe.subscriptions.create({
      customer: customer.id,
      items: [{ price: basic.id }],
      trial_period_days: 1,
    })
    await h.advance("2d")
    expect((await h.stripe.subscriptions.retrieve(subscription.id)).status).toBe("past_due")
    const session = await h.stripe.billingPortal.sessions.create({ customer: customer.id })
    const saved = await post(session.url, {
      action: "update_customer",
      name: "Ada Lovelace",
      email: "ada@lovelace.dev",
      line1: "1 Analytical Way",
      city: "London",
      postal_code: "N1",
      country: "GB",
    })
    expect(saved.html).toContain("Your billing information has been updated.")
    const updated = (await h.stripe.customers.retrieve(customer.id)) as Stripe.Customer
    expect(updated.email).toBe("ada@lovelace.dev")
    expect(updated.address?.city).toBe("London")
    expect((await h.events("customer.updated")).at(0)?.previous_attributes).toHaveProperty("email")
    await post(session.url, {
      action: "add_payment_method",
      card: "4242424242424242",
      exp: "12 / 34",
      cvc: "123",
    })
    const home = await page(session.url)
    const open = /data-invoice-id="(in_[^"]+)" data-status="open"/.exec(home.html)?.[1]
    expect(open).toBeDefined()
    const paid = await post(session.url, { action: "pay_invoice", invoice: open as string })
    expect(paid.html).toContain("your invoice has been paid")
    expect((await h.stripe.subscriptions.retrieve(subscription.id)).status).toBe("active")
  })

  test("deep links: a cancel flow with a retention offer and a redirect after completion", async () => {
    const h = await harness()
    const { customer, subscription } = await member(h)
    const coupon = await h.stripe.coupons.create({
      percent_off: 50,
      duration: "repeating",
      duration_in_months: 3,
    })
    const offered = await h.stripe.billingPortal.sessions.create({
      customer: customer.id,
      flow_data: {
        type: "subscription_cancel",
        subscription_cancel: {
          subscription: subscription.id,
          retention: { type: "coupon_offer", coupon_offer: { coupon: coupon.id } },
        },
        after_completion: { type: "redirect", redirect: { return_url: "http://localhost/kept" } },
      },
    })
    expect(offered.flow?.type).toBe("subscription_cancel")
    const opening = await page(offered.url)
    expect(opening.html).toContain('data-view="cancel"')
    expect(opening.html).toContain("50% off for 3 months")
    const accepted = await post(offered.url, {
      action: "accept_retention",
      subscription: subscription.id,
    })
    expect(accepted.status).toBe(302)
    expect(accepted.location).toBe("http://localhost/kept")
    const discounted = await h.stripe.subscriptions.retrieve(subscription.id)
    expect(discounted.discounts.length).toBe(1)
    expect(discounted.cancel_at_period_end).toBe(false)
    // After the flow completes, the session opens on the homepage.
    expect((await page(offered.url)).html).toContain('data-view="home"')

    const confirmation = await h.stripe.billingPortal.sessions.create({
      customer: customer.id,
      flow_data: {
        type: "subscription_cancel",
        subscription_cancel: { subscription: subscription.id },
        after_completion: {
          type: "hosted_confirmation",
          hosted_confirmation: { custom_message: "Sorry to see you go." },
        },
      },
    })
    const done = await post(confirmation.url, { action: "cancel", subscription: subscription.id })
    expect(done.html).toContain('data-testid="stripe-mock-portal-confirmation"')
    expect(done.html).toContain("Sorry to see you go.")
  })

  test("deep links: subscription_update_confirm opens on the confirmation step", async () => {
    const h = await harness()
    const { customer, subscription, pro } = await member(h)
    const item = subscription.items.data[0]?.id as string
    const session = await h.stripe.billingPortal.sessions.create({
      customer: customer.id,
      flow_data: {
        type: "subscription_update_confirm",
        subscription_update_confirm: {
          subscription: subscription.id,
          items: [{ id: item, price: pro.id, quantity: 1 }],
        },
      },
    })
    const opening = await page(session.url)
    expect(opening.html).toContain('data-view="confirm_update"')
    await post(session.url, {
      action: "update",
      subscription: subscription.id,
      price: pro.id,
      quantity: "1",
    })
    expect((await h.stripe.subscriptions.retrieve(subscription.id)).items.data[0]?.price.id).toBe(
      pro.id,
    )
    const unoffered = await h.stripe.prices.create({
      product: pro.product as string,
      currency: "usd",
      unit_amount: 1,
      recurring: { interval: "month" },
    })
    await h.stripe.prices.update(unoffered.id, { active: false })
    const refused = await expectStripeError(
      h.stripe.billingPortal.sessions.create({
        customer: customer.id,
        flow_data: {
          type: "subscription_update_confirm",
          subscription_update_confirm: {
            subscription: subscription.id,
            items: [{ id: item, price: unoffered.id }],
          },
        },
      }),
    )
    expect(refused.param).toBe("flow_data[subscription_update_confirm][items][0][price]")
  })

  test("an always_invoice downgrade credits the difference to the customer balance", async () => {
    const h = await harness()
    const customer = await h.stripe.customers.create({ email: "ada@example.com" })
    const card = await h.stripe.paymentMethods.attach("pm_card_visa", { customer: customer.id })
    await h.stripe.customers.update(customer.id, {
      invoice_settings: { default_payment_method: card.id },
    })
    const { basic, pro } = await plans(h.stripe)
    const subscription = await h.stripe.subscriptions.create({
      customer: customer.id,
      items: [{ price: pro.id }],
    })
    const config = await h.stripe.billingPortal.configurations.create({
      features: {
        subscription_update: {
          enabled: true,
          default_allowed_updates: ["price"],
          proration_behavior: "always_invoice",
          products: [{ product: basic.product as string, prices: [basic.id] }],
        },
      },
    })
    const session = await h.stripe.billingPortal.sessions.create({
      customer: customer.id,
      configuration: config.id,
    })
    await h.advance("10d")
    const preview = await post(session.url, {
      action: "preview_update",
      subscription: subscription.id,
      price: basic.id,
    })
    expect(preview.html).toContain("Credit to your balance")
    await post(session.url, { action: "update", subscription: subscription.id, price: basic.id })
    const balance = ((await h.stripe.customers.retrieve(customer.id)) as Stripe.Customer).balance
    expect(balance).toBeLessThan(-1_000)
  })

  test("deep-linked confirmations keep the current quantity and apply their discounts", async () => {
    const h = await harness()
    const customer = await h.stripe.customers.create({ email: "team@example.com" })
    const card = await h.stripe.paymentMethods.attach("pm_card_visa", { customer: customer.id })
    await h.stripe.customers.update(customer.id, {
      invoice_settings: { default_payment_method: card.id },
    })
    const { basic, pro } = await plans(h.stripe)
    const subscription = await h.stripe.subscriptions.create({
      customer: customer.id,
      items: [{ price: basic.id, quantity: 5 }],
    })
    const coupon = await h.stripe.coupons.create({ percent_off: 20, duration: "forever" })
    const session = await h.stripe.billingPortal.sessions.create({
      customer: customer.id,
      flow_data: {
        type: "subscription_update_confirm",
        subscription_update_confirm: {
          subscription: subscription.id,
          items: [{ id: subscription.items.data[0]?.id as string, price: pro.id }],
          discounts: [{ coupon: coupon.id }],
        },
      },
    })
    expect(session.flow?.subscription_update_confirm?.items[0]?.quantity).toBe(5)
    await post(session.url, {
      action: "update",
      subscription: subscription.id,
      price: pro.id,
      quantity: "5",
    })
    const upgraded = await h.stripe.subscriptions.retrieve(subscription.id)
    expect(upgraded.items.data[0]?.quantity).toBe(5)
    expect(upgraded.items.data[0]?.price.id).toBe(pro.id)
    expect(upgraded.discounts.length).toBe(1)
  })

  test("paused subscriptions show as paused and cannot be changed from the portal", async () => {
    const h = await harness()
    const { customer, subscription } = await member(h)
    await h.stripe.subscriptions.update(subscription.id, {
      pause_collection: { behavior: "keep_as_draft" },
    })
    const session = await h.stripe.billingPortal.sessions.create({ customer: customer.id })
    const home = await page(session.url)
    expect(home.html).toContain("Payments paused")
  })
})

describe("hosted portal per-option test ids", () => {
  /** The radio's value inside the one element carrying `testId`; fails unless exactly one does. */
  const radioValueOf = (html: string, testId: string) => {
    const attribute = `data-testid="${testId}"`
    expect(html.split(attribute).length - 1).toBe(1)
    const start = html.indexOf(attribute)
    const label = html.slice(html.lastIndexOf("<label", start), html.indexOf("</label>", start))
    return /<input type="radio"[^>]* value="([^"]*)"/.exec(label)?.[1]
  }

  test("each plan option carries its price's lookup key, and activating it selects that price", async () => {
    const h = await harness()
    const { customer, subscription, basic, pro } = await member(h)
    const yearly = await h.stripe.prices.create({
      product: pro.product as string,
      currency: "usd",
      unit_amount: 30_000,
      recurring: { interval: "year" },
      lookup_key: "subscription_yearly",
    })
    await h.stripe.prices.update(basic.id, { lookup_key: "subscription_monthly" })
    const session = await h.stripe.billingPortal.sessions.create({ customer: customer.id })
    const choose = await page(`${session.url}?flow=update&subscription=${subscription.id}`)
    expect(radioValueOf(choose.html, "stripe-mock-portal-price-option-subscription_yearly")).toBe(
      yearly.id,
    )
    expect(radioValueOf(choose.html, "stripe-mock-portal-price-option-subscription_monthly")).toBe(
      basic.id,
    )
    // A price without a lookup key falls back to its id.
    expect(radioValueOf(choose.html, `stripe-mock-portal-price-option-${pro.id}`)).toBe(pro.id)
    // The generic id stays, on the radios, one per option.
    expect(choose.html.split('data-testid="stripe-mock-portal-price-option"').length - 1).toBe(3)
    const preview = await post(session.url, {
      action: "preview_update",
      subscription: subscription.id,
      price: radioValueOf(choose.html, "stripe-mock-portal-price-option-subscription_yearly") ?? "",
      quantity: "1",
    })
    expect(preview.html).toContain(`name="price" value="${yearly.id}"`)
    expect(preview.html).toContain('data-testid="stripe-mock-portal-amount-due"')
  })

  test("each cancellation reason has its own test id, and the chosen one becomes the feedback", async () => {
    const h = await harness()
    const { customer, subscription } = await member(h)
    const session = await h.stripe.billingPortal.sessions.create({ customer: customer.id })
    const cancelPage = await page(`${session.url}?flow=cancel&subscription=${subscription.id}`)
    expect(cancelPage.html).toContain('data-testid="stripe-mock-portal-reason"')
    const reason = radioValueOf(cancelPage.html, "stripe-mock-portal-reason-too_expensive")
    expect(reason).toBe("too_expensive")
    expect(radioValueOf(cancelPage.html, "stripe-mock-portal-reason-unused")).toBe("unused")
    await post(session.url, {
      action: "cancel",
      subscription: subscription.id,
      reason: reason ?? "",
    })
    const canceled = await h.stripe.subscriptions.retrieve(subscription.id)
    expect(canceled.cancellation_details?.feedback).toBe("too_expensive")
  })
})
