/**
 * Live parity for one, several, or every published HTTP service, with sandbox credentials from
 * the environment: `.env.local` locally, or GitHub Actions repo secrets in the Parity workflow
 * (`bun run parity:remote`, which runs this script on a GitHub runner).
 *
 * Each service's `parity` script exits 0 on parity, 1 on a divergence, and 2 when its sandbox
 * credentials are missing. This runner reports all three separately, so "no credentials" is never
 * mistaken for "passed".
 *
 *   bun run parity:service -- twilio stripe      # the named services
 *   bun run parity:service -- --all              # every service with a parity script
 *   bun run parity:service -- --tier=warm        # every service declared in that tier
 *
 * Tiers (hot: each PR, warm: scheduled, cold: manual only) are declared per service in
 * package.json; see scripts/parity-tiers.ts.
 */
import { join } from "node:path"
import { parityServices, resolveSelector } from "./parity-tiers.ts"

const root = join(import.meta.dir, "..")

const args = process.argv.slice(2).filter((a) => a !== "--")
let wanted: string[] = []
try {
  wanted = resolveSelector(args)
} catch (error) {
  console.error((error as Error).message)
  process.exit(2)
}
if (args.length > 0 && wanted.length === 0) {
  console.log(`no services match ${args.join(" ")}; nothing to run`)
  process.exit(0)
}
if (wanted.length === 0) {
  console.error(
    `usage: bun run parity:service -- <service…> | --all | --tier=<hot|warm|cold>\nservices: ${parityServices()
      .map((s) => `${s.name} (${s.tier})`)
      .join(", ")}`,
  )
  process.exit(2)
}

const results: { name: string; outcome: "parity" | "diverged" | "no credentials" }[] = []
for (const name of wanted) {
  console.log(`\n── ${name} ─────────────────────────────`)
  const child = Bun.spawn(["bun", "run", "--cwd", `packages/service/${name}`, "parity"], {
    cwd: root,
    stdio: ["inherit", "inherit", "inherit"],
  })
  const code = await child.exited
  results.push({
    name,
    outcome: code === 0 ? "parity" : code === 2 ? "no credentials" : "diverged",
  })
}

console.log("\nlive parity summary")
for (const { name, outcome } of results) console.log(`  ${name.padEnd(18)} ${outcome}`)
process.exit(results.some((r) => r.outcome === "diverged") ? 1 : 0)
