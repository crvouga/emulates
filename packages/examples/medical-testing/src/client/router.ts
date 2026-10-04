import { useEffect, useState } from "preact/hooks"

export type Route = "dashboard" | "shop" | "checkout" | "orders" | "results" | "account" | "admin"
const ROUTES: readonly Route[] = [
  "dashboard",
  "shop",
  "checkout",
  "orders",
  "results",
  "account",
  "admin",
]
const listeners = new Set<() => void>()
let embedded = false
let current: Route = "dashboard"
export const configureRouter = (inDocs: boolean): void => {
  embedded = inDocs
  current = "dashboard"
}
const parse = (): Route => {
  if (embedded) return current
  const hash = window.location.hash.replace(/^#\/?/, "")
  return (ROUTES as readonly string[]).includes(hash) ? (hash as Route) : "dashboard"
}
export const navigate = (route: Route): void => {
  current = route
  if (!embedded) window.location.hash = `/${route}`
  for (const listener of listeners) listener()
}
export const useRoute = (): Route => {
  const [route, setRoute] = useState<Route>(parse)
  useEffect(() => {
    const change = () => setRoute(parse())
    listeners.add(change)
    if (!embedded) window.addEventListener("hashchange", change)
    return () => {
      listeners.delete(change)
      window.removeEventListener("hashchange", change)
    }
  }, [])
  return route
}
