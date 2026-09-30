import { html } from "htm/preact"
import { useState } from "preact/hooks"
import type { OAuthProvider, User } from "../api.js"
import { AppleButton, GoogleButton } from "../components/OAuthButtons.js"
import { OAuthModal } from "../components/OAuthModal.js"

export const Landing = ({ onSignedIn }: { onSignedIn: (user: User) => void }) => {
  const [modalProvider, setModalProvider] = useState<OAuthProvider | null>(null)

  return html`
    <div class="cove-landing">
      <div class="cove-card cove-signin-card">
        <h1>Example app</h1>
        <p class="cove-landing-sub">Sign in, choose a lab test, and check out.</p>
        <div class="cove-signin-box">
          <${GoogleButton} onClick=${() => setModalProvider("google")} />
          <${AppleButton} onClick=${() => setModalProvider("apple")} />
        </div>
      </div>
      ${
        modalProvider &&
        html`<${OAuthModal}
        provider=${modalProvider}
        onClose=${() => setModalProvider(null)}
        onDone=${(user: User) => {
          setModalProvider(null)
          onSignedIn(user)
        }}
      />`
      }
    </div>
  `
}
