import { expect, test } from "bun:test"
import { ResourceTable } from "@emulates/model"
import { compareStripeWebhooks, stripeEventsForRequests } from "./webhook-oracle.js"

const event = (type: string, id: string, status: string) => ({
  id: `evt_${id}`,
  type,
  created: Date.now(),
  data: { object: { object: "customer", id, status, metadata: { source: "parity" } } },
})

test("metadata key order does not change webhook parity, but changed values do", () => {
  const customer = event("customer.created", "cus_fixture", "active")
  const withMetadata = (metadata: Record<string, string>) => ({
    ...customer,
    data: { object: { ...customer.data.object, metadata } },
  })
  const table = new ResourceTable()
  const real = withMetadata({ aa: "a", a: "a" })
  expect(compareStripeWebhooks([real], [withMetadata({ a: "a", aa: "a" })], table)).toBeUndefined()
  expect(compareStripeWebhooks([real], [withMetadata({ a: "a", aa: "b" })], table)).toContain(
    "event signature differs",
  )
})

test("isolates delayed cleanup events without hiding unexpected events in the current walk", () => {
  const current = {
    ...event("product.created", "prod_current", "active"),
    request: { id: "req_current" },
  }
  const cleanup = {
    ...event("product.deleted", "prod_previous", "deleted"),
    request: { id: "req_cleanup" },
  }
  const unexpected = {
    ...event("product.updated", "prod_current", "inactive"),
    request: "req_current",
  }
  const automatic = { ...event("customer.updated", "cus_auto", "active"), request: { id: null } }
  const invalid = { invalid: true }
  const selected = stripeEventsForRequests(
    [cleanup, current, unexpected, automatic, invalid],
    new Set(["req_current"]),
  )
  expect(selected).toEqual([current, unexpected, automatic, invalid])
  expect(compareStripeWebhooks(selected.slice(0, 2), [current], new ResourceTable())).toContain(
    "event count",
  )
})

test("matches reordered Stripe events across independent IDs and timestamps", () => {
  const table = new ResourceTable()
  table.register("customer", { real: "cus_real_1", mock: "cus_mock_1" })
  table.register("customer", { real: "cus_real_2", mock: "cus_mock_2" })
  const real = [
    event("customer.created", "cus_real_1", "active"),
    event("customer.updated", "cus_real_2", "inactive"),
  ]
  const mock = [
    event("customer.updated", "cus_mock_2", "inactive"),
    event("customer.created", "cus_mock_1", "active"),
  ]
  expect(compareStripeWebhooks(real, mock, table)).toBeUndefined()
  expect(
    compareStripeWebhooks(
      real,
      [mock[0], event("customer.created", "cus_mock_1", "inactive")],
      table,
    ),
  ).toContain("event signature differs")
  expect(compareStripeWebhooks(real, mock.slice(1), table)).toContain("event count")
})
