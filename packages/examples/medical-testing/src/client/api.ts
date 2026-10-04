import type { AdminData, LabTest, Order, Role, User } from "../app/model.js"

export type { LabTest, Order, Role, User } from "../app/model.js"
export type OAuthProvider = "google" | "apple"
export type OAuthStepResponse =
  | { flowId: string; html: string; user?: undefined }
  | { user: User; flowId?: undefined; html?: undefined }
export type HostedCheckoutStepResponse =
  | { flowId: string; html: string; done?: undefined }
  | { done: true; flowId?: undefined; html?: undefined }
export type Fetcher = (path: string, init?: RequestInit) => Promise<Response>

// Defaults to a real network fetch (the standalone Bun dev server case).
// src/browser.ts calls setFetcher() to redirect every call here straight
// into an in-process Hono app instead, with no socket involved.
let fetcher: Fetcher = (path, init) => fetch(path, init)

export const setFetcher = (f: Fetcher): void => {
  fetcher = f
}

// A 401 partway through a session (an expired/lost cookie, or a page that
// got reloaded out from under an in-progress session — this whole app runs
// in one browser tab with no server-side session store beyond memory) used
// to leave the UI stuck showing a stale "Sign in required" banner while
// still looking signed in. Instead, treat any 401 as "the session is gone"
// and bounce the whole app back to sign-in — see main.ts's listener.
const unauthorizedListeners = new Set<() => void>()
export const onUnauthorized = (listener: () => void): (() => void) => {
  unauthorizedListeners.add(listener)
  return () => unauthorizedListeners.delete(listener)
}

const request = async <T>(path: string, init?: RequestInit): Promise<T> => {
  const response = await fetcher(path, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
    credentials: "same-origin",
  })
  const body = (await response
    .json()
    .catch(() => ({ error: "The server returned an unreadable response. Try again." }))) as T & {
    error?: string
  }
  if (!response.ok) {
    if (response.status === 401) for (const listener of unauthorizedListeners) listener()
    throw new Error(body.error ?? `Request to ${path} failed with ${response.status}`)
  }
  if (body.error) throw new Error(body.error)
  return body
}

export const api = {
  me: () => request<{ user: User | null }>("/api/auth/me"),
  oauthStart: (provider: OAuthProvider) =>
    request<OAuthStepResponse>(`/api/auth/${provider}/start`, { method: "POST" }),
  oauthStep: (
    provider: OAuthProvider,
    flowId: string,
    action: string,
    method: string,
    body: string,
  ) =>
    request<OAuthStepResponse>(`/api/auth/${provider}/step`, {
      method: "POST",
      body: JSON.stringify({ flowId, action, method, body }),
    }),
  signOut: () => request<{ ok: true }>("/api/auth/sign-out", { method: "POST" }),
  tests: () => request<{ tests: LabTest[] }>("/api/tests"),
  checkout: (testIds: string[]) =>
    request<{ orderId: string; checkoutSessionId: string; hostedPageUrl: string }>(
      "/api/checkout",
      {
        method: "POST",
        body: JSON.stringify({ testIds }),
      },
    ),
  hostedCheckoutStart: (checkoutSessionId: string) =>
    request<HostedCheckoutStepResponse>("/api/checkout/hosted/start", {
      method: "POST",
      body: JSON.stringify({ checkoutSessionId }),
    }),
  hostedCheckoutStep: (flowId: string, action: string, method: string, body: string) =>
    request<HostedCheckoutStepResponse>("/api/checkout/hosted/step", {
      method: "POST",
      body: JSON.stringify({ flowId, action, method, body }),
    }),
  orders: (workspace = false) =>
    request<{ orders: Order[] }>(`/api/orders${workspace ? "?scope=workspace" : ""}`),
  profile: (name: string, notifications: boolean) =>
    request<{ user: User }>("/api/auth/profile", {
      method: "PATCH",
      body: JSON.stringify({ name, notifications }),
    }),
  admin: () => request<AdminData>("/api/admin"),
  changeRole: (id: string, role: Role) =>
    request<{ ok: true }>(`/api/admin/users/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ role }),
    }),
  review: (id: string, note: string) =>
    request<{ ok: true }>(`/api/orders/${id}/review`, {
      method: "POST",
      body: JSON.stringify({ note }),
    }),
  file: async (id: string, kind: "results" | "receipt" | "record") => {
    const response = await fetcher(`/api/orders/${id}/files/${kind}`, {
      credentials: "same-origin",
    })
    if (!response.ok) {
      if (response.status === 401) for (const listener of unauthorizedListeners) listener()
      const body = (await response.json()) as { error?: string }
      throw new Error(body.error ?? "Download failed. Please try again.")
    }
    return response.blob()
  },
}
