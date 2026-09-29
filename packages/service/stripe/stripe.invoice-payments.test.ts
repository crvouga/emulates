import { afterEach, describe, expect, test } from "bun:test"
import { createServer } from "./src/server.js"
import { backendClient } from "./test/consumer.js"

/**
 * Basil's InvoicePayments (2025-03-31.basil and later): the link from an invoice to the payments
 * that paid it is the `invoice_payment` object, reached through `invoice.payments` (expandable)
 * and `GET /v1/invoice_payments`. `Charge.invoice` and `PaymentIntent.invoice` are gone at basil.
 * https://docs.stripe.com/api/invoice-payment
 * https://docs.stripe.com/changelog/basil/2025-03-31/add-support-for-multiple-partial-payments-on-invoices
 */

const KEY = "sk_test_invoicePayments1"
const BASIL = "2025-08-27.basil"

type Json = Record<string, unknown>
type List = { object: string; data: Json[]; has_more: boolean; url: string }

const first = (list: List): Json => {
  const [entry] = list.data
  if (entry === undefined) throw new Error("expected a list entry")
  return entry
}

const closers: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of closers.splice(0)) await close()
})

const harness = async () => {
  const server = await createServer({ accounts: [{ id: "acct_inpay", keys: [KEY] }] })
  closers.push(() => server.close())
  const stripe = backendClient(KEY, new URL(server.url))
  const get = async (path: string, version?: string) => {
    const response = await fetch(`${server.url}${path}`, {
      headers: {
        authorization: `Bearer ${KEY}`,
        ...(version === undefined ? {} : { "stripe-version": version }),
      },
    })
    return { status: response.status, body: (await response.json()) as Json }
  }
  const subscribe = async (trialDays?: number) => {
    const customer = await stripe.customers.create({ email: "member@example.com" })
    const method = await stripe.paymentMethods.attach("pm_card_visa", { customer: customer.id })
    await stripe.customers.update(customer.id, {
      invoice_settings: { default_payment_method: method.id },
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
      ...(trialDays === undefined ? {} : { trial_period_days: trialDays }),
    })
    const invoiceId = subscription.latest_invoice as string
    return { customer, subscription, invoiceId }
  }
  return { server, stripe, get, subscribe }
}

