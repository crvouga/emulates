import { html } from "htm/preact"
import { can } from "../../app/model.js"
import { api, type User } from "../api.js"
import { Badge, date, Empty, ErrorState, Loading, useResource } from "../components/States.js"
import { navigate } from "../router.js"

export const Dashboard = ({ user }: { user: User }) => {
  const team = can(user.role, "orders.read")
  const { data, error, busy, refresh } = useResource(() => api.orders(team))
  const orders = data?.orders ?? []
  const ready = orders.filter((order) => order.status === "results_ready")
  const active = orders.filter((order) => !["results_ready", "cancelled"].includes(order.status))
  const unreviewed = ready.filter((order) => !order.reviewedAt)
  const showUpdates = user.notifications && unreviewed.length > 0
  return html`<div class="cove-page">
    <div class="cove-page-head"><div><p class="cove-eyebrow">${team ? "Care workspace" : "Personal workspace"}</p><h1>Welcome back${user.name ? `, ${user.name.split(" ")[0]}` : ""}.</h1><p class="cove-lede">${team ? "Keep track of patient orders and reports awaiting your review." : "A clear view of your tests, results, and next steps."}</p></div><button class="cove-btn cove-btn-primary" onClick=${() => navigate("shop")}>+ Order tests</button></div>
    ${error && html`<${ErrorState} error=${error} retry=${refresh}/>`}
    ${
      !data
        ? busy
          ? html`<${Loading}/>`
          : null
        : html`
      <div class="cove-stat-row">${[
        [orders.length, "Total orders"],
        [active.length, "In progress"],
        [ready.length, "Reports available"],
        [unreviewed.length, "Awaiting review"],
      ].map(
        ([value, label]) =>
          html`<div class="cove-stat" key=${label}><span class="cove-stat-label">${label}</span><div class="cove-stat-value">${value}</div></div>`,
      )}</div>
      <div class="cove-dashboard-grid"><section class="cove-card"><div class="cove-section-head"><h2>Recent activity</h2><button class="cove-btn cove-btn-ghost cove-btn-sm" onClick=${() => navigate("orders")}>View orders ↗</button></div>${orders.length ? html`<div class="cove-recent-list">${orders.slice(0, 4).map((order) => html`<button class="cove-recent" key=${order.id} onClick=${() => navigate(order.status === "results_ready" ? "results" : "orders")}><div><strong>${order.items.map((item) => item.testName).join(" + ")}</strong><p>${team ? `${order.patientName} · ` : ""}${date(order.createdAt)}</p></div><${Badge} status=${order.status}/></button>`)}</div>` : html`<${Empty} title="Your history starts here" detail="Once you order a test, you can follow its progress here." action=${() => navigate("shop")} label="Find a test"/>`}</section>
      <aside class="cove-card"><p class="cove-eyebrow">${user.notifications ? "Next steps" : "Quick access"}</p><h2>${showUpdates ? (team ? "Reports need your review" : "New results are available") : active.length ? "An order is in progress" : "Ready for your next test?"}</h2><p class="cove-muted">${showUpdates ? (team ? "Open all patient results to review measurements and record your notes." : "See biomarker values, reference ranges, and your care team’s review.") : active.length ? "Follow your order timeline. This workspace updates as your order progresses." : "Browse individual tests and panels. Review your total before checkout."}</p><button class="cove-btn cove-btn-primary" onClick=${() => navigate(showUpdates ? "results" : active.length ? "orders" : "shop")}>${showUpdates ? "View results" : active.length ? "Track order" : "Browse catalog"} ↗</button></aside></div>
      <section class="cove-card"><h2>How testing works</h2><div class="cove-how-grid">${[
        ["01", "Choose your tests", "Select individual tests or combine panels in one order."],
        [
          "02",
          "Complete collection",
          "Your kit request and laboratory processing appear on the timeline.",
        ],
        [
          "03",
          "Explore your results",
          "Review measurements, see care notes, and download your records.",
        ],
      ].map(
        ([number, title, detail]) =>
          html`<div key=${number}><span class="cove-muted cove-text-sm">${number}</span><h3>${title}</h3><p class="cove-muted cove-text-sm">${detail}</p></div>`,
      )}</div></section>
    `
    }
  </div>`
}
