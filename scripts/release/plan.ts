/**
 * Print which public packages the next release would publish, and at which versions.
 *
 *   bun run release:plan
 *   bun run release:plan -- --github-output     (also writes has_changes=… to $GITHUB_OUTPUT)
 *   bun run release:plan -- --check-publishable (fail if a new package cannot be created)
 */
import { appendFileSync } from "node:fs"
import { computePlan, npmVersions, REPO } from "./lib.ts"

const plan = await computePlan()

if (plan.releases.length === 0) {
  console.log("release:plan: nothing to release")
} else {
  console.log(`release:plan: ${plan.releases.length} package(s) to release`)
  for (const r of plan.releases) {
    const why =
      r.bump === "initial"
        ? "initial release"
        : [
            r.commits.length > 0 ? `${r.commits.length} commit(s)` : null,
            r.dependencyUpdates.length > 0 ? `deps: ${r.dependencyUpdates.join(", ")}` : null,
          ]
            .filter(Boolean)
            .join("; ")
    const label = r.bump === "initial" ? why : `${r.bump}; ${why}`
    console.log(`  ${r.pkg.name}: ${r.previous ?? "—"} → ${r.version} (${label})`)
  }
}

if (process.argv.includes("--github-output") && process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, `has_changes=${plan.releases.length > 0}\n`)
}

if (process.argv.includes("--check-publishable")) {
  const unpublished: string[] = []
  let registryFailed = false
  for (const release of plan.releases) {
    if (release.bump !== "initial") continue
    const published = await npmVersions(release.pkg.name)
    if (!Array.isArray(published)) {
      console.error(`release:plan: npm view ${release.pkg.name}: ${published.error}`)
      registryFailed = true
      process.exitCode = 1
      continue
    }
    if (published.length === 0) unpublished.push(release.pkg.name)
  }

  if (unpublished.length > 0 && process.env.NPM_TOKEN_PRESENT !== "true") {
    console.error(
      `release:plan: ${unpublished.length} unpublished package(s) need the NPM_TOKEN repo secret: ${unpublished.join(", ")}`,
    )
    console.error(
      `Run \`bun run release:bootstrap\` to store it on ${REPO}, then re-run this check before merging.`,
    )
    process.exitCode = 1
  } else if (!registryFailed) {
    console.log("release:plan: every planned release is publishable")
  }
}
