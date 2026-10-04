import { listLabTests } from "../db/labTestsRepo.js"
import { listOrderItems, listOrdersByUser, type OrderRow } from "../db/ordersRepo.js"
import type { UserRow } from "../db/usersRepo.js"
import type { Order, OrderEvent } from "../model.js"
import type { Db } from "../ports/db.js"

export type OrderSummary = Order

/** Persisted state only; both clients receive the same scoped data. */
export const listOrders = async (db: Db, userId?: string): Promise<Order[]> => {
  const testsById = new Map((await listLabTests(db)).map((test) => [test.id, test]))
  const usersById = new Map((await db.query<UserRow>("SELECT * FROM users")).map((user) => [user.id, user]))
  const orders = userId ? await listOrdersByUser(db, userId) : await db.query<OrderRow>("SELECT * FROM orders ORDER BY created_at DESC")
  return Promise.all(orders.map(async (order) => {
    const items = await listOrderItems(db, order.id)
    const events = await db.query<{ id: string; status: string; detail: string; actor: string; created_at: string }>("SELECT * FROM order_events WHERE order_id = $1 ORDER BY created_at ASC", [order.id])
    return {
      id: order.id, userId: order.user_id, patientName: usersById.get(order.user_id)?.name ?? "Patient",
      status: order.status, createdAt: order.created_at,
      items: items.map((item) => ({ testName: testsById.get(item.lab_test_id)?.name ?? "Unknown test", priceCents: item.price_cents })),
      labOrderId: order.lab_order_id, interpretation: order.interpretation, checkoutSessionId: order.checkout_session_id,
      results: JSON.parse(order.results_json) as Order["results"],
      timeline: events.map((event): OrderEvent => ({ ...event, createdAt: event.created_at })),
      reviewedAt: order.reviewed_at, reviewNote: order.review_note, reviewer: order.reviewer,
    }
  }))
}
