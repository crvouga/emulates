import { html } from "htm/preact"

export const GoogleButton = ({
  onClick,
  disabled,
}: {
  onClick: () => void
  disabled?: boolean
}) => html`
  <button class="cove-oauth-btn" onClick=${onClick} disabled=${disabled}>Continue with Google</button>
`

export const AppleButton = ({
  onClick,
  disabled,
}: {
  onClick: () => void
  disabled?: boolean
}) => html`
  <button class="cove-oauth-btn" onClick=${onClick} disabled=${disabled}>Continue with Apple</button>
`
