import { jsonResponse, type OperationHandler } from "@emulators/service"
import { invalidRequest, resourceMissing } from "./errors.js"
import { requestScope, type Services, stringOf } from "./internal.js"
import { clampLimit, matchesCreated } from "./list.js"
import { queryParams } from "./params.js"
import type { AccountState, InvoiceRecord } from "./state.js"

type RecordValue = Record<string, unknown>

const INVOICE_PREFIX = "in_"
const PAYMENT_PREFIX = "inpay_"

/**
 * The invoice payment id for an invoice: the invoice id with its prefix swapped, so the link is
 * stable and reversible without a collection of its own.
 */
const paymentId = (invoice: InvoiceRecord) =>
  `${PAYMENT_PREFIX}${invoice.id.slice(INVOICE_PREFIX.length)}`

const invoiceIdOf = (id: string) =>
  id.startsWith(PAYMENT_PREFIX) ? `${INVOICE_PREFIX}${id.slice(PAYMENT_PREFIX.length)}` : null

/**
 * Since 2025-03-31.basil an invoice's payments are objects of their own. The mock keeps one
 * default invoice payment per invoice that has a PaymentIntent (Stripe attaches it when the
 * invoice is finalized), derived from the invoice so the two never disagree. An invoice with
 * nothing to collect (a $0 trial invoice, a draft) has none.
 */
export const renderInvoicePayment = (invoice: InvoiceRecord): RecordValue | null => {
  if (invoice.payment_intent === null) return null
  const status =
    invoice.status === "paid" ? "paid" : invoice.status === "void" ? "canceled" : "open"
  return {
    id: paymentId(invoice),
    object: "invoice_payment",
    amount_paid: status === "paid" ? invoice.amount_paid : null,
    amount_requested: invoice.amount_due,
    created: invoice.status_transitions.finalized_at ?? invoice.created,
    currency: invoice.currency,
    invoice: invoice.id,
    is_default: true,
    livemode: false,
    payment: { type: "payment_intent", payment_intent: invoice.payment_intent },
    status,
    status_transitions: {
      canceled_at: invoice.status_transitions.voided_at,
      paid_at: status === "paid" ? invoice.status_transitions.paid_at : null,
    },
  }
}

/** `invoice.payments`, as the list an `expand[]=payments` swaps in. */
export const renderInvoicePayments = (invoice: InvoiceRecord): RecordValue => {
  const payment = renderInvoicePayment(invoice)
  return {
    object: "list",
    data: payment === null ? [] : [payment],
    has_more: false,
    url: `/v1/invoice_payments?invoice=${invoice.id}`,
  }
}

/** Every invoice payment of an account, newest invoice first. */
const allPayments = (account: AccountState): RecordValue[] =>
  account.invoices
    .list({ order: "newest" })
    .map((entry) => renderInvoicePayment(entry.value))
    .filter((payment): payment is RecordValue => payment !== null)

const STATUSES = ["canceled", "open", "paid"]

export const invoicePaymentHandlers = (services: Services): Record<string, OperationHandler> => ({
  GetInvoicePayments: async (context) => {
    const scope = requestScope(services, context)
    const params = queryParams(context)
    const invoice = stringOf(params, "invoice")
    const status = stringOf(params, "status")
    const filter = params.payment as RecordValue | undefined
    const type = filter === undefined ? null : stringOf(filter, "type")
    const intent = filter === undefined ? null : stringOf(filter, "payment_intent")
    const record = filter === undefined ? null : stringOf(filter, "payment_record")
    if (filter !== undefined && type === null)
      throw invalidRequest("Missing required param: payment[type].", "payment[type]")
    if (type === "payment_record" && intent !== null)
      throw invalidRequest(
        "You can only specify payment[payment_record] with payment[type]=payment_record",
      )
    if (status !== null && !STATUSES.includes(status))
      throw invalidRequest(`Invalid status: must be one of ${STATUSES.join(", ")}`, "status")

    const all = allPayments(scope.account)
    const cursor = (param: string): number => {
      const id = stringOf(params, param)
      if (id === null) return -1
      const index = all.findIndex((payment) => payment.id === id)
      if (index === -1) throw resourceMissing("invoice_payment", id, param, 400)
      return index
    }
    const after = cursor("starting_after")
    const before = cursor("ending_before")
    if (after !== -1 && before !== -1)
      throw invalidRequest(
        "Received both starting_after and ending_before parameters. Please pass in only one.",
      )
    const matches = (payment: RecordValue) => {
      const paid = payment.payment as RecordValue
      return (
        matchesCreated(payment.created as number, params.created) &&
        (invoice === null || payment.invoice === invoice) &&
        (status === null || payment.status === status) &&
        (type === null || paid.type === type) &&
        (intent === null || paid.payment_intent === intent) &&
        // The mock never records a PaymentRecord, so nothing carries one.
        record === null
      )
    }
    const limit = clampLimit(params.limit)
    let data: RecordValue[]
    let hasMore: boolean
    if (before !== -1) {
      const newer = all.slice(0, before).filter(matches)
      data = newer.slice(Math.max(0, newer.length - limit))
      hasMore = newer.length > limit
    } else {
      const rest = all.slice(after + 1).filter(matches)
      data = rest.slice(0, limit)
      hasMore = rest.length > limit
    }
    return jsonResponse(200, {
      object: "list",
      data,
      has_more: hasMore,
      url: "/v1/invoice_payments",
    })
  },
  GetInvoicePaymentsInvoicePayment: async (context) => {
    const scope = requestScope(services, context)
    queryParams(context)
    const id = context.params.invoice_payment ?? ""
    const invoiceId = invoiceIdOf(id)
    const invoice = invoiceId === null ? undefined : scope.account.invoices.get(invoiceId)
    const payment = invoice === undefined ? null : renderInvoicePayment(invoice)
    if (payment === null) throw resourceMissing("invoice_payment", id, "invoice_payment")
    return jsonResponse(200, payment)
  },
})
