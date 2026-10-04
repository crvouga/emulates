import { Hono } from "hono"
import { audit } from "../../db/ordersRepo.js"
import { findUserById, publicUser, type UserRow } from "../../db/usersRepo.js"
import { can, isRole } from "../../model.js"
import type { AppEnv } from "../appEnv.js"

export const adminRoutes = new Hono<AppEnv>()
adminRoutes.use("*", async (c, next) => {
  const user = c.get("user")
  if (!user) return c.json({ error: "Sign in required" }, 401)
  if (!can(user.role, "users.manage"))
    return c.json({ error: "Administrator access required." }, 403)
  return next()
})
adminRoutes.get("/", async (c) => {
  const db = c.get("db")
  const users = (await db.query<UserRow>("SELECT * FROM users ORDER BY created_at ASC")).map(
    publicUser,
  )
  const events = await db.query<{
    id: string
    actor: string
    action: string
    target: string
    created_at: string
  }>("SELECT * FROM audit_events ORDER BY created_at DESC LIMIT 100")
  return c.json({
    users,
    audit: events.map((event) => ({ ...event, createdAt: event.created_at })),
  })
})
adminRoutes.patch("/users/:id", async (c) => {
  const actor = c.get("user")
  if (!actor) return c.json({ error: "Sign in required" }, 401)
  const { role } = await c.req.json<{ role?: unknown }>()
  if (!isRole(role)) return c.json({ error: "Choose patient, clinician, or admin." }, 400)
  const user = await findUserById(c.get("db"), c.req.param("id"))
  if (!user) return c.json({ error: "User not found." }, 404)
  if (user.id === actor.id) return c.json({ error: "You cannot change your own role." }, 409)
  await c.get("db").query("UPDATE users SET role = $2 WHERE id = $1", [user.id, role])
  await audit(
    c.get("db"),
    actor.name ?? "Administrator",
    `Changed role from ${user.role} to ${role}`,
    user.name ?? user.id,
  )
  return c.json({ ok: true })
})
