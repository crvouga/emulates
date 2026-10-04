/** Shared application contracts: used by the HTTP app and both clients. */
export const ROLES = ["patient", "clinician", "admin"] as const
export type Role = (typeof ROLES)[number]
export const PERMISSIONS = {
  patient: ["orders.own", "orders.create", "profile.edit"],
  clinician: ["orders.own", "orders.create", "profile.edit", "orders.read", "results.review"],
  admin: [
    "orders.own",
    "orders.create",
    "profile.edit",
    "orders.read",
    "results.review",
    "users.manage",
    "audit.read",
  ],
} as const
export type Permission = (typeof PERMISSIONS)[Role][number]
export const can = (role: Role, permission: Permission): boolean =>
  (PERMISSIONS[role] as readonly string[]).includes(permission)
export const isRole = (value: unknown): value is Role => ROLES.some((role) => role === value)
export type LabTest = {
  id: string
  name: string
  description: string
  category: string
  priceCents: number
}
export type User = {
  id: string
  provider: string
  email: string | null
  name: string | null
  picture: string | null
  role: Role
  notifications: boolean
}
export type Marker = {
  name: string
  value: number
  unit: string
  low: number
  high: number
  flag: "normal" | "high" | "low"
  previous: number
}
export type OrderEvent = {
  id: string
  status: string
  detail: string
  actor: string
  createdAt: string
}
export type Order = {
  id: string
  userId: string
  patientName: string
  status: string
  createdAt: string
  items: { testName: string; priceCents: number }[]
  labOrderId: string | null
  interpretation: string | null
  checkoutSessionId: string
  results: { panel: string; markers: Marker[] }[]
  timeline: OrderEvent[]
  reviewedAt: string | null
  reviewNote: string | null
  reviewer: string | null
}
export type AuditEvent = {
  id: string
  actor: string
  action: string
  target: string
  createdAt: string
}
export type AdminData = { users: User[]; audit: AuditEvent[] }
