import { html } from "htm/preact"
import { useState } from "preact/hooks"
import { PERMISSIONS } from "../../app/model.js"
import { api, type User } from "../api.js"
import { message } from "../components/States.js"

const LABELS: Record<string, string> = {
  "orders.own": "View your orders and download your records",
  "orders.create": "Order tests and complete checkout",
  "profile.edit": "Edit your profile and notification preferences",
  "orders.read": "View all patient orders and reports",
  "results.review": "Review results and write care notes",
  "users.manage": "Manage workspace members and roles",
  "audit.read": "Read the workspace audit log",
}
export const Account = ({
  user,
  onUpdated,
  onSignOut,
  signingOut,
}: {
  user: User
  onUpdated: (user: User) => void
  onSignOut: () => Promise<void>
  signingOut: boolean
}) => {
  const [name, setName] = useState(user.name ?? "")
  const [notifications, setNotifications] = useState(user.notifications)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)
  const dirty = name !== (user.name ?? "") || notifications !== user.notifications
  const save = async (event: Event) => {
    event.preventDefault()
    setBusy(true)
    setError(null)
    setSuccess(false)
    try {
      onUpdated((await api.profile(name, notifications)).user)
      setSuccess(true)
    } catch (error) {
      setError(message(error))
    } finally {
      setBusy(false)
    }
  }
  return html`<div class="cove-page"><div><p class="cove-eyebrow">Settings</p><h1>Your account</h1><p class="cove-lede">Manage your profile, preferences, and access.</p></div>
    ${error && html`<p class="cove-alert cove-alert-error" role="alert">${error}</p>`}${success && html`<p class="cove-alert cove-alert-success" role="status">Your changes have been saved.</p>`}
    <div class="cove-dashboard-grid"><section class="cove-card"><h2>Profile & preferences</h2><form onSubmit=${save}><label class="cove-field">Full name<input class="cove-input" required maxlength="80" value=${name} onInput=${(
      event: Event,
    ) => {
      setName((event.target as HTMLInputElement).value)
      setSuccess(false)
    }}/></label><label class="cove-field">Email<input class="cove-input" readonly value=${user.email ?? "Not shared"}/></label><p class="cove-muted cove-text-sm">Your email is managed by your ${user.provider === "apple" ? "Apple" : "Google"} sign-in account.</p><label class="cove-checkbox"><input type="checkbox" checked=${notifications} onChange=${(
      event: Event,
    ) => {
      setNotifications((event.target as HTMLInputElement).checked)
      setSuccess(false)
    }}/><span>Show result updates on my overview<small>Highlight new reports and next steps in this workspace.</small></span></label><button class="cove-btn cove-btn-primary" disabled=${busy || !dirty || !name.trim()}>${busy ? "Saving…" : "Save changes"}</button></form></section>
    <section class="cove-card"><h2>Your access</h2><p><span class="cove-role">${user.role}</span></p><ul class="cove-permission-list">${PERMISSIONS[user.role].map((permission) => html`<li key=${permission}><span aria-hidden="true">✓</span>${LABELS[permission]}</li>`)}</ul><p class="cove-muted cove-text-sm">Workspace administrators manage roles. Permissions are checked for every request.</p></section></div>
    <section class="cove-card"><h2>Session</h2><div class="cove-section-head"><p class="cove-muted">Signed in with ${user.provider === "apple" ? "Apple" : "Google"}. Sign out to switch accounts.</p><button class="cove-btn cove-btn-ghost" disabled=${signingOut} onClick=${onSignOut}>${signingOut ? "Signing out…" : "Sign out"}</button></div></section>
  </div>`
}
