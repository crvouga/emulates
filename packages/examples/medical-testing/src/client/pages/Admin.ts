import { html } from "htm/preact"
import { useState } from "preact/hooks"
import { PERMISSIONS, ROLES } from "../../app/model.js"
import { api, type Role, type User } from "../api.js"
import { Empty, ErrorState, Loading, message, useResource } from "../components/States.js"

import { Tabs } from "../components/Tabs.js"

export const Admin = ({ user }: { user: User }) => {
  const resource = useResource(api.admin)
  const [tab, setTab] = useState("members")
  const [search, setSearch] = useState("")
  const [pending, setPending] = useState<{ user: User; role: Role } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)
  const change = async () => {
    if (!pending) return
    setBusy(true)
    setError(null)
    setSuccess(null)
    try {
      await api.changeRole(pending.user.id, pending.role)
      setSuccess(`${pending.user.name} now has the ${pending.role} role.`)
      setPending(null)
      await resource.refresh()
    } catch (error) {
      setError(message(error))
    } finally {
      setBusy(false)
    }
  }
  return html`<div class="cove-page"><div class="cove-page-head"><div><p class="cove-eyebrow">Workspace settings</p><h1>Administration</h1><p class="cove-lede">Manage member access and inspect activity across the workspace.</p></div><button class="cove-btn cove-btn-ghost" disabled=${resource.busy} onClick=${resource.refresh}>Refresh</button></div>
    ${resource.error && html`<${ErrorState} error=${resource.error} retry=${resource.refresh}/>`}${error && html`<p class="cove-alert cove-alert-error" role="alert">${error}</p>`}${success && html`<p class="cove-alert cove-alert-success" role="status">${success}</p>`}
    <${Tabs} tabs=${[{ value: "members", label: "Members" }, { value: "permissions", label: "Role permissions" }, { value: "audit", label: "Audit log" }]} value=${tab} onSelect=${setTab} prefix="admin-tab" panel="admin-panel" label="Administration"/>
    ${
      !resource.data && resource.busy
        ? html`<${Loading} label="Loading administration…"/>`
        : resource.data &&
          html`<section role="tabpanel" id="admin-panel" aria-labelledby=${`admin-tab-${tab}`}>
      ${tab === "members" && html`<div class="cove-card"><div class="cove-section-head"><h2>Workspace members (${resource.data.users.length})</h2><label class="cove-search">Search members<input class="cove-input" type="search" placeholder="Name or email…" value=${search} onInput=${(event: Event) => setSearch((event.target as HTMLInputElement).value)}/></label></div>${pending && html`<div class="cove-confirm" role="region" aria-label="Confirm role change"><h3>Change ${pending.user.name} to ${pending.role}?</h3><p>Access changes immediately. This action will be recorded in the audit log.</p><div class="cove-toolbar"><button class="cove-btn cove-btn-primary" disabled=${busy} onClick=${change}>${busy ? "Updating…" : "Confirm role change"}</button><button class="cove-btn cove-btn-ghost" disabled=${busy} onClick=${() => setPending(null)}>Cancel</button></div></div>`}<div class="cove-table-scroll"><table class="cove-results-table"><thead><tr><th>Member</th><th>Email</th><th>Role</th></tr></thead><tbody>${resource.data.users.filter((member) => `${member.name} ${member.email}`.toLowerCase().includes(search.toLowerCase())).map((member) => html`<tr key=${member.id}><td><strong>${member.name}</strong>${member.id === user.id && html`<small class="cove-muted"> (you)</small>`}</td><td>${member.email}</td><td><label class="cove-field"><span class="cove-sr-only">Role for ${member.name}</span><select class="cove-input" value=${member.role} disabled=${member.id === user.id || busy || pending !== null} onChange=${(event: Event) => setPending({ user: member, role: (event.target as HTMLSelectElement).value as Role })}>${ROLES.map((role) => html`<option key=${role} value=${role}>${role}</option>`)}</select></label></td></tr>`)}</tbody></table></div><p class="cove-muted cove-text-sm">You cannot change your own role. New sign-ins receive the patient role by default.</p></div>`}
      ${tab === "permissions" && html`<div class="cove-card"><h2>Role permissions</h2><p class="cove-muted">The server enforces this matrix for every authenticated request.</p><div class="cove-table-scroll"><table class="cove-results-table"><thead><tr><th>Permission</th>${ROLES.map((role) => html`<th key=${role}>${role}</th>`)}</tr></thead><tbody>${PERMISSIONS.admin.map((permission) => html`<tr key=${permission}><td>${permission}</td>${ROLES.map((role) => html`<td key=${role}>${(PERMISSIONS[role] as readonly string[]).includes(permission) ? "Allowed" : "—"}</td>`)}</tr>`)}</tbody></table></div></div>`}
      ${tab === "audit" && (resource.data.audit.length ? html`<div class="cove-card"><h2>Recent activity</h2><p class="cove-muted cove-text-sm">Latest 100 role changes, reviews, and document downloads.</p><div class="cove-table-scroll"><table class="cove-results-table"><thead><tr><th>When</th><th>Actor</th><th>Action</th><th>Target</th></tr></thead><tbody>${resource.data.audit.map((event) => html`<tr key=${event.id}><td>${new Date(event.createdAt).toLocaleString()}</td><td>${event.actor}</td><td>${event.action}</td><td>${event.target}</td></tr>`)}</tbody></table></div></div>` : html`<${Empty} title="No activity recorded yet" detail="Role changes, clinical reviews, and downloads will appear here."/>`)}
    </section>`
    }
  </div>`
}
