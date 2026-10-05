import { html } from "htm/preact"
import { useState } from "preact/hooks"
import type { OAuthProvider, User } from "../api.js"
import { Logo } from "../components/Logo.js"
import { AppleButton, GoogleButton } from "../components/OAuthButtons.js"
import { OAuthModal } from "../components/OAuthModal.js"

export const Landing = ({ onSignedIn }: { onSignedIn: (user: User) => void }) => {
  const [provider, setProvider] = useState<OAuthProvider | null>(null)
  return html`<div class="cove-signin-layout"><section class="cove-signin-intro"><span class="cove-wordmark"><${Logo}/></span><p class="cove-eyebrow">Your testing workspace</p><h1>From your first test<br/>to your next step.</h1><p class="cove-lede">Order lab tests, follow their progress, and explore detailed results in one place.</p><div class="cove-signin-features">${[
    ["01", "Order with confidence", "Browse tests and review clear, itemized pricing."],
    ["02", "Follow every step", "Track collection, processing, and care team review."],
    ["03", "Keep your records", "Compare measurements and download your reports."],
  ].map(
    ([number, title, detail]) =>
      html`<div key=${number}><span>${number}</span><div><h2>${title}</h2><p>${detail}</p></div></div>`,
  )}</div></section><section class="cove-card cove-signin-card"><p class="cove-eyebrow">Welcome</p><h2>Sign in to your account</h2><p class="cove-muted">Choose a provider to continue securely.</p><div class="cove-signin-box"><${GoogleButton} onClick=${() => setProvider("google")}/><${AppleButton} onClick=${() => setProvider("apple")}/></div><div class="cove-demo-accounts"><h3>Explore the workspace</h3><p class="cove-muted cove-text-sm">The Google account chooser includes three fictional accounts:</p>${[
    ["Ada Lovelace", "Patient", "Orders, detailed results, and downloads"],
    ["Morgan Chen", "Clinician", "All patient reports and clinical review"],
    ["Alex Morgan", "Administrator", "Members, roles, and audit history"],
  ].map(
    ([name, role, description]) =>
      html`<div class="cove-demo-account" key=${name}><div><strong>${name}</strong><span class="cove-role">${role}</span></div><small>${description}</small></div>`,
  )}</div><p class="cove-disclaimer">Fictional demonstration data. No real charges or clinical advice. Changes last for this running instance.</p></section>${
    provider &&
    html`<${OAuthModal} provider=${provider} onClose=${() => setProvider(null)} onDone=${(
      user: User,
    ) => {
      setProvider(null)
      onSignedIn(user)
    }}/>`
  }</div>`
}
