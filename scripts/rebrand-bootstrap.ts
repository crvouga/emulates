/**
 * One-time local bootstrap after the Mockingbird → Emulates rename (docs/MIGRATING.md).
 * Idempotent: every step checks first and skips what is already done.
 *
 *   bun run rebrand:bootstrap                       local checkout only
 *   bun run rebrand:bootstrap -- --publish          + first npm publish of @emulates/*
 *   bun run rebrand:bootstrap -- --publish --dry-run
 *
 * Local steps:
 *   1. point `origin` at the renamed GitHub repo,
 *   2. rename `MOCKINGBIRD_*` and `EMULATORS_*` keys in .env.local to `EMULATES_*`
 *      (values are never printed),
 *   3. move the gitignored `.mockingbird/` or `.emulators/` state directory to `.emulates/`,
 *   4. `bun install` so workspace links use the new package names.
 *
 * `--publish` (maintainer, once, after the rename is on origin/main):
 *   5. require the npm org `emulates` (npm cannot create orgs from the CLI),
 *   6. run `bun run release:seed`: publish every @emulates/* package, attach Trusted
 *      Publishing, and deprecate each former @crvouga/mockingbird-* name.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { $ } from "bun"
import { project, repositoryUrl } from "../project.ts"
import { root } from "./release/lib.ts"

const FORMER_ENV_PREFIXES = ["MOCKINGBIRD_", "EMULATORS_"] as const
/** GitHub repo names this checkout may still use as `origin`. */
const FORMER_GITHUB_REPOS = ["mockingbird", "emulators"] as const

/** The origin URL to set, or null when `remote` should stay. `target` includes `.git`. */
export function nextOriginUrl(remote: string, target: string): string | null {
  const repoName = (url: string) => url.match(/[/:]([^/:]+?)(?:\.git)?$/)?.[1]
  const remoteName = repoName(remote)
  const targetName = repoName(target)
  if (!remoteName || !targetName || remoteName === targetName) return null
  if (!remote.includes(`crvouga/${remoteName}`)) return null
  if (!(FORMER_GITHUB_REPOS as readonly string[]).includes(remoteName)) return null
  return target
}
const ENV_PREFIX = `${project.slug.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_`

/**
 * Rename `MOCKINGBIRD_X=` and `EMULATORS_X=` assignments to `EMULATES_X=`. A key whose new
 * name is already assigned is left alone and reported, so an existing value is never overwritten.
 */
export function renameEnvKeys(text: string): { text: string; renamed: string[]; kept: string[] } {
  const assigned = new Set(
    [...text.matchAll(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/gm)].map((m) => m[1]),
  )
  const renamed: string[] = []
  const kept: string[] = []
  let out = text
  for (const former of FORMER_ENV_PREFIXES) {
    out = out.replace(
      new RegExp(`^(\\s*(?:export\\s+)?)${former}([A-Za-z0-9_]+)(\\s*=)`, "gm"),
      (line, lead: string, rest: string, eq: string) => {
        const next = `${ENV_PREFIX}${rest}`
        if (assigned.has(next)) {
          kept.push(`${former}${rest}`)
          return line
        }
        assigned.add(next)
        renamed.push(next)
        return `${lead}${next}${eq}`
      },
    )
  }
  return { text: out, renamed, kept }
}

function step(name: string, result: string): void {
  console.log(`rebrand:bootstrap: ${name} — ${result}`)
}

async function run(cmd: string[]): Promise<number> {
  return Bun.spawn(cmd, { cwd: root, stdio: ["inherit", "inherit", "inherit"] }).exited
}

async function main(): Promise<number> {
  const publish = process.argv.includes("--publish")
  const dryRun = process.argv.includes("--dry-run")

  // 1. git remote.
  const remote = (await $`git remote get-url origin`.cwd(root).quiet().nothrow()).text().trim()
  const target = `${repositoryUrl}.git`
  const next = nextOriginUrl(remote, target)
  if (!remote) step("git remote", "no origin, skipped")
  else if (!next) step("git remote", `ok (${remote})`)
  else {
    await $`git remote set-url origin ${next}`.cwd(root).quiet()
    step("git remote", `origin → ${next}`)
  }

  // 2. .env.local keys.
  const envPath = join(root, ".env.local")
  if (!existsSync(envPath)) step(".env.local", "absent, skipped")
  else {
    const { text, renamed, kept } = renameEnvKeys(readFileSync(envPath, "utf8"))
    if (renamed.length > 0) writeFileSync(envPath, text)
    step(".env.local", renamed.length > 0 ? `renamed ${renamed.join(", ")}` : "ok")
    if (kept.length > 0) {
      console.warn(
        `::warning::.env.local keeps ${kept.join(", ")}: the ${ENV_PREFIX}* key already exists; delete the old line by hand`,
      )
    }
  }

  // 3. local state directory.
  const current = join(root, `.${project.slug}`)
  let movedState = false
  for (const formerName of [".mockingbird", ".emulators"]) {
    const former = join(root, formerName)
    if (!existsSync(former)) continue
    if (existsSync(current)) {
      console.warn(`::warning::both ${formerName}/ and .${project.slug}/ exist; merge them by hand`)
      continue
    }
    renameSync(former, current)
    step("state directory", `${formerName}/ → .${project.slug}/`)
    movedState = true
  }
  if (!movedState) step("state directory", "ok")

  // 4. workspace links.
  if ((await run(["bun", "install"])) !== 0) return 1
  step("bun install", "ok")

  if (!publish) {
    step("npm", "skipped (pass --publish once the rename is merged to main)")
    return 0
  }

  // 5. the rename must be on origin/main: release:seed publishes from there.
  await $`git fetch origin main`.cwd(root).quiet()
  const mainIdentity = await $`git show origin/main:project.ts`.cwd(root).quiet().nothrow()
  if (mainIdentity.exitCode !== 0 || !mainIdentity.text().includes(project.npmScope)) {
    console.error(
      `rebrand:bootstrap: origin/main does not have project.ts with ${project.npmScope} yet; merge the rename first`,
    )
    return 1
  }

  // 6. the npm org. `npm org ls` needs a login, so log in first.
  const org = project.npmScope.slice(1)
  if (!dryRun && (await $`npm whoami`.quiet().nothrow()).exitCode !== 0) {
    if ((await run(["npm", "login"])) !== 0) return 1
  }
  if (!dryRun && (await $`npm org ls ${org}`.quiet().nothrow()).exitCode !== 0) {
    console.error(
      `rebrand:bootstrap: npm org "${org}" is missing or you are not a member. Create it at https://www.npmjs.com/org/create (name: ${org}), then re-run.`,
    )
    return 1
  }
  step("npm org", dryRun ? "not checked (dry run)" : `${org} ok`)

  // 7. publish, trust, deprecate.
  return run(["bun", "run", "release:seed", ...(dryRun ? ["--", "--dry-run"] : [])])
}

if (import.meta.main) process.exitCode = await main()
