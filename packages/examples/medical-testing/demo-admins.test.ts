import { describe, expect, test } from "bun:test"
import { buildDemo } from "./src/composition/build.js"

describe("live demo admins", () => {
  test("every HTTP mock serves the shared admin UI, and Postgres lists Cove's tables", async () => {
    const demo = await buildDemo({ html: "", js: "" })
    expect(demo.admins.map((admin) => admin.label)).toEqual([
      "Google",
      "Apple",
      "Stripe",
      "Junction",
    ])

    for (const admin of demo.admins) {
      const health = await admin.fetch(new Request("https://mock.local/health"))
      expect(health.status).toBe(200)
      expect(((await health.json()) as { adminUi?: string }).adminUi).toBe("/__admin/ui")
      const ui = await admin.fetch(new Request("https://mock.local/__admin/ui"))
      expect(ui.status).toBe(200)
      expect(ui.headers.get("content-type")).toContain("text/html")
      expect(await ui.text()).toContain("data-mockingbird-admin")
    }

    const tables = await demo.db.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name",
    )
    expect(tables.map((row) => row.table_name)).toEqual([
      "lab_tests",
      "order_items",
      "orders",
      "users",
    ])
    const tests = await demo.db.query("SELECT * FROM lab_tests ORDER BY 1 LIMIT 50")
    expect(tests.length).toBeGreaterThan(0)
  })
})
