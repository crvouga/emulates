import type { Db } from "../ports/db.js"

export type OrderRow = {
  id: string
  user_id: string
  status: string
  checkout_session_id: string
  lab_order_id: string | null
  interpretation: string | null
  results_json: string
  reviewed_at: string | null
  review_note: string | null
  reviewer: string | null
  created_at: string
}

export type OrderItemRow = {
  id: string
  order_id: string
  lab_test_id: string
  price_cents: number
}

export const insertOrder = async (
  db: Db,
  order: { id: string; userId: string; status: string; checkoutSessionId: string },
): Promise<void> => {
  await db.query(
    `INSERT INTO orders (id, user_id, status, checkout_session_id) VALUES ($1, $2, $3, $4)`,
    [order.id, order.userId, order.status, order.checkoutSessionId],
  )
  await appendOrderEvent(
    db,
    order.id,
    "pending_payment",
    "Order placed. Awaiting payment.",
    "Patient",
  )
}

export const insertOrderItem = async (
  db: Db,
  item: { id: string; orderId: string; labTestId: string; priceCents: number },
): Promise<void> => {
  await db.query(
    `INSERT INTO order_items (id, order_id, lab_test_id, price_cents) VALUES ($1, $2, $3, $4)`,
    [item.id, item.orderId, item.labTestId, item.priceCents],
  )
}

export const findOrderById = async (db: Db, id: string): Promise<OrderRow | undefined> =>
  (await db.query<OrderRow>(`SELECT * FROM orders WHERE id = $1`, [id]))[0]

export const findOrderByCheckoutSessionId = async (
  db: Db,
  checkoutSessionId: string,
): Promise<OrderRow | undefined> =>
  (
    await db.query<OrderRow>(`SELECT * FROM orders WHERE checkout_session_id = $1`, [
      checkoutSessionId,
    ])
  )[0]

export const findOrderByLabOrderId = async (
  db: Db,
  labOrderId: string,
): Promise<OrderRow | undefined> =>
  (await db.query<OrderRow>(`SELECT * FROM orders WHERE lab_order_id = $1`, [labOrderId]))[0]

export const listOrdersByUser = async (db: Db, userId: string): Promise<OrderRow[]> =>
  db.query<OrderRow>(`SELECT * FROM orders WHERE user_id = $1 ORDER BY created_at DESC`, [userId])

export const listOrderItems = async (db: Db, orderId: string): Promise<OrderItemRow[]> =>
  db.query<OrderItemRow>(`SELECT * FROM order_items WHERE order_id = $1`, [orderId])

export const markOrderFulfilled = async (
  db: Db,
  orderId: string,
  labOrderId: string,
): Promise<void> => {
  await db.query(`UPDATE orders SET status = 'fulfilled', lab_order_id = $2 WHERE id = $1`, [
    orderId,
    labOrderId,
  ])
  await appendOrderEvent(
    db,
    orderId,
    "fulfilled",
    "Payment confirmed. Collection kit requested.",
    "Payments",
  )
}

export const updateOrderStatus = async (
  db: Db,
  orderId: string,
  status: string,
  interpretation: string | null,
): Promise<void> => {
  await db.query(`UPDATE orders SET status = $2, interpretation = $3 WHERE id = $1`, [
    orderId,
    status,
    interpretation,
  ])
}

export const appendOrderEvent = async (
  db: Db,
  orderId: string,
  status: string,
  detail: string,
  actor: string,
): Promise<void> => {
  await db.query(
    "INSERT INTO order_events (id, order_id, status, detail, actor) VALUES ($1, $2, $3, $4, $5)",
    [crypto.randomUUID(), orderId, status, detail, actor],
  )
}
export const audit = async (
  db: Db,
  actor: string,
  action: string,
  target: string,
): Promise<void> => {
  await db.query("INSERT INTO audit_events (id, actor, action, target) VALUES ($1, $2, $3, $4)", [
    crypto.randomUUID(),
    actor,
    action,
    target,
  ])
}
