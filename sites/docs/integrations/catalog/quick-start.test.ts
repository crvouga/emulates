import { test } from "bun:test"
import { fileURLToPath } from "node:url"
import { verifyCheckout } from "./quick-start.ts"

test("the Data → API → Client quick start confirms a payment and persists its order", async () => {
  await verifyCheckout(fileURLToPath(new URL("../../../../packages/service/", import.meta.url)))
})
