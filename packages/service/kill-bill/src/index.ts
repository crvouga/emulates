import { type APIOptions, bootSqlite } from "@crvouga/mockingbird-service"
import { clearNamespace } from "@crvouga/mockingbird-sqlite"
import { document, operationIds, supportedOperationIds } from "./generated/openapi.js"
import {
  type Account,
  type CatalogPlan,
  type Invoice,
  type InvoiceItem,
  KillBillState,
  type Payment,
  type PaymentMethod,
  type Subscription,
  type Tenant,
  type Transaction,
} from "./state.js"

export type { KillBillRuntime, KillBillRuntimeOptions } from "./runtime.js"
export { createRuntime, KILL_BILL_PRESETS } from "./runtime.js"
export type {
  Account,
  Audit,
  Bundle,
  CatalogPlan,
  Invoice,
  InvoiceItem,
  Payment,
  PaymentMethod,
  Subscription,
  Tenant,
  Transaction,
} from "./state.js"
export { document, operationIds, supportedOperationIds }
export const KILL_BILL_NAMESPACE = "kill-bill"
type Input = Record<string, unknown>
export type KillBillEvent = {
  eventType: string
  objectType: string
  objectId: string
  accountId?: string
  sequence: number
  effectiveDate: string
}
export type KillBillAPIOptions = APIOptions & {
  username?: string
  password?: string
  tenantKey?: string
  tenantSecret?: string
  plans?: readonly CatalogPlan[]
  onEvent?: (event: KillBillEvent) => void
}
const DEFAULT_TENANT_ID = "tenant-default"
const NOTIFICATION_KEY = "PUSH_NOTIFICATION_CB"
const money = (value: unknown) => Math.round((Number(value) + Number.EPSILON) * 100) / 100
const object = (value: unknown): Input =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Input) : {}
const isoDate = (ms: number) => new Date(ms).toISOString().slice(0, 10)
const billingPeriod = (intervalDays?: number) => {
  if (intervalDays === 1) return "DAILY"
  if (intervalDays === 7) return "WEEKLY"
  if (intervalDays !== undefined && intervalDays >= 365) return "ANNUAL"
  return "MONTHLY"
}
// Mock billing advances by intervalDays, so month-based periods use a 30-day month.
const billingPeriodDays: Record<string, number> = {
  DAILY: 1,
  WEEKLY: 7,
  BIWEEKLY: 14,
  THIRTY_DAYS: 30,
  THIRTY_ONE_DAYS: 31,
  SIXTY_DAYS: 60,
  NINETY_DAYS: 90,
  MONTHLY: 30,
  BIMESTRIAL: 60,
  QUARTERLY: 90,
  TRIANNUAL: 120,
  BIANNUAL: 180,
  ANNUAL: 365,
  SESQUIENNIAL: 540,
  BIENNIAL: 730,
  TRIENNIAL: 1095,
}
const recurringPrice = (phase: string): { amount: number; currency?: string } => {
  const blocks = [...phase.matchAll(/<recurringPrice>\s*([\s\S]*?)\s*<\/recurringPrice>/gi)]
  const block = blocks.at(-1)?.[1] ?? ""
  const prices = [...block.matchAll(/<price>\s*([\s\S]*?)\s*<\/price>/gi)].flatMap((match) => {
    const inner = match[1] ?? ""
    const value = /<value>\s*([\d.]+)\s*<\/value>/i.exec(inner)?.[1]
    if (value === undefined) return []
    const currency = /<currency>\s*([A-Za-z]+)\s*<\/currency>/i.exec(inner)?.[1]?.toUpperCase()
    return [{ amount: money(value), ...(currency ? { currency } : {}) }]
  })
  // CatalogPlan stores one price. Prefer USD, then the first price in the final phase.
  return prices.find((price) => price.currency === "USD") ?? prices[0] ?? { amount: 0 }
}
const catalogPlans = (xml: string): CatalogPlan[] => {
  const plans: CatalogPlan[] = []
  for (const match of xml.matchAll(/<plan\b([^>]*)>/gi)) {
    const attrs = match[1] ?? ""
    const name = /\bname=["']([^"']+)["']/.exec(attrs)?.[1]
    if (!name) continue
    const selfClosing = /\/\s*$/.test(attrs)
    const start = (match.index ?? 0) + match[0].length
    const end = selfClosing ? start : xml.indexOf("</plan>", start)
    const body = selfClosing || end === -1 ? "" : xml.slice(start, end)
    const phase = /<finalPhase\b[^>]*>([\s\S]*?)<\/finalPhase>/i.exec(body)?.[1] ?? body
    const amountAttr = /\bamount=["']([\d.]+)["']/.exec(attrs)?.[1]
    const priced: { amount: number; currency?: string } =
      amountAttr === undefined ? recurringPrice(phase) : { amount: money(amountAttr) }
    const period = /<billingPeriod>\s*([A-Za-z0-9_]+)\s*<\/billingPeriod>/i.exec(phase)?.[1]
    const intervalDays = period ? billingPeriodDays[period.toUpperCase()] : undefined
    plans.push({
      name,
      amount: priced.amount,
      ...(priced.currency ? { currency: priced.currency } : {}),
      ...(intervalDays !== undefined ? { intervalDays } : {}),
    })
  }
  return plans
}
const FIXED_OFFSET = /^([+-])(\d{2}):(\d{2})$/
// Kill Bill 0.24 DateTimeZone.forID: omitted means UTC; otherwise a fixed offset or an IANA id.
const clockZone = (raw: string | null) => {
  if (raw == null || raw === "UTC") return "UTC"
  if (/^[+-](?:0\d|1\d|2[0-3]):[0-5]\d$/.test(raw)) return raw
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: raw }).format(0)
    return raw
  } catch {
    return undefined
  }
}
const localDateInZone = (ms: number, timeZone: string) => {
  const offset = FIXED_OFFSET.exec(timeZone)
  if (offset) {
    const sign = offset[1] === "-" ? -1 : 1
    const minutes = sign * (Number(offset[2]) * 60 + Number(offset[3]))
    return new Date(ms + minutes * 60_000).toISOString().slice(0, 10)
  }
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(ms))
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value
  return `${value("year")}-${value("month")}-${value("day")}`
}
const clockJson = (ms: number, timeZone: string) => ({
  currentUtcTime: new Date(ms).toISOString(),
  timeZone,
  localDate: localDateInZone(ms, timeZone),
})

