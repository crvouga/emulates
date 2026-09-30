/**
 * Maintainer health checks. Prints a short list of pages still left to fix.
 *
 *   bun run health
 *   bun run health -- trusted-publisher
 */
import { checks } from "./checks.ts"
import { needsAttention, renderHealth } from "./report.ts"

const args = process.argv.slice(2).filter((arg) => arg !== "--")

if (args.includes("--help") || args.includes("-h")) {
  console.log("bun run health [check…]")
  console.log("")
  for (const check of checks) console.log(`  ${check.id}  ${check.summary}`)
  process.exit(0)
}

const unknown = args.filter((arg) => !checks.some((check) => check.id === arg))
if (unknown.length > 0) {
  console.error(`health: unknown check ${unknown.join(", ")}`)
  console.error(`health: ${checks.map((check) => check.id).join(", ")}`)
  process.exit(1)
}

const selected = args.length === 0 ? checks : checks.filter((check) => args.includes(check.id))
const reports = await Promise.all(selected.map((check) => check.run()))
process.stdout.write(renderHealth(reports))
if (reports.some(needsAttention)) process.exit(1)
