import { html } from "htm/preact"
import { IconPlus } from "./Icons.js"

/** Shared, optically centered mark used on both sides of sign-in. */
export const Logo = () =>
  html`<span class="cove-logo-box" aria-hidden="true"><${IconPlus}/></span><span>Lab testing</span>`