export class KillBillAPI {
  readonly state: KillBillState
  private readonly sqlite
  private readonly namespace: string
  private readonly baseNow: () => number
  private readonly username: string
  private readonly password: string
  private readonly tenantKey: string
  private readonly tenantSecret: string
  constructor(private readonly options: KillBillAPIOptions = {}) {
    this.sqlite = bootSqlite(options.sqlite)
    this.namespace = options.namespace ?? KILL_BILL_NAMESPACE
    this.baseNow = options.now ?? Date.now
    this.username = options.username ?? "admin"
    this.password = options.password ?? "password"
    this.tenantKey = options.tenantKey ?? "bob"
    this.tenantSecret = options.tenantSecret ?? "lazar"
    this.state = new KillBillState(this.sqlite, this.namespace)
    this.seed()
  }
  private seed() {
    if (!this.state.settings.has("settings"))
      this.state.settings.insert("settings", { declineNext: false, pendingNext: false })
    for (const plan of this.options.plans ?? [
      { name: "standard-monthly", amount: 100, currency: "USD", intervalDays: 30 },
    ])
      this.state.plans.insert(plan.name, plan)
    if (!this.tenantByApiKey(this.tenantKey))
      this.state.tenants.insert(DEFAULT_TENANT_ID, {
        tenantId: DEFAULT_TENANT_ID,
        externalKey: this.tenantKey,
        apiKey: this.tenantKey,
        apiSecret: this.tenantSecret,
        callbacks: [],
      })
  }
  async reset() {
    clearNamespace(this.sqlite, this.namespace)
    this.seed()
  }
  now() {
    return this.state.settings.get("settings")?.clockMs ?? this.baseNow()
  }
  private json(body: unknown, status = 200, headers: HeadersInit = {}) {
    return Response.json(body, {
      status,
      headers: { "x-killbill-request-id": this.state.ids.next("req-", 20), ...headers },
    })
  }
  private empty(status = 204, headers: HeadersInit = {}) {
    return new Response(null, { status, headers })
  }
  private problem(status: number, code: string, message: string) {
    return this.json(
      { className: "org.killbill.billing.util.api.KillBillException", code, message },
      status,
    )
  }
  private async emit(
    eventType: string,
    objectType: string,
    objectId: string,
    accountId: string | undefined,
    tenantId: string,
  ) {
    this.options.onEvent?.({
      eventType,
      objectType,
      objectId,
      ...(accountId ? { accountId } : {}),
      sequence:
        this.state.audits.list().length +
        this.state.invoices.list().length +
        this.state.payments.list().length +
        1,
      effectiveDate: new Date(this.now()).toISOString(),
    })
    const callbacks = this.state.tenants.get(tenantId)?.callbacks ?? []
    if (callbacks.length === 0) return
    // Kill Bill 0.24 PushNotificationListener posts NotificationJson and ignores failure.
    const body = JSON.stringify({
      eventType,
      accountId: accountId ?? null,
      objectType,
      objectId,
      metaData: null,
    })
    await Promise.all(callbacks.map((url) => this.postNotification(url, body)))
  }
  private async postNotification(url: string, body: string) {
    try {
      await fetch(url, {
        method: "POST",
        headers: {
          "user-agent": "KillBill/1.0",
          "content-type": "application/json; charset=UTF-8",
        },
        body,
      })
    } catch {
      // Delivery failure is retried by Kill Bill; it does not fail the API call.
    }
  }
  private audit(request: Request, objectType: string, objectId: string) {
    const createdBy = request.headers.get("x-killbill-createdby") ?? "mockingbird"
    const id = this.state.ids.next("audit-", 24)
    this.state.audits.insert(id, {
      id,
      objectType,
      objectId,
      createdBy,
      ...(request.headers.get("x-killbill-reason")
        ? { reason: request.headers.get("x-killbill-reason") as string }
        : {}),
      ...(request.headers.get("x-killbill-comment")
        ? { comment: request.headers.get("x-killbill-comment") as string }
        : {}),
      createdAt: new Date(this.now()).toISOString(),
    })
  }
  private basicAuthorized(request: Request) {
    const expected = `Basic ${btoa(`${this.username}:${this.password}`)}`
    return request.headers.get("authorization") === expected
  }
  private tenantByApiKey(apiKey: string) {
    return this.state.tenants
      .list({ where: (tenant) => tenant.apiKey === apiKey })
      .map(({ value }) => value)[0]
  }
  private defaultPaymentMethod(accountId: string) {
    return this.state.methods
      .list({ where: (method) => method.accountId === accountId && method.isDefault })
      .map(({ value }) => value)[0]
  }
  // Kill Bill 0.24 creates or reuses __EXTERNAL_PAYMENT__ and does not call a gateway.
  private externalPaymentMethod(accountId: string) {
    const existing = this.state.methods
      .list({
        where: (method) =>
          method.accountId === accountId && method.pluginName === "__EXTERNAL_PAYMENT__",
      })
      .map(({ value }) => value)[0]
    if (existing) return existing
    const paymentMethodId = this.state.ids.next("pm-", 32)
    const method: PaymentMethod = {
      paymentMethodId,
      accountId,
      externalKey: this.state.ids.next("pm-key-", 24),
      pluginName: "__EXTERNAL_PAYMENT__",
      isDefault: false,
    }
    this.state.methods.insert(paymentMethodId, method)
    return method
  }
  private invoicePayment(payment: Payment, targetInvoiceId: string) {
    const { invoiceId: _invoiceId, ...fields } = payment
    return { ...fields, targetInvoiceId }
  }
  private authenticatedTenant(request: Request) {
    const apiKey = request.headers.get("x-killbill-apikey")
    const apiSecret = request.headers.get("x-killbill-apisecret")
    if (!apiKey || !apiSecret) return undefined
    const tenant = this.tenantByApiKey(apiKey)
    if (!tenant || tenant.apiSecret !== apiSecret) return undefined
    return tenant
  }
  private account(id: string, tenantId: string) {
    const found = this.state.accounts.get(id)
    return found?.tenantId === tenantId ? found : undefined
  }
  private byExternal(key: string, tenantId: string) {
    return this.state.accounts
      .list({ where: (account) => account.externalKey === key && account.tenantId === tenantId })
      .map(({ value }) => value)[0]
  }
  private publicAccount(account: Account) {
    const { tenantId: _tenantId, ...rest } = account
    return {
      ...rest,
      accountBalance: money(
        this.state.invoices
          .list({ where: (i) => i.accountId === account.accountId && i.status !== "VOID" })
          .reduce((sum, row) => sum + row.value.balance, 0),
      ),
      accountCBA: money(
        this.state.invoices
          .list({ where: (i) => i.accountId === account.accountId })
          .reduce((sum, row) => sum + row.value.creditAdj, 0),
      ),
    }
  }
  private plan(name: string) {
    return this.state.plans.get(name)
  }
  // Kill Bill 0.24 CatalogJson is a list of versions. Plans are nested on products.
  private catalogJson() {
    const plans = this.state.plans.list().map(({ value }) => value)
    const currencies = [...new Set(plans.map((plan) => plan.currency ?? "USD"))]
    return [
      {
        name: "default",
        effectiveDate: new Date(this.now()).toISOString(),
        currencies: currencies.length > 0 ? currencies : ["USD"],
        units: [],
        products: plans.map((plan) => {
          const currency = plan.currency ?? "USD"
          return {
            type: "BASE",
            name: plan.name,
            prettyName: plan.name,
            plans: [
              {
                name: plan.name,
                prettyName: plan.name,
                recurringBillingMode: "IN_ADVANCE",
                billingPeriod: billingPeriod(plan.intervalDays),
                phases: [
                  {
                    type: "EVERGREEN",
                    prices: [{ currency, value: plan.amount }],
                    fixedPrices: [],
                    duration: { unit: "UNLIMITED", number: -1 },
                    usages: [],
                  },
                ],
              },
            ],
            included: [],
            available: [],
          }
        }),
        priceLists: [{ name: "DEFAULT", plans: plans.map((plan) => plan.name) }],
      },
    ]
  }
  private location(request: Request, path: string) {
    return new URL(path, request.url).toString()
  }
  private async createInvoice(
    accountId: string,
    tenantId: string,
    itemInputs: Input[],
    description = "Invoice",
  ) {
    const account = this.account(accountId, tenantId)
    if (!account) return undefined
    const invoiceId = this.state.ids.next("inv-", 32)
    const date = isoDate(this.now())
    const items: InvoiceItem[] = itemInputs.map((input) => ({
      ...input,
      invoiceItemId: this.state.ids.next("item-", 32),
      invoiceId,
      accountId,
      itemType: typeof input.itemType === "string" ? input.itemType : "EXTERNAL_CHARGE",
      amount: money(input.amount),
      currency: typeof input.currency === "string" ? input.currency : account.currency,
      description: typeof input.description === "string" ? input.description : description,
      startDate: typeof input.startDate === "string" ? input.startDate : date,
    }))
    const amount = money(items.reduce((sum, item) => sum + item.amount, 0))
    const invoice: Invoice = {
      invoiceId,
      accountId,
      invoiceNumber: String(this.state.invoices.list().length + 1),
      invoiceDate: date,
      targetDate: date,
      currency: account.currency,
      status: "COMMITTED",
      amount,
      balance: amount,
      creditAdj: money(
        items.filter((i) => i.itemType === "CBA_ADJ").reduce((s, i) => s + i.amount, 0),
      ),
      refundAdj: 0,
      items,
    }
    this.state.invoices.insert(invoiceId, invoice)
    await this.emit("INVOICE_CREATION", "INVOICE", invoiceId, accountId, tenantId)
    return invoice
  }
  private transaction(
    payment: Payment,
    type: Transaction["transactionType"],
    amount: number,
    status: Transaction["status"],
    externalKey?: string,
  ) {
    const transaction: Transaction = {
      transactionId: this.state.ids.next("txn-", 32),
      paymentId: payment.paymentId,
      transactionExternalKey: externalKey ?? this.state.ids.next("txn-key-", 24),
      transactionType: type,
      effectiveDate: new Date(this.now()).toISOString(),
      status,
      amount: money(amount),
      currency: payment.currency,
      ...(status === "PAYMENT_FAILURE"
        ? { gatewayErrorCode: "DECLINED", gatewayErrorMsg: "Mockingbird declined payment" }
        : {}),
    }
    return transaction
  }
  private async pay(
    accountId: string,
    tenantId: string,
    input: Input,
    invoiceId?: string,
    paymentMethodId?: string,
    external = false,
  ) {
    const account = this.account(accountId, tenantId)
    if (!account) return undefined
    const paymentExternalKey =
      typeof input.paymentExternalKey === "string" ? input.paymentExternalKey : undefined
    const transactionExternalKey =
      typeof input.transactionExternalKey === "string" ? input.transactionExternalKey : undefined
    const prior = this.state.payments
      .list({
        where: (payment) =>
          payment.accountId === accountId &&
          ((paymentExternalKey !== undefined &&
            payment.paymentExternalKey === paymentExternalKey) ||
            (transactionExternalKey !== undefined &&
              payment.transactions.some(
                (transaction) => transaction.transactionExternalKey === transactionExternalKey,
              ))),
      })
      .map(({ value }) => value)[0]
    if (prior) return prior
    const settings = this.state.settings.get("settings") ?? {
      declineNext: false,
      pendingNext: false,
    }
    const amount = money(
      input.amount ?? (invoiceId ? this.state.invoices.get(invoiceId)?.balance : 0),
    )
    const paymentId = this.state.ids.next("pay-", 32)
    const status: Transaction["status"] = external
      ? "SUCCESS"
      : settings.declineNext
        ? "PAYMENT_FAILURE"
        : settings.pendingNext
          ? "PENDING"
          : "SUCCESS"
    if (!external)
      this.state.settings.insert("settings", {
        ...settings,
        declineNext: false,
        pendingNext: false,
      })
    const type = (
      typeof input.transactionType === "string" ? input.transactionType : "PURCHASE"
    ) as Transaction["transactionType"]
    const payment: Payment = {
      paymentId,
      accountId,
      ...(invoiceId ? { invoiceId } : {}),
      paymentNumber: String(this.state.payments.list().length + 1),
      paymentExternalKey: paymentExternalKey ?? this.state.ids.next("payment-key-", 24),
      authAmount: type === "AUTHORIZE" && status === "SUCCESS" ? amount : 0,
      capturedAmount: 0,
      purchasedAmount: type === "PURCHASE" && status === "SUCCESS" ? amount : 0,
      refundedAmount: 0,
      creditedAmount: type === "CREDIT" && status === "SUCCESS" ? amount : 0,
      currency: typeof input.currency === "string" ? input.currency : account.currency,
      ...(paymentMethodId ? { paymentMethodId } : {}),
      transactions: [],
      paymentAttempts: [],
    }
    const transaction = this.transaction(payment, type, amount, status, transactionExternalKey)
    payment.transactions = [transaction]
    payment.paymentAttempts = [
      {
        paymentAttemptId: this.state.ids.next("attempt-", 24),
        accountId,
        paymentId,
        paymentExternalKey: payment.paymentExternalKey,
        transactionId: transaction.transactionId,
        transactionExternalKey: transaction.transactionExternalKey,
        transactionType: type,
        effectiveDate: transaction.effectiveDate,
        stateName: status,
      },
    ]
    this.state.payments.insert(paymentId, payment)
    if (invoiceId && status === "SUCCESS") {
      const invoice = this.state.invoices.get(invoiceId)
      if (invoice)
        this.state.invoices.insert(invoiceId, {
          ...invoice,
          balance: money(Math.max(0, invoice.balance - amount)),
        })
    }
    await this.emit(
      status === "SUCCESS"
        ? "PAYMENT_SUCCESS"
        : status === "PENDING"
          ? "PAYMENT_PENDING"
          : "PAYMENT_FAILED",
      "PAYMENT",
      paymentId,
      accountId,
      tenantId,
    )
    return payment
  }
  private async billDue(tenantId: string) {
    const today = isoDate(this.now())
    for (const { value: subscription } of this.state.subscriptions.list({
      where: (s) => s.state === "ACTIVE" && this.account(s.accountId, tenantId) !== undefined,
    })) {
      if (subscription.pendingChangePlan) {
        subscription.planName = subscription.pendingChangePlan
        delete subscription.pendingChangePlan
      }
      const due = subscription.chargedThroughDate ?? subscription.startDate
      if (due > today) continue
      const plan = this.plan(subscription.planName)
      if (!plan) continue
      const invoice = await this.createInvoice(
        subscription.accountId,
        tenantId,
        [
          {
            itemType: "RECURRING",
            amount: plan.amount,
            currency: plan.currency ?? "USD",
            description: subscription.planName,
            startDate: today,
            subscriptionId: subscription.subscriptionId,
            planName: subscription.planName,
          },
        ],
        "Recurring charge",
      )
      const nextDate = isoDate(this.now() + (plan.intervalDays ?? 30) * 86_400_000)
      this.state.subscriptions.insert(subscription.subscriptionId, {
        ...subscription,
        chargedThroughDate: nextDate,
      })
      const method = this.state.methods
        .list({ where: (m) => m.accountId === subscription.accountId && m.isDefault })
        .map(({ value }) => value)[0]
      if (invoice && method)
        await this.pay(
          subscription.accountId,
          tenantId,
          { amount: invoice.balance, transactionType: "PURCHASE", currency: invoice.currency },
          invoice.invoiceId,
          method.paymentMethodId,
        )
    }
  }
  private async body(request: Request) {
    const text = await request.text()
    if (!text) return {}
    try {
      return JSON.parse(text) as Input
    } catch {
      return { raw: text }
    }
  }
  private async tenants(request: Request, url: URL) {
    if (request.method === "GET") {
      const apiKey = url.searchParams.get("apiKey")
      const tenant = apiKey ? this.tenantByApiKey(apiKey) : undefined
      return tenant
        ? this.json({
            tenantId: tenant.tenantId,
            externalKey: tenant.externalKey,
            apiKey: tenant.apiKey,
          })
        : this.problem(
            404,
            "TENANT_DOES_NOT_EXIST",
            `Tenant does not exist for api key ${apiKey ?? ""}`,
          )
    }
    if (request.method !== "POST")
      return this.problem(
        404,
        "NOT_FOUND",
        `No Kill Bill route for ${request.method} ${url.pathname}`,
      )
    const body = await this.body(request)
    const apiKey = typeof body.apiKey === "string" ? body.apiKey : ""
    const apiSecret = typeof body.apiSecret === "string" ? body.apiSecret : ""
    if (!apiKey || !apiSecret)
      return this.problem(400, "INVALID_TENANT", "apiKey and apiSecret are required")
    if (this.tenantByApiKey(apiKey)) {
      const key =
        typeof body.externalKey === "string" && body.externalKey ? body.externalKey : apiKey
      return this.problem(409, "TENANT_ALREADY_EXISTS", `Tenant already exists for key ${key}`)
    }
    const tenantId = this.state.ids.next("tenant-", 32)
    const externalKey = typeof body.externalKey === "string" ? body.externalKey : ""
    this.state.tenants.insert(tenantId, {
      tenantId,
      externalKey,
      apiKey,
      apiSecret,
      callbacks: [],
    })
    this.audit(request, "TENANT", tenantId)
    return this.empty(201, { location: this.location(request, `/1.0/kb/tenants/${tenantId}`) })
  }
  private notificationCallback(request: Request, url: URL, tenant: Tenant) {
    if (request.method === "GET")
      return this.json({ key: NOTIFICATION_KEY, values: tenant.callbacks })
    if (request.method === "DELETE") {
      this.state.tenants.insert(tenant.tenantId, { ...tenant, callbacks: [] })
      return this.empty()
    }
    if (request.method === "POST") {
      const callback = url.searchParams.get("cb")
      if (!callback) return this.problem(400, "INVALID_CALLBACK", "cb is required")
      // PUSH_NOTIFICATION_CB is a single-value key: POST replaces the previous URL.
      this.state.tenants.insert(tenant.tenantId, { ...tenant, callbacks: [callback] })
      return this.empty(201, {
        location: this.location(request, "/1.0/kb/tenants/registerNotificationCallback"),
      })
    }
    return this.problem(
      404,
      "NOT_FOUND",
      `No Kill Bill route for ${request.method} ${url.pathname}`,
    )
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === "/1.0/healthcheck" || url.pathname === "/healthcheck")
      return this.json({ status: "UP" })
    if (!this.basicAuthorized(request)) return this.problem(401, "UNAUTHORIZED", "Unauthorized")
    // Kill Bill 0.24 TenantFilter skips api key headers on exactly /1.0/kb/tenants.
    if (url.pathname === "/1.0/kb/tenants") {
      if (request.method !== "GET" && !request.headers.get("x-killbill-createdby"))
        return this.problem(400, "MISSING_CREATED_BY", "X-Killbill-CreatedBy is required")
      return this.tenants(request, url)
    }
    const tenant = this.authenticatedTenant(request)
    if (!tenant) return this.problem(401, "UNAUTHORIZED", "Unauthorized")
    if (request.method !== "GET" && !request.headers.get("x-killbill-createdby"))
      return this.problem(400, "MISSING_CREATED_BY", "X-Killbill-CreatedBy is required")
    const tenantId = tenant.tenantId
    const path = url.pathname.replace(/^\/1\.0\/kb\/?/, "")
    const parts = path.split("/").filter(Boolean)
    const body = await this.body(request)
    if (parts[0] === "tenants" && parts[1] === "registerNotificationCallback")
      return this.notificationCallback(request, url, tenant)
    if (parts[0] === "test" && parts[1] === "clock") {
      const zone = clockZone(url.searchParams.get("timeZone"))
      if (!zone) return this.problem(400, "INVALID_TIMEZONE", "Invalid timezone supplied")
      if (request.method === "GET") return this.json(clockJson(this.now(), zone))
      const requested =
        url.searchParams.get("requestedDate") ??
        (typeof body.requestedDate === "string" ? body.requestedDate : undefined)
      const parsed = requested ? Date.parse(requested) : Number.NaN
      if (!Number.isFinite(parsed))
        return this.problem(400, "INVALID_DATE", "requestedDate is required")
      const settings = this.state.settings.get("settings") ?? {
        declineNext: false,
        pendingNext: false,
      }
      this.state.settings.insert("settings", { ...settings, clockMs: parsed })
      await this.billDue(tenantId)
      return this.json(clockJson(parsed, zone))
    }
    if (parts[0] === "catalog") {
      if (request.method === "GET")
        return request.headers.get("accept")?.includes("xml")
          ? new Response(
              this.state.plans
                .list()
                .map(({ value }) => `<plan name="${value.name}" amount="${value.amount}"/>`)
                .join(""),
              { headers: { "content-type": "application/xml" } },
            )
          : this.json(this.catalogJson())
      const plans = Array.isArray(body.plans) ? body.plans : []
      for (const raw of plans) {
        const plan = object(raw)
        if (typeof plan.name === "string")
          this.state.plans.insert(plan.name, {
            name: plan.name,
            amount: money(plan.amount),
            ...(typeof plan.currency === "string" ? { currency: plan.currency } : {}),
            ...(typeof plan.intervalDays === "number" ? { intervalDays: plan.intervalDays } : {}),
          })
      }
      if (typeof body.raw === "string")
        for (const plan of catalogPlans(body.raw)) this.state.plans.insert(plan.name, plan)
      return this.empty(201)
    }
    if (parts[0] === "accounts" && parts.length === 1) {
      if (request.method === "GET") {
        const external = url.searchParams.get("externalKey")
        const account = external ? this.byExternal(external, tenantId) : undefined
        return account
          ? this.json(this.publicAccount(account))
          : this.problem(404, "ACCOUNT_DOES_NOT_EXIST", "Account not found")
      }
      const externalKey =
        typeof body.externalKey === "string"
          ? body.externalKey
          : this.state.ids.next("account-key-", 24)
      // Kill Bill 0.24 maps ErrorCode.ACCOUNT_ALREADY_EXISTS (3000) to HTTP 409.
      const prior = this.byExternal(externalKey, tenantId)
      if (prior)
        return this.json(
          {
            className: "org.killbill.billing.account.api.AccountApiException",
            code: 3000,
            message: `Account already exists for key ${externalKey}`,
            causeClassName: null,
            causeMessage: null,
            stackTrace: [],
          },
          409,
        )
      if (typeof body.currency !== "string")
        return this.problem(400, "INVALID_ACCOUNT", "currency is required")
      const accountId = this.state.ids.next("acc-", 32)
      const account: Account = {
        ...body,
        accountId,
        tenantId,
        externalKey,
        currency: body.currency,
        timeZone: typeof body.timeZone === "string" ? body.timeZone : "UTC",
        referenceTime: new Date(this.now()).toISOString(),
        accountBalance: 0,
        accountCBA: 0,
      }
      this.state.accounts.insert(accountId, account)
      this.audit(request, "ACCOUNT", accountId)
      await this.emit("ACCOUNT_CREATION", "ACCOUNT", accountId, accountId, tenantId)
      return this.empty(201, { location: this.location(request, `/1.0/kb/accounts/${accountId}`) })
    }
    if (parts[0] === "accounts" && parts.length === 2 && request.method === "GET") {
      const account = this.account(parts[1] as string, tenantId)
      return account
        ? this.json(this.publicAccount(account))
        : this.problem(404, "ACCOUNT_DOES_NOT_EXIST", "Account not found")
    }
    const accountId = parts[0] === "accounts" ? (parts[1] as string) : undefined
    if (accountId && parts[2] && !this.account(accountId, tenantId))
      return this.problem(404, "ACCOUNT_DOES_NOT_EXIST", "Account not found")
    if (accountId && parts[2] === "paymentMethods") {
      if (!this.account(accountId, tenantId))
        return this.problem(404, "ACCOUNT_DOES_NOT_EXIST", "Account not found")
      if (request.method === "GET")
        return this.json(
          this.state.methods
            .list({ where: (m) => m.accountId === accountId })
            .map(({ value }) => value),
        )
      const externalKey =
        typeof body.externalKey === "string" ? body.externalKey : this.state.ids.next("pm-key-", 24)
      const prior = this.state.methods
        .list({
          where: (m) =>
            m.externalKey === externalKey && this.account(m.accountId, tenantId) !== undefined,
        })
        .map(({ value }) => value)[0]
      if (prior)
        return this.problem(400, "PAYMENT_METHOD_ALREADY_EXISTS", "Payment method already exists")
      const paymentMethodId = this.state.ids.next("pm-", 32)
      const makeDefault =
        url.searchParams.get("isDefault") === "true" ||
        this.state.methods.list({ where: (m) => m.accountId === accountId }).length === 0
      if (makeDefault)
        for (const { value } of this.state.methods.list({
          where: (m) => m.accountId === accountId,
        }))
          this.state.methods.insert(value.paymentMethodId, { ...value, isDefault: false })
      const method: PaymentMethod = {
        ...body,
        paymentMethodId,
        accountId,
        externalKey,
        pluginName: typeof body.pluginName === "string" ? body.pluginName : "__EXTERNAL_PAYMENT__",
        isDefault: makeDefault,
      }
      this.state.methods.insert(paymentMethodId, method)
      this.audit(request, "PAYMENT_METHOD", paymentMethodId)
      return this.empty(201, {
        location: this.location(request, `/1.0/kb/paymentMethods/${paymentMethodId}`),
      })
    }
    if (parts[0] === "paymentMethods") {
      const method = parts[1]
        ? this.state.methods.get(parts[1])
        : this.state.methods
            .list({ where: (m) => m.externalKey === url.searchParams.get("externalKey") })
            .map(({ value }) => value)[0]
      return method && this.account(method.accountId, tenantId)
        ? this.json(method)
        : this.problem(404, "PAYMENT_METHOD_DOES_NOT_EXIST", "Payment method not found")
    }
    if (parts[0] === "subscriptions" && parts.length === 1 && request.method === "POST") {
      const inputs = Array.isArray(body) ? (body as unknown as Input[]) : [body]
      // 0.24 createSubscription locates the subscription, not the bundle.
      let createdSubscriptionId = ""
      for (const input of inputs) {
        if (
          typeof input.accountId !== "string" ||
          !this.account(input.accountId, tenantId) ||
          typeof input.planName !== "string" ||
          !this.plan(input.planName)
        )
          return this.problem(
            400,
            "INVALID_SUBSCRIPTION",
            "valid accountId and planName are required",
          )
        const externalKey =
          typeof input.externalKey === "string"
            ? input.externalKey
            : this.state.ids.next("sub-key-", 24)
        if (
          this.state.subscriptions.list({
            where: (s) =>
              s.externalKey === externalKey && this.account(s.accountId, tenantId) !== undefined,
          }).length
        )
          return this.problem(
            400,
            "SUBSCRIPTION_ALREADY_EXISTS",
            "Subscription external key already exists",
          )
        const bundleId =
          typeof input.bundleId === "string" ? input.bundleId : this.state.ids.next("bundle-", 32)
        if (!this.state.bundles.has(bundleId))
          this.state.bundles.insert(bundleId, {
            bundleId,
            accountId: input.accountId,
            externalKey: externalKey,
            subscriptions: [],
          })
        const subscriptionId = this.state.ids.next("sub-", 32)
        if (!createdSubscriptionId) createdSubscriptionId = subscriptionId
        const date = url.searchParams.get("entitlementDate") ?? isoDate(this.now())
        const subscription: Subscription = {
          ...input,
          subscriptionId,
          accountId: input.accountId,
          bundleId,
          externalKey,
          planName: input.planName,
          phaseType: typeof input.phaseType === "string" ? input.phaseType : "EVERGREEN",
          state: date > isoDate(this.now()) ? "PENDING" : "ACTIVE",
          startDate: date,
          chargedThroughDate: date,
        }
        this.state.subscriptions.insert(subscriptionId, subscription)
        const bundle = this.state.bundles.get(bundleId)
        if (bundle)
          this.state.bundles.insert(bundleId, {
            ...bundle,
            subscriptions: [...bundle.subscriptions, subscriptionId],
          })
        this.audit(request, "SUBSCRIPTION", subscriptionId)
        await this.emit(
          "SUBSCRIPTION_CREATION",
          "SUBSCRIPTION",
          subscriptionId,
          input.accountId,
          tenantId,
        )
      }
      await this.billDue(tenantId)
      return this.empty(201, {
        location: this.location(request, `/1.0/kb/subscriptions/${createdSubscriptionId}`),
      })
    }
    if (parts[0] === "subscriptions" && parts[1]) {
      const subscription = this.state.subscriptions.get(parts[1])
      if (!subscription || !this.account(subscription.accountId, tenantId))
        return this.problem(404, "SUBSCRIPTION_DOES_NOT_EXIST", "Subscription not found")
      if (parts[2] === "uncancel" && request.method === "PUT") {
        const next = { ...subscription, state: "ACTIVE" as const }
        delete next.cancelledDate
        this.state.subscriptions.insert(subscription.subscriptionId, next)
        await this.emit(
          "SUBSCRIPTION_UNCANCEL",
          "SUBSCRIPTION",
          subscription.subscriptionId,
          subscription.accountId,
          tenantId,
        )
        return this.empty()
      }
      if (parts[2] === "undoChangePlan" && request.method === "PUT") {
        if (!subscription.pendingChangePlan)
          return this.json(
            {
              className: "org.killbill.billing.subscription.api.user.SubscriptionBaseApiException",
              code: 1071,
              message:
                "Subscription (billing) " +
                `${subscription.subscriptionId} does not have a pending change plan: ` +
                "Failed to undo change plan",
              causeClassName: null,
              causeMessage: null,
              stackTrace: [],
            },
            400,
          )
        const next = { ...subscription }
        delete next.pendingChangePlan
        this.state.subscriptions.insert(subscription.subscriptionId, next)
        return this.empty()
      }
      if (parts[2] === "changePlan" && request.method === "DELETE") {
        const next = { ...subscription }
        delete next.pendingChangePlan
        this.state.subscriptions.insert(subscription.subscriptionId, next)
        return this.empty()
      }
      if (request.method === "GET") return this.json(subscription)
      if (request.method === "DELETE") {
        const effective = url.searchParams.get("requestedDate") ?? isoDate(this.now())
        const next = {
          ...subscription,
          state: effective > isoDate(this.now()) ? subscription.state : ("CANCELLED" as const),
          cancelledDate: effective,
        }
        this.state.subscriptions.insert(subscription.subscriptionId, next)
        await this.emit(
          "SUBSCRIPTION_CANCEL",
          "SUBSCRIPTION",
          subscription.subscriptionId,
          subscription.accountId,
          tenantId,
        )
        return this.empty()
      }
      if (request.method === "PUT") {
        const planName = typeof body.planName === "string" ? body.planName : ""
        if (!this.plan(planName)) return this.problem(400, "INVALID_PLAN", "Unknown plan")
        const immediate = (url.searchParams.get("billingPolicy") ?? "IMMEDIATE") === "IMMEDIATE"
        this.state.subscriptions.insert(
          subscription.subscriptionId,
          immediate
            ? { ...subscription, planName }
            : { ...subscription, pendingChangePlan: planName },
        )
        await this.emit(
          "SUBSCRIPTION_CHANGE",
          "SUBSCRIPTION",
          subscription.subscriptionId,
          subscription.accountId,
          tenantId,
        )
        return this.empty()
      }
    }
    if (accountId && parts[2] === "bundles" && request.method === "GET")
      return this.json(
        this.state.bundles.list({ where: (b) => b.accountId === accountId }).map(({ value }) => ({
          ...value,
          subscriptions: value.subscriptions
            .map((id) => this.state.subscriptions.get(id))
            .filter(Boolean),
        })),
      )
    if (accountId && parts[2] === "invoices" && request.method === "GET")
      return this.json(
        this.state.invoices
          .list({ where: (i) => i.accountId === accountId })
          .map(({ value }) => value),
      )
    if (accountId && parts[2] === "tags") {
      if (request.method === "GET")
        return this.json(
          this.state.tags
            .list({ where: (t) => t.objectId === accountId })
            .map(({ value }) => value),
        )
      const ids = Array.isArray(body)
        ? body
        : Array.isArray(body.tagDefinitionIds)
          ? body.tagDefinitionIds
          : []
      for (const id of ids)
        if (typeof id === "string")
          this.state.tags.insert(`${accountId}\0${id}`, {
            objectId: accountId,
            tagDefinitionId: id,
          })
      return this.empty(201)
    }
    if (
      parts[0] === "invoices" &&
      parts[1] === "charges" &&
      parts[2] &&
      request.method === "POST"
    ) {
      const inputs = Array.isArray(body) ? (body as unknown as Input[]) : [body]
      const invoice = await this.createInvoice(parts[2], tenantId, inputs)
      return invoice
        ? this.empty(201, {
            location: this.location(request, `/1.0/kb/invoices/${invoice.invoiceId}`),
          })
        : this.problem(404, "ACCOUNT_DOES_NOT_EXIST", "Account not found")
    }
    if (parts[0] === "credits" && request.method === "POST") {
      const inputs = Array.isArray(body) ? (body as unknown as Input[]) : [body]
      const account = inputs[0]?.accountId
      if (typeof account !== "string")
        return this.problem(400, "INVALID_CREDIT", "accountId required")
      const invoice = await this.createInvoice(
        account,
        tenantId,
        inputs.map((item) => ({
          ...item,
          itemType: "CBA_ADJ",
          amount: -Math.abs(money(item.amount)),
        })),
      )
      return invoice
        ? this.empty(201, {
            location: this.location(request, `/1.0/kb/invoices/${invoice.invoiceId}`),
          })
        : this.problem(404, "ACCOUNT_DOES_NOT_EXIST", "Account not found")
    }
    if (parts[0] === "invoices" && parts[1]) {
      const invoice = this.state.invoices.get(parts[1])
      if (!invoice || !this.account(invoice.accountId, tenantId))
        return this.problem(404, "INVOICE_DOES_NOT_EXIST", "Invoice not found")
      if (parts[2] === "payments") {
        if (request.method === "GET")
          return this.json(
            this.state.payments
              .list({ where: (payment) => payment.invoiceId === invoice.invoiceId })
              .map(({ value }) => this.invoicePayment(value, invoice.invoiceId)),
          )
        const externalPayment = url.searchParams.get("externalPayment") === "true"
        if (externalPayment && typeof body.paymentMethodId === "string")
          return this.problem(
            400,
            "INVALID_PAYMENT",
            "InvoicePaymentJson should not contain a paymentMethodId when this is an external payment",
          )
        const payerId = typeof body.accountId === "string" ? body.accountId : invoice.accountId
        const requestedMethod =
          typeof body.paymentMethodId === "string" ? body.paymentMethodId : undefined
        const paymentMethodId = externalPayment
          ? this.account(payerId, tenantId)
            ? this.externalPaymentMethod(payerId).paymentMethodId
            : undefined
          : (requestedMethod ?? this.defaultPaymentMethod(payerId)?.paymentMethodId)
        const payment = await this.pay(
          payerId,
          tenantId,
          {
            ...body,
            amount: body.purchasedAmount ?? body.amount ?? invoice.balance,
            transactionType: externalPayment ? "PURCHASE" : (body.transactionType ?? "PURCHASE"),
          },
          invoice.invoiceId,
          paymentMethodId,
          externalPayment,
        )
        return payment
          ? this.empty(201, {
              location: this.location(request, `/1.0/kb/payments/${payment.paymentId}`),
            })
          : this.problem(400, "PAYMENT_FAILED", "Payment could not be created")
      }
      if (request.method === "GET") return this.json(invoice)
      if (request.method === "DELETE") {
        if (invoice.balance !== invoice.amount)
          return this.problem(409, "INVOICE_NOT_WRITABLE", "Paid invoice cannot be voided")
        this.state.invoices.insert(invoice.invoiceId, { ...invoice, status: "VOID", balance: 0 })
        await this.emit("INVOICE_VOID", "INVOICE", invoice.invoiceId, invoice.accountId, tenantId)
        return this.empty()
      }
    }
    if (parts[0] === "accounts" && parts[1] === "payments" && request.method === "POST") {
      const account = url.searchParams.get("externalKey")
        ? this.byExternal(url.searchParams.get("externalKey") as string, tenantId)
        : undefined
      if (!account) return this.problem(404, "ACCOUNT_DOES_NOT_EXIST", "Account not found")
      const payment = await this.pay(
        account.accountId,
        tenantId,
        body,
        undefined,
        url.searchParams.get("paymentMethodId") ?? undefined,
      )
      return payment
        ? this.empty(201, {
            location: this.location(request, `/1.0/kb/payments/${payment.paymentId}`),
          })
        : this.problem(400, "PAYMENT_FAILED", "Payment failed")
    }
    if (parts[0] === "payments" && parts[1]) {
      const payment = this.state.payments.get(parts[1])
      if (!payment || !this.account(payment.accountId, tenantId))
        return this.problem(404, "PAYMENT_DOES_NOT_EXIST", "Payment not found")
      if (parts[2] === "refunds" && request.method === "POST") {
        const amount = money(body.amount ?? payment.purchasedAmount - payment.refundedAmount)
        if (amount <= 0 || amount > payment.purchasedAmount - payment.refundedAmount)
          return this.problem(
            400,
            "INVALID_REFUND_AMOUNT",
            "Refund amount exceeds purchased amount",
          )
        const transaction = this.transaction(
          payment,
          "REFUND",
          amount,
          "SUCCESS",
          typeof body.transactionExternalKey === "string" ? body.transactionExternalKey : undefined,
        )
        const next = {
          ...payment,
          refundedAmount: money(payment.refundedAmount + amount),
          transactions: [...payment.transactions, transaction],
        }
        this.state.payments.insert(payment.paymentId, next)
        if (payment.invoiceId) {
          const invoice = this.state.invoices.get(payment.invoiceId)
          if (invoice) {
            const original = invoice.items[0]
            const item: InvoiceItem = {
              invoiceItemId: this.state.ids.next("item-", 32),
              invoiceId: invoice.invoiceId,
              accountId: invoice.accountId,
              itemType: "ITEM_ADJ",
              amount: -amount,
              currency: invoice.currency,
              description: "Refund adjustment",
              startDate: isoDate(this.now()),
              ...(original ? { linkedInvoiceItemId: original.invoiceItemId } : {}),
            }
            this.state.invoices.insert(invoice.invoiceId, {
              ...invoice,
              balance: money(invoice.balance + amount),
              refundAdj: money(invoice.refundAdj + amount),
              items: [...invoice.items, item],
            })
          }
        }
        await this.emit("PAYMENT_REFUND", "PAYMENT", payment.paymentId, payment.accountId, tenantId)
        return this.empty(201, {
          location: this.location(request, `/1.0/kb/payments/${payment.paymentId}`),
        })
      }
      if (request.method === "GET") return this.json(payment)
    }
    return this.problem(
      404,
      "NOT_FOUND",
      `No Kill Bill route for ${request.method} ${url.pathname}`,
    )
  }
}
