import { describe, expect, test } from "bun:test"
import { createClock } from "@crvouga/mockingbird-service"
import { createRuntime } from "./src/index.js"
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
      expect((await post("/accounts", { externalKey: "acct-ext", currency: "USD" })).status).toBe(
        400,
      )
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
      const bundleId = subscription.headers.get("location")?.split("/").at(-1) as string
      const bundles = await json<
        Array<{ bundleId: string; subscriptions: Array<{ subscriptionId: string }> }>
      >(`/accounts/${accountId}/bundles`)
      expect(bundles[0]?.bundleId).toBe(bundleId)
      const subscriptionId = bundles[0]?.subscriptions[0]?.subscriptionId as string
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
})
