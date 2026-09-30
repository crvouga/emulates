import { describe, expect, test } from "bun:test"
import { createClock } from "@crvouga/mockingbird-service"
import { createRuntime, KillBillAPI } from "./src/index.js"
import { createServer } from "./src/server.js"

const headers = {
  authorization: `Basic ${btoa("admin:password")}`,
  "content-type": "application/json",
  "x-killbill-apikey": "bob",
  "x-killbill-apisecret": "lazar",
  "x-killbill-createdby": "acceptance-test",
}

describe("Kill Bill REST adapter", () => {
  test("runs account, subscription, invoice, payment, refund, retry, and webhook flows", async () => {
    const deliveries: Array<{ eventType: string; secret: string }> = []
    const server = await createServer({
      webhooks: {
        endpoints: [
          { url: "https://sink.test/kill-bill", secret: "webhook-secret", events: ["*"] },
        ],
        fetch: async (request) => {
          deliveries.push({
            eventType: ((await request.json()) as { eventType: string }).eventType,
            secret: request.headers.get("x-killbill-webhook-secret") ?? "",
          })
          return new Response(null, { status: 204 })
        },
      },
    })
    const request = (path: string, init: RequestInit = {}) =>
      fetch(`${server.url}/1.0/kb${path}`, { ...init, headers: { ...headers, ...init.headers } })
    const json = async <T>(path: string, init?: RequestInit) =>
      (await (await request(path, init)).json()) as T
    const post = (path: string, body: unknown) =>
      request(path, { method: "POST", body: JSON.stringify(body) })
    try {
      expect((await fetch(`${server.url}/1.0/healthcheck`)).status).toBe(200)
      expect((await fetch(`${server.url}/1.0/kb/accounts`)).status).toBe(401)
      expect(
        (
          await request("/accounts", {
            method: "POST",
            headers: { "x-killbill-createdby": "" },
            body: "{}",
          })
        ).status,
      ).toBe(400)

      const created = await post("/accounts", {
        externalKey: "acct-ext",
        currency: "USD",
        name: "Ada",
      })
      expect(created.status).toBe(201)
      const accountId = created.headers.get("location")?.split("/").at(-1) as string
      const duplicateAccount = await post("/accounts", {
        externalKey: "acct-ext",
        currency: "USD",
      })
      expect(duplicateAccount.status).toBe(409)
      expect(await duplicateAccount.json()).toEqual({
        className: "org.killbill.billing.account.api.AccountApiException",
        code: 3000,
        message: "Account already exists for key acct-ext",
        causeClassName: null,
        causeMessage: null,
        stackTrace: [],
      })
      expect(await json<{ accountId: string }>("/accounts?externalKey=acct-ext")).toMatchObject({
        accountId,
      })

      const method = await post(`/accounts/${accountId}/paymentMethods?isDefault=true`, {
        externalKey: "pm-ext",
        pluginName: "stripe",
      })
      const paymentMethodId = method.headers.get("location")?.split("/").at(-1) as string
      expect(
        (await json<Array<{ isDefault: boolean }>>(`/accounts/${accountId}/paymentMethods`))[0]
          ?.isDefault,
      ).toBe(true)
      expect((await post(`/accounts/${accountId}/tags`, ["tag-vip"])).status).toBe(201)

      const subscription = await post("/subscriptions", {
        accountId,
        externalKey: "sub-ext",
        planName: "standard-monthly",
      })
      const subscriptionId = subscription.headers.get("location")?.split("/").at(-1) as string
      expect(subscription.headers.get("location")).toEndWith(`/subscriptions/${subscriptionId}`)
      const bundles = await json<
        Array<{ bundleId: string; subscriptions: Array<{ subscriptionId: string }> }>
      >(`/accounts/${accountId}/bundles`)
      expect(bundles[0]?.subscriptions[0]?.subscriptionId).toBe(subscriptionId)
      expect(
        (await json<Array<{ balance: number }>>(`/accounts/${accountId}/invoices`))[0]?.balance,
      ).toBe(0)

      await post("/catalog", {
        plans: [{ name: "plus-monthly", amount: 125.5, currency: "USD", intervalDays: 30 }],
      })
      expect(
        (
          await request(`/subscriptions/${subscriptionId}?billingPolicy=END_OF_TERM`, {
            method: "PUT",
            body: JSON.stringify({ planName: "plus-monthly" }),
          })
        ).status,
      ).toBe(204)
      expect(
        (await json<{ pendingChangePlan: string }>(`/subscriptions/${subscriptionId}`))
          .pendingChangePlan,
      ).toBe("plus-monthly")
      await request(`/subscriptions/${subscriptionId}/changePlan`, { method: "DELETE" })
      expect(
        (await json<Record<string, unknown>>(`/subscriptions/${subscriptionId}`)).pendingChangePlan,
      ).toBeUndefined()
      await request(`/subscriptions/${subscriptionId}`, { method: "DELETE" })
      await request(`/subscriptions/${subscriptionId}/uncancel`, { method: "PUT", body: "{}" })
      expect((await json<{ state: string }>(`/subscriptions/${subscriptionId}`)).state).toBe(
        "ACTIVE",
      )

      const charge = await post(`/invoices/charges/${accountId}`, [
        { amount: 10.01, currency: "USD", description: "Usage" },
      ])
      const invoiceId = charge.headers.get("location")?.split("/").at(-1) as string
      const paid = await post(`/invoices/${invoiceId}/payments`, {
        amount: 10.01,
        paymentMethodId,
        paymentExternalKey: "pay-ext",
        transactionExternalKey: "txn-ext",
      })
      const paymentId = paid.headers.get("location")?.split("/").at(-1) as string
      const duplicate = await post(`/invoices/${invoiceId}/payments`, {
        amount: 10.01,
        paymentMethodId,
        paymentExternalKey: "pay-ext",
      })
      expect(duplicate.headers.get("location")).toEndWith(paymentId)
      await post(`/payments/${paymentId}/refunds`, {
        amount: 3.33,
        transactionExternalKey: "refund-ext",
      })
      expect(await json<{ refundedAmount: number }>(`/payments/${paymentId}`)).toMatchObject({
        refundedAmount: 3.33,
      })
      const adjusted = await json<{
        balance: number
        refundAdj: number
        items: Array<{ invoiceItemId: string; itemType: string; linkedInvoiceItemId?: string }>
      }>(`/invoices/${invoiceId}`)
      expect(adjusted).toMatchObject({ balance: 3.33, refundAdj: 3.33 })
      expect(adjusted.items.at(-1)).toMatchObject({
        itemType: "ITEM_ADJ",
        linkedInvoiceItemId: adjusted.items[0]?.invoiceItemId,
      })

      const voidable = await post(`/invoices/charges/${accountId}`, [{ amount: 4.25 }])
      expect(
        (
          await request(`/invoices/${voidable.headers.get("location")?.split("/").at(-1)}`, {
            method: "DELETE",
          })
        ).status,
      ).toBe(204)
      await fetch(`${server.url}/__admin/payments/decline-next`, { method: "POST" })
      const failed = await post(
        `/accounts/payments?externalKey=acct-ext&paymentMethodId=${paymentMethodId}`,
        { amount: 5, paymentExternalKey: "failed-pay" },
      )
      const failedId = failed.headers.get("location")?.split("/").at(-1) as string
      expect(
        (await json<{ transactions: Array<{ status: string }> }>(`/payments/${failedId}`))
          .transactions[0]?.status,
      ).toBe("PAYMENT_FAILURE")
      const retried = await fetch(`${server.url}/__admin/payments/${failedId}/retry`, {
        method: "POST",
      })
      expect(
        ((await retried.json()) as { transactions: Array<{ status: string }> }).transactions.at(-1)
          ?.status,
      ).toBe("SUCCESS")

      expect(
        (
          await request("/catalog", {
            method: "POST",
            headers: { "content-type": "application/xml" },
            body: '<catalog><plan name="xml-plan" amount="9.99"/></catalog>',
          })
        ).status,
      ).toBe(201)
      const catalog =
        await json<Array<{ products: Array<{ plans: Array<{ name: string }> }> }>>("/catalog")
      expect(Array.isArray(catalog)).toBe(true)
      expect(
        catalog
          .at(-1)
          ?.products.some((product) => product.plans.some((plan) => plan.name === "xml-plan")),
      ).toBe(true)
      await server.runtime.webhooks.idle()
      expect(deliveries.length).toBeGreaterThan(5)
      expect(deliveries.every(({ secret }) => secret === "webhook-secret")).toBe(true)
    } finally {
      await server.close()
    }
  })
  test("GET /1.0/kb/catalog returns a catalog-version array", async () => {
    const clock = createClock(() => Date.parse("2020-01-02T03:04:05.000Z"))
    const mock = createRuntime({
      clock,
      plans: [{ name: "example-monthly", amount: 10, currency: "USD" }],
    })
    const response = await mock.fetch(
      new Request("http://mock/1.0/kb/catalog", {
        headers: {
          authorization: `Basic ${btoa("admin:password")}`,
          accept: "application/json",
          "x-killbill-apikey": "bob",
          "x-killbill-apisecret": "lazar",
        },
      }),
    )
    expect(response.status).toBe(200)
    const versions = (await response.json()) as Array<{
      plans?: Array<{ name: string }>
      products: Array<{ plans: Array<{ name: string; phases: Array<{ prices: unknown }> }> }>
    }>
    expect(Array.isArray(versions)).toBe(true)
    const latest = versions.at(-1)
    expect(latest?.plans).toBeUndefined()
    expect(
      (latest?.products ?? []).flatMap((product) => product.plans.map((plan) => plan.name)),
    ).toEqual(["example-monthly"])
    expect(latest).toEqual({
      name: "default",
      effectiveDate: "2020-01-02T03:04:05.000Z",
      currencies: ["USD"],
      units: [],
      products: [
        {
          type: "BASE",
          name: "example-monthly",
          prettyName: "example-monthly",
          plans: [
            {
              name: "example-monthly",
              prettyName: "example-monthly",
              recurringBillingMode: "IN_ADVANCE",
              billingPeriod: "MONTHLY",
              phases: [
                {
                  type: "EVERGREEN",
                  prices: [{ currency: "USD", value: 10 }],
                  fixedPrices: [],
                  duration: { unit: "UNLIMITED", number: -1 },
                  usages: [],
                },
              ],
            },
          ],
          included: [],
          available: [],
        },
      ],
      priceLists: [{ name: "DEFAULT", plans: ["example-monthly"] }],
    })
  })

  test("stores plans from a Kill Bill catalog XML document", async () => {
    const server = await createServer()
    const request = (path: string, init: RequestInit = {}) =>
      fetch(`${server.url}/1.0/kb${path}`, { ...init, headers: { ...headers, ...init.headers } })
    const plans = async () => {
      const versions = (await (await request("/catalog")).json()) as Array<{
        products: Array<{
          plans: Array<{
            name: string
            billingPeriod: string
            phases: Array<{ prices: Array<{ currency?: string; value: number }> }>
          }>
        }>
      }>
      return (versions.at(-1)?.products ?? []).flatMap((product) =>
        product.plans.map((plan) => ({
          name: plan.name,
          amount: plan.phases[0]?.prices[0]?.value,
          currency: plan.phases[0]?.prices[0]?.currency,
          billingPeriod: plan.billingPeriod,
        })),
      )
    }
    const catalogXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<catalog>
  <effectiveDate>2026-01-01T00:00:00Z</effectiveDate>
  <products>
    <product name="Example">
      <plans>
        <plan name="example-monthly">
          <finalPhase type="EVERGREEN">
            <duration><unit>UNLIMITED</unit></duration>
            <recurring>
              <billingPeriod>MONTHLY</billingPeriod>
              <recurringPrice>
                <price><currency>USD</currency><value>10.00</value></price>
              </recurringPrice>
            </recurring>
          </finalPhase>
        </plan>
      </plans>
    </product>
  </products>
</catalog>`
    const versionedXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<catalog>
  <effectiveDate>2026-02-01T00:00:00+00:00</effectiveDate>
  <catalogName>Example</catalogName>
  <currencies><currency>USD</currency><currency>GBP</currency></currencies>
  <products>
    <product name="Example"><category>BASE</category></product>
  </products>
  <rules></rules>
  <plans>
    <plan name="sibling-monthly">
      <product>Example</product>
      <initialPhases>
        <phase type="TRIAL">
          <duration><unit>DAYS</unit><number>14</number></duration>
          <recurring>
            <billingPeriod>DAILY</billingPeriod>
            <recurringPrice>
              <price><currency>USD</currency><value>0.00</value></price>
            </recurringPrice>
          </recurring>
        </phase>
      </initialPhases>
      <finalPhase type="EVERGREEN">
        <duration><unit>UNLIMITED</unit></duration>
        <recurring>
          <billingPeriod>ANNUAL</billingPeriod>
          <recurringPrice>
            <price><currency>GBP</currency><value>5.00</value></price>
            <price><currency>USD</currency><value>12.50</value></price>
          </recurringPrice>
        </recurring>
      </finalPhase>
    </plan>
  </plans>
  <priceLists>
    <defaultPriceList name="DEFAULT">
      <plans><plan>sibling-monthly</plan></plans>
    </defaultPriceList>
  </priceLists>
</catalog>`
    try {
      const posted = await request("/catalog/xml", {
        method: "POST",
        headers: { "content-type": "text/xml" },
        body: catalogXml,
      })
      expect(posted.status).toBe(201)
      expect(await plans()).toContainEqual({
        name: "example-monthly",
        amount: 10,
        currency: "USD",
        billingPeriod: "MONTHLY",
      })
      const created = await request("/accounts", {
        method: "POST",
        body: JSON.stringify({ externalKey: "catalog-acct", currency: "USD" }),
      })
      const accountId = created.headers.get("location")?.split("/").at(-1) as string
      expect(
        (
          await request("/subscriptions", {
            method: "POST",
            body: JSON.stringify({ accountId, planName: "example-monthly" }),
          })
        ).status,
      ).toBe(201)
      expect(
        (
          await request("/catalog/xml", {
            method: "POST",
            headers: { "content-type": "text/xml" },
            body: versionedXml,
          })
        ).status,
      ).toBe(201)
      const stored = await plans()
      expect(stored).toContainEqual({
        name: "sibling-monthly",
        amount: 12.5,
        currency: "USD",
        billingPeriod: "ANNUAL",
      })
      expect(stored.some((plan) => plan.name === "sibling-monthly" && plan.amount === 0)).toBe(
        false,
      )
      expect(
        stored.some((plan) => plan.name === "sibling-monthly" && plan.billingPeriod === "DAILY"),
      ).toBe(false)
    } finally {
      await server.close()
    }
  })

  test("create subscription Location is the subscription and the document includes phaseType", async () => {
    const api = new KillBillAPI({
      plans: [{ name: "example-monthly", amount: 10, currency: "USD" }],
    })
    const call = (path: string, init: RequestInit = {}) =>
      api.fetch(
        new Request(`http://mock/1.0/kb${path}`, {
          ...init,
          headers: { ...headers, ...init.headers },
        }),
      )
    const account = await call("/accounts", {
      method: "POST",
      body: JSON.stringify({ externalKey: "member-1", currency: "USD" }),
    })
    const accountId = account.headers.get("location")?.split("/").pop()
    const created = await call("/subscriptions", {
      method: "POST",
      body: JSON.stringify({ accountId, planName: "example-monthly" }),
    })
    const location = created.headers.get("location") ?? ""
    const subscriptionId = location.split("/").pop()
    const follow = await api.fetch(new Request(location, { headers }))
    const document = (await follow.json()) as {
      subscriptionId: string
      bundleId: string
      accountId: string
      planName: string
      phaseType: string
      state: string
      startDate: string
      chargedThroughDate: string
    }
    const addon = await call("/subscriptions?requestedDate=2024-01-15", {
      method: "POST",
      body: JSON.stringify({
        accountId,
        bundleId: document.bundleId,
        planName: "example-monthly",
      }),
    })
    const addonLocation = addon.headers.get("location") ?? ""
    const addonId = addonLocation.split("/").pop()
    const addonFollow = await api.fetch(new Request(addonLocation, { headers }))

    expect(created.status).toBe(201)
    expect(await created.text()).toBe("")
    expect(location).toEndWith(`/1.0/kb/subscriptions/${subscriptionId}`)
    expect(follow.status).toBe(200)
    expect(document).toMatchObject({
      subscriptionId,
      accountId,
      planName: "example-monthly",
      phaseType: "EVERGREEN",
      state: "ACTIVE",
    })
    expect(typeof document.bundleId).toBe("string")
    expect(document.bundleId).not.toBe(subscriptionId)
    expect(document.startDate).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(document.chargedThroughDate).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(addon.status).toBe(201)
    expect(addonLocation).toEndWith(`/1.0/kb/subscriptions/${addonId}`)
    expect(addonId).not.toBe(document.bundleId)
    expect(addonId).not.toBe(subscriptionId)
    expect(await addonFollow.json()).toMatchObject({
      subscriptionId: addonId,
      bundleId: document.bundleId,
      accountId,
      planName: "example-monthly",
      phaseType: "EVERGREEN",
      state: "ACTIVE",
    })
  })

  test("GET /test/clock returns Kill Bill's currentUtcTime, localDate, and timeZone", async () => {
    const fixed = Date.parse("2026-09-29T02:30:00.000Z")
    const api = new KillBillAPI({ now: () => fixed })
    const clock = (path: string, init: RequestInit = {}) =>
      api.fetch(new Request(`http://mock/1.0/kb${path}`, { ...init, headers }))
    const body = (await (await clock("/test/clock")).json()) as Record<string, unknown>
    expect(body).toEqual({
      currentUtcTime: "2026-09-29T02:30:00.000Z",
      timeZone: "UTC",
      localDate: "2026-09-29",
    })
    expect(body).not.toHaveProperty("utc")

    expect(await (await clock("/test/clock?timeZone=America/Los_Angeles")).json()).toEqual({
      currentUtcTime: "2026-09-29T02:30:00.000Z",
      timeZone: "America/Los_Angeles",
      localDate: "2026-09-28",
    })
    expect(await (await clock("/test/clock?timeZone=-08:00")).json()).toEqual({
      currentUtcTime: "2026-09-29T02:30:00.000Z",
      timeZone: "-08:00",
      localDate: "2026-09-28",
    })
    expect((await clock("/test/clock?timeZone=Not/AZone")).status).toBe(400)

    const moved = await clock("/test/clock?requestedDate=2015-12-14T23:02:15.000Z", {
      method: "PUT",
    })
    expect(moved.status).toBe(200)
    expect(await moved.json()).toEqual({
      currentUtcTime: "2015-12-14T23:02:15.000Z",
      timeZone: "UTC",
      localDate: "2015-12-14",
    })
    expect(await (await clock("/test/clock")).json()).toMatchObject({
      currentUtcTime: "2015-12-14T23:02:15.000Z",
    })
  })

  test("lists invoice payments with targetInvoiceId and records one external purchase", async () => {
    const server = await createServer()
    const request = (path: string, init: RequestInit = {}) =>
      fetch(`${server.url}/1.0/kb${path}`, { ...init, headers: { ...headers, ...init.headers } })
    const json = async <T>(path: string, init?: RequestInit) =>
      (await (await request(path, init)).json()) as T
    const post = (path: string, body: unknown) =>
      request(path, { method: "POST", body: JSON.stringify(body) })
    try {
      const created = await post("/accounts", { externalKey: "ext-pay", currency: "USD" })
      const accountId = created.headers.get("location")?.split("/").at(-1) as string
      const charge = await post(`/invoices/charges/${accountId}`, [
        { amount: 10, currency: "USD", description: "Visit" },
      ])
      const invoiceId = charge.headers.get("location")?.split("/").at(-1) as string
      await fetch(`${server.url}/__admin/payments/decline-next`, { method: "POST" })
      const paid = await post(`/invoices/${invoiceId}/payments?externalPayment=true`, {
        accountId,
        purchasedAmount: 10,
        currency: "USD",
        paymentExternalKey: "ext-pay-1",
      })
      expect(paid.status).toBe(201)
      const paymentId = paid.headers.get("location")?.split("/").at(-1) as string
      const duplicate = await post(`/invoices/${invoiceId}/payments?externalPayment=true`, {
        accountId,
        purchasedAmount: 10,
        currency: "USD",
        paymentExternalKey: "ext-pay-1",
      })
      expect(duplicate.status).toBe(201)
      expect(duplicate.headers.get("location")).toEndWith(paymentId)
      const payments = await json<
        Array<{
          targetInvoiceId?: string
          invoiceId?: string
          accountId: string
          paymentId: string
          paymentExternalKey: string
          paymentMethodId?: string
          purchasedAmount: number
          refundedAmount: number
          currency: string
          transactions: Array<{
            transactionId: string
            transactionExternalKey: string
            paymentId: string
            transactionType: string
            amount: number
            currency: string
            status: string
          }>
        }>
      >(`/invoices/${invoiceId}/payments`)
      expect(payments).toHaveLength(1)
      expect(payments[0]).toMatchObject({
        targetInvoiceId: invoiceId,
        accountId,
        paymentId,
        paymentExternalKey: "ext-pay-1",
        purchasedAmount: 10,
        refundedAmount: 0,
        currency: "USD",
      })
      expect(payments[0]).not.toHaveProperty("invoiceId")
      expect(payments[0]?.paymentMethodId).toEqual(expect.any(String))
      expect(payments[0]?.transactions[0]).toEqual(
        expect.objectContaining({
          transactionId: expect.any(String),
          transactionExternalKey: expect.any(String),
          paymentId,
          transactionType: "PURCHASE",
          amount: 10,
          currency: "USD",
          status: "SUCCESS",
        }),
      )
      expect((await json<{ balance: number }>(`/invoices/${invoiceId}`)).balance).toBe(0)
      const method = await json<{ pluginName: string }>(
        `/paymentMethods/${payments[0]?.paymentMethodId}`,
      )
      expect(method.pluginName).toBe("__EXTERNAL_PAYMENT__")

      const card = await post(`/accounts/${accountId}/paymentMethods?isDefault=true`, {
        pluginName: "stripe",
      })
      const paymentMethodId = card.headers.get("location")?.split("/").at(-1) as string
      const second = await post(`/invoices/charges/${accountId}`, [{ amount: 4, currency: "USD" }])
      const secondInvoiceId = second.headers.get("location")?.split("/").at(-1) as string
      const gateway = await post(`/invoices/${secondInvoiceId}/payments`, {
        amount: 4,
        paymentMethodId,
        paymentExternalKey: "gateway-pay",
      })
      const gatewayId = gateway.headers.get("location")?.split("/").at(-1) as string
      expect(
        (await json<{ transactions: Array<{ status: string }> }>(`/payments/${gatewayId}`))
          .transactions[0]?.status,
      ).toBe("PAYMENT_FAILURE")
    } finally {
      await server.close()
    }
  })
})
