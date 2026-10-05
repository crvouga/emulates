import { html } from "htm/preact"

/**
 * A small icon set: single-weight strokes,
 * `currentColor` so each usage site controls its own tint. Kept as inline
 * SVG (no icon font/image requests) to stay true to this app's "no network
 * call, ever" principle.
 */
const base = (children: unknown) => html`
  <svg
    width="22"
    height="22"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.75"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    ${children}
  </svg>
`

export const IconFlask = () =>
  base(html`
    <path d="M9 2h6" />
    <path d="M10 2v6.2a2 2 0 0 1-.4 1.2L5 16.5A2.5 2.5 0 0 0 7 20.5h10a2.5 2.5 0 0 0 2-4l-4.6-6.6a2 2 0 0 1-.4-1.2V2" />
    <path d="M7.5 15h9" />
  `)

export const IconShield = () =>
  base(html`
    <path d="M12 2.5 5 5.5v6c0 4.7 3 8 7 9.5 4-1.5 7-4.8 7-9.5v-6z" />
    <path d="M9 12.2l2 2 4-4.2" />
  `)

export const IconNote = () =>
  base(html`
    <path d="M6 3h9l3 3v15H6z" />
    <path d="M15 3v3h3" />
    <path d="M9 12h6M9 15.5h6M9 8.5h3" />
  `)

export const IconHeartPulse = () =>
  base(html`
    <path d="M12.8 20.2 12 21l-.8-.8C6.4 16 3 12.9 3 9.2 3 6.6 5 4.6 7.5 4.6c1.5 0 2.9.8 3.7 2 .8-1.2 2.2-2 3.7-2C17.4 4.6 19.4 6.6 19.4 9.2c0 3.7-3.4 6.8-8.6 11z" />
    <path d="M6 10.5h2.2l1.3-2.4 1.8 4.6 1.2-2.2h2.5" />
  `)

export const IconDroplet = () =>
  base(html`
    <path d="M12 3.2s6 6.7 6 11.1a6 6 0 0 1-12 0c0-4.4 6-11.1 6-11.1z" />
  `)

export const IconLeaf = () =>
  base(html`
    <path d="M5 19c8.5 0 14-5 14-14.5C10.5 4.5 5 10 5 18.5z" />
    <path d="M6 18 16 8" />
  `)

export const IconClipboardCheck = () =>
  base(html`
    <rect x="6" y="4" width="12" height="17" rx="2" />
    <path d="M9 4V3a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v1" />
    <path d="M9 12.5l2 2 4-4.4" />
  `)

export const IconHourglass = () =>
  base(html`
    <path d="M6.5 3h11M6.5 21h11" />
    <path d="M7.5 3c0 4 3 5.5 4.5 6.6C10.5 10.7 7.5 12.2 7.5 16.2V21h9v-4.8c0-4-3-5.5-4.5-6.6 1.5-1.1 4.5-2.6 4.5-6.6V3z" />
  `)

export const IconCheckCircle = () =>
  base(html`
    <circle cx="12" cy="12" r="9" />
    <path d="M8.5 12.3l2.3 2.3 4.7-5" />
  `)

export const IconPlus = () =>
  base(html`
    <path d="M12 5v14" />
    <path d="M5 12h14" />
  `)

export const IconGrid = () =>
  base(html`
    <rect x="4" y="4" width="6" height="6" rx="1" />
    <rect x="14" y="4" width="6" height="6" rx="1" />
    <rect x="4" y="14" width="6" height="6" rx="1" />
    <rect x="14" y="14" width="6" height="6" rx="1" />
  `)

export const IconOrders = () =>
  base(html`
    <rect x="5" y="3" width="14" height="18" rx="2" />
    <path d="M9 8h6M9 12h6M9 16h4" />
  `)

export const IconList = () =>
  base(html`
    <path d="M9 6h11M9 12h11M9 18h11" />
    <path d="M4 6h.01M4 12h.01M4 18h.01" />
  `)

export const IconSettings = () =>
  base(html`
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1a1.7 1.7 0 0 0 1.9.3A1.7 1.7 0 0 0 10 3v-.2h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1z" />
  `)