describe("invoice.payments (basil)", () => {
  test("1. a paid subscription invoice expands to one default invoice payment for its PaymentIntent", async () => {
    const h = await harness()
    const { invoiceId } = await h.subscribe()
    const plain = await h.get(`/v1/invoices/${invoiceId}`, BASIL)
    expect("payments" in plain.body).toBe(false)

    const { status, body } = await h.get(`/v1/invoices/${invoiceId}?expand[]=payments`, BASIL)
    expect(status).toBe(200)
    const payments = body.payments as List
    expect(payments.object).toBe("list")
    expect(payments.has_more).toBe(false)
    expect(payments.data).toHaveLength(1)
    const payment = first(payments)
    expect(String(payment.id)).toMatch(/^inpay_/)
    expect(payment).toMatchObject({
      object: "invoice_payment",
      invoice: invoiceId,
      status: "paid",
      amount_paid: 2_000,
      amount_requested: 2_000,
      currency: "usd",
      is_default: true,
      livemode: false,
      payment: { type: "payment_intent", payment_intent: expect.stringMatching(/^pi_/) },
      status_transitions: { canceled_at: null, paid_at: expect.any(Number) },
    })
    // The invoice itself no longer links to a charge or PaymentIntent at basil.
    expect("payment_intent" in body).toBe(false)
    expect("charge" in body).toBe(false)
  })

  test("2. GET /v1/invoice_payments finds the payment by PaymentIntent, by invoice, and by id", async () => {
    const h = await harness()
    const { invoiceId } = await h.subscribe()
    const other = await h.subscribe()
    const expanded = await h.get(`/v1/invoices/${invoiceId}?expand[]=payments`, BASIL)
    const payment = first(expanded.body.payments as List)
    const intent = (payment.payment as Json).payment_intent as string

    const byIntent = await h.get(
      `/v1/invoice_payments?payment[type]=payment_intent&payment[payment_intent]=${intent}`,
      BASIL,
    )
    expect(byIntent.status).toBe(200)
    const list = byIntent.body as unknown as List
    expect(list.object).toBe("list")
    expect(list.url).toBe("/v1/invoice_payments")
    expect(list.has_more).toBe(false)
    expect(list.data).toEqual([payment])
    expect(list.data[0]?.invoice).toBe(invoiceId)

    const byInvoice = await h.get(`/v1/invoice_payments?invoice=${invoiceId}`, BASIL)
    expect((byInvoice.body.data as Json[]).map((entry) => entry.id)).toEqual([payment.id])

    const everything = await h.get("/v1/invoice_payments", BASIL)
    expect((everything.body.data as Json[]).map((entry) => entry.invoice).sort()).toEqual(
      [invoiceId, other.invoiceId].sort(),
    )

    const one = await h.get(`/v1/invoice_payments/${String(payment.id)}`, BASIL)
    expect(one.status).toBe(200)
    expect(one.body).toEqual(payment)
  })

  test("2b. lists page with cursors, filter by status, and refuse bad parameters", async () => {
    const h = await harness()
    const first = await h.subscribe()
    const second = await h.subscribe()

    const page = await h.get("/v1/invoice_payments?limit=1", BASIL)
    const pageList = page.body as unknown as List
    expect(pageList.data).toHaveLength(1)
    expect(pageList.has_more).toBe(true)
    // Newest first: the second subscriber's invoice leads.
    expect(pageList.data[0]?.invoice).toBe(second.invoiceId)
    const next = await h.get(
      `/v1/invoice_payments?limit=1&starting_after=${String(pageList.data[0]?.id)}`,
      BASIL,
    )
    const nextList = next.body as unknown as List
    expect(nextList.data.map((entry) => entry.invoice)).toEqual([first.invoiceId])
    expect(nextList.has_more).toBe(false)
    const back = await h.get(
      `/v1/invoice_payments?limit=1&ending_before=${String(nextList.data[0]?.id)}`,
      BASIL,
    )
    expect((back.body.data as Json[]).map((entry) => entry.invoice)).toEqual([second.invoiceId])

    const paid = await h.get("/v1/invoice_payments?status=paid", BASIL)
    expect(paid.body.data).toHaveLength(2)
    const open = await h.get("/v1/invoice_payments?status=open", BASIL)
    expect(open.body.data).toEqual([])
    const unknown = await h.get("/v1/invoice_payments?starting_after=inpay_missing", BASIL)
    expect(unknown.status).toBe(400)
    const missing = await h.get("/v1/invoice_payments/inpay_missing", BASIL)
    expect(missing.status).toBe(404)
    expect((missing.body.error as Json).code).toBe("resource_missing")
    const noType = await h.get("/v1/invoice_payments?payment[payment_intent]=pi_1", BASIL)
    expect(noType.status).toBe(400)
  })

  test("3. subscription expand[]=latest_invoice.payments works, and payments can be expanded further", async () => {
    const h = await harness()
    const { subscription, invoiceId } = await h.subscribe()
    const { status, body } = await h.get(
      `/v1/subscriptions/${subscription.id}?expand[]=latest_invoice.payments`,
      BASIL,
    )
    expect(status).toBe(200)
    const invoice = body.latest_invoice as Json
    expect(invoice.id).toBe(invoiceId)
    const payment = first(invoice.payments as List)
    expect(payment).toMatchObject({
      status: "paid",
      amount_paid: 2_000,
      payment: { type: "payment_intent" },
    })

    const deeper = await h.get(
      `/v1/invoice_payments?invoice=${invoiceId}&expand[]=data.payment.payment_intent&expand[]=data.invoice`,
      BASIL,
    )
    const expanded = first(deeper.body as unknown as List)
    expect((expanded.invoice as Json).id).toBe(invoiceId)
    const intent = (expanded.payment as Json).payment_intent as Json
    expect(intent.object).toBe("payment_intent")
    expect(intent.status).toBe("succeeded")
    expect(intent.latest_charge).toMatch(/^ch_/)

    // The four-level limit still applies, and `payments` is expandable only on an invoice.
    const tooDeep = await h.get(
      `/v1/subscriptions/${subscription.id}?expand[]=latest_invoice.payments.data.payment.payment_intent`,
      BASIL,
    )
    expect(tooDeep.status).toBe(400)
    expect((tooDeep.body.error as Json).code).toBe("property_expansion_max_depth")
    const notExpandable = await h.get(
      `/v1/subscriptions/${subscription.id}?expand[]=payments`,
      BASIL,
    )
    expect(notExpandable.status).toBe(400)
  })

  test("4. Charge.invoice and PaymentIntent.invoice are not rendered at basil, and are at acacia and 2024-06-20", async () => {
    const h = await harness()
    const { invoiceId } = await h.subscribe()
    const invoice = await h.get(`/v1/invoices/${invoiceId}`, "2024-06-20")
    const intentId = invoice.body.payment_intent as string
    const chargeId = invoice.body.charge as string
    expect(intentId).toMatch(/^pi_/)

    for (const version of ["2024-06-20", "2025-02-24.acacia"]) {
      const charge = await h.get(`/v1/charges/${chargeId}`, version)
      expect(charge.body.invoice).toBe(invoiceId)
      const intent = await h.get(`/v1/payment_intents/${intentId}`, version)
      expect(intent.body.invoice).toBe(invoiceId)
    }
    for (const version of [BASIL, undefined]) {
      const charge = await h.get(`/v1/charges/${chargeId}`, version)
      expect("invoice" in charge.body).toBe(false)
      const intent = await h.get(`/v1/payment_intents/${intentId}`, version)
      expect("invoice" in intent.body).toBe(false)
    }
    // Refund path from the issue: the charge is reachable from the PaymentIntent at basil.
    const viaIntent = await h.get(`/v1/payment_intents/${intentId}?expand[]=latest_charge`, BASIL)
    expect(viaIntent.body.latest_charge).toMatchObject({
      id: chargeId,
      amount_refunded: 0,
      refunded: false,
    })
    // Invoice payments are a basil object: earlier versions do not render `payments`.
    const early = await h.get(`/v1/invoices/${invoiceId}?expand[]=payments`, "2024-06-20")
    expect("payments" in early.body).toBe(false)
  })

  test("5. a $0 trial invoice has an empty payments list", async () => {
    const h = await harness()
    const { invoiceId } = await h.subscribe(7)
    const invoice = await h.get(`/v1/invoices/${invoiceId}?expand[]=payments`, BASIL)
    expect(invoice.body.amount_due).toBe(0)
    expect(invoice.body.payments).toMatchObject({ object: "list", data: [], has_more: false })
    const list = await h.get(`/v1/invoice_payments?invoice=${invoiceId}`, BASIL)
    expect(list.body.data).toEqual([])
  })

  test("a refunded charge leads back to the invoice it paid through the PaymentIntent", async () => {
    const h = await harness()
    const { invoiceId } = await h.subscribe()
    const legacy = await h.get(`/v1/invoices/${invoiceId}`, "2024-06-20")
    const intentId = legacy.body.payment_intent as string
    await h.stripe.refunds.create({ payment_intent: intentId })

    const charge = await h.get(`/v1/payment_intents/${intentId}?expand[]=latest_charge`, BASIL)
    expect(charge.body.latest_charge).toMatchObject({ amount_refunded: 2_000, refunded: true })
    const payments = await h.get(
      `/v1/invoice_payments?payment[type]=payment_intent&payment[payment_intent]=${intentId}`,
      BASIL,
    )
    expect((payments.body.data as Json[]).map((entry) => entry.invoice)).toEqual([invoiceId])
  })
})
