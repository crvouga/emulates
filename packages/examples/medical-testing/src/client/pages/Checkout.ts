import { html } from "htm/preact"
import { useState } from "preact/hooks"
import { CheckoutModal } from "../components/CheckoutModal.js"
import { navigate } from "../router.js"

export const Checkout = ({
  checkoutSessionId,
  onPaid,
}: {
  checkoutSessionId: string | null
  onPaid: () => void
}) => {
  const [open, setOpen] = useState(true)

  if (!checkoutSessionId) {
    return html`
      <div class="cove-card">
        <p>No order in progress.</p>
        <button class="cove-btn cove-btn-primary" onClick=${() => navigate("shop")}>Back to shop</button>
      </div>
    `
  }

  if (!open) {
    return html`
      <div class="cove-card">
        <p>Checkout closed.</p>
        <button class="cove-btn cove-btn-primary" onClick=${() => navigate("shop")}>Back to shop</button>
      </div>
    `
  }

  return html`
    <${CheckoutModal}
      checkoutSessionId=${checkoutSessionId}
      onDone=${onPaid}
      onClose=${() => {
        setOpen(false)
        navigate("shop")
      }}
    />
  `
}
