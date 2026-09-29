/**
 * How the pull-request gate (.github/workflows/pr.yml) splits `bun run check` across runners, and
 * which of those runners a change needs.
 *
 * `bun run check` stays the one definition of the gate. Its tasks are split two ways:
 *   static  — `lint` plus every root task (`//#…` in turbo.json): no build, a few seconds.
 *   shard   — every other task (build, typecheck, test, pack:check, …), with the workspace
 *             packages dealt round-robin into SHARDS parallel runners. Upstream builds a shard
 *             needs come along through turbo's `dependsOn`.
 * Together they are exactly the `check` script's task list; `changes` fails if they drift.
 *
 * Turbo's content hashes are the fine-grained filter: an unchanged package replays from cache.
 * `changes` is the coarse one: it skips a whole job only when every changed file is on a list of
 * paths that job provably does not read. Anything unlisted runs everything.
 *
 *   bun scripts/ci-plan.ts changes --base origin/main   # what a PR against main would run
 *   bun scripts/ci-plan.ts changes --all                # push to main: everything
 *   bun scripts/ci-plan.ts static                       # the static job
 *   bun scripts/ci-plan.ts shard 2/4                    # one shard job
 *   bun scripts/ci-plan.ts smoke-key                    # fingerprint of what the smoke installs
 *
 * Extra arguments to `static` and `shard` go to turbo (e.g. `--output-logs=errors-only`).
 */
import { appendFileSync, existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { $ } from "bun"
import { discoverPackages } from "./release/lib.ts"

const root = join(import.meta.dir, "..")

/** Parallel shard runners. .github/actions/setup restores one turbo cache per shard. */
const SHARDS = 4

/**
 * Paths no shard task reads: not a package input, not a turbo global dependency, not a build
 * script. A change made only of these skips the shards (and the consumer smoke).
 */
const SHARD_IRRELEVANT = [
  "AGENTS.md",
  "CLAUDE.md",
  "README.md",
  "LICENSE",
  "commitlint.config.js",
  "secrets.manifest.yaml",
  ".husky/**",
  ".agents/**",
  ".claude/**",
  ".cursor/**",
  ".opencode/**",
  ".windsurf/**",
  ".superset/**",
  ".super.engineering/**",
  ".github/prompts/**",
  ".github/ISSUE_TEMPLATE/**",
  ".github/labels.json",
  ".github/pull_request_template.md",
  // Workflows other than pr.yml do not change what the pull-request gate runs.
  ".github/workflows/{advisory,cache-cleanup,ci,issue-labels,parity,publish,verify}.yml",
  "scripts/worktree/**",
  "scripts/secrets/**",
  "scripts/{agent-commands,ci-local,parity-remote,parity-service,pr-ready}.ts",
]

/**
 * Paths the consumer smoke does not read, on top of SHARD_IRRELEVANT: it packs the public
 * packages' tarballs (dist, README, package.json), which hold no tests, docs site or guides.
 */
const SMOKE_IRRELEVANT = [...SHARD_IRRELEVANT, "sites/**", "docs/**", "llms.txt", "**/*.test.ts"]

/** Files under a service that cannot change what its live parity run observes. */
const PARITY_IRRELEVANT = ["**/*.md", "**/*.test.ts", "**/tests/**", "**/test/**"]

const matcher = (patterns: string[]) => {
  const globs = patterns.map((p) => new Bun.Glob(p))
  return (file: string) => globs.some((g) => g.match(file))
}

function checkTasks(): { static: string[]; shard: string[] } {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    scripts: Record<string, string>
  }
  const match = /^turbo run ((?:[\w:-]+ ?)+)$/.exec(pkg.scripts.check ?? "")
  if (!match?.[1]) throw new Error(`package.json "check" is not \`turbo run <tasks…>\``)
  const tasks = match[1].trim().split(/\s+/)

  const turbo = JSON.parse(readFileSync(join(root, "turbo.json"), "utf8")) as {
    tasks: Record<string, unknown>
  }
  const isRoot = (task: string) => `//#${task}` in turbo.tasks
  const split = {
    static: tasks.filter((t) => t === "lint" || isRoot(t)),
    shard: tasks.filter((t) => t !== "lint" && !isRoot(t)),
  }
  if (split.shard.length === 0) throw new Error("no per-package tasks in `check`")
  return split
}

/** Services whose `<SERVICE>_*` sandbox secrets parity.yml maps into the run. */
function liveParityServices(): string[] {
  const workflow = readFileSync(join(root, ".github/workflows/parity.yml"), "utf8")
  const secrets = [...workflow.matchAll(/secrets\.([A-Z0-9_]+)/g)].map((m) => m[1] as string)
  return readdirSync(join(root, "packages/service")).filter((name) => {
    const prefix = `${name.toUpperCase().replaceAll("-", "_")}_`
    return secrets.some((s) => s.startsWith(prefix))
  })
}

/** Every shard must have a turbo cache the setup action restores, or it always runs cold. */
function assertSetupRestoresEveryShard(): void {
  const action = readFileSync(join(root, ".github/actions/setup/action.yml"), "utf8")
  for (let i = 1; i <= SHARDS; i++) {
    if (!action.includes(`-shard-${i}-`)) {
      throw new Error(`.github/actions/setup/action.yml does not restore shard ${i}'s turbo cache`)
    }
  }
}

async function changedFiles(base: string): Promise<string[] | null> {
  const range = base === "HEAD^1" ? ["HEAD^1", "HEAD"] : [`${base}...HEAD`]
  const out = await $`git diff --name-only --no-renames ${range}`.cwd(root).nothrow().quiet()
  if (out.exitCode !== 0) return null
  return out.text().split("\n").filter(Boolean)
}

async function changes(args: string[]): Promise<void> {
  checkTasks()
  assertSetupRestoresEveryShard()

  const baseAt = args.indexOf("--base")
  const base = baseAt >= 0 ? args[baseAt + 1] : undefined
  const files = args.includes("--all") || !base ? null : await changedFiles(base)
  if (base && files === null) console.warn(`ci-plan: cannot diff against ${base}; running all`)

  const shardSkippable = matcher(SHARD_IRRELEVANT)
  const smokeSkippable = matcher(SMOKE_IRRELEVANT)
  const parityIgnored = matcher(PARITY_IRRELEVANT)
  const live = liveParityServices()

  const shards = files === null || !files.every(shardSkippable)
  const smoke = files === null || !files.every(smokeSkippable)
  const parity =
    files === null
      ? []
      : live.filter((name) =>
          files.some((f) => f.startsWith(`packages/service/${name}/`) && !parityIgnored(f)),
        )

  const outputs = {
    shards: String(shards),
    smoke: String(smoke),
    matrix: JSON.stringify(Array.from({ length: SHARDS }, (_, i) => i + 1)),
    parity: parity.join(" "),
  }
  const scope = files === null ? "everything" : `${files.length} changed file(s) vs ${base}`
  const summary = [
    `### CI plan (${scope})`,
    "",
    "| Job | Runs |",
    "| --- | --- |",
    "| Commitlint, Static | always |",
    `| Shards 1–${SHARDS} (build, typecheck, test, pack, portability) | ${shards ? "yes" : "no: nothing they read changed"} |`,
    `| Consumer smoke | ${smoke ? "yes" : "no: no published package changed"} |`,
    `| Live parity (advisory) | ${parity.length > 0 ? parity.join(", ") : "none"} |`,
    "",
  ].join("\n")

  console.log(summary)
  console.log(JSON.stringify(outputs))
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      Object.entries(outputs)
        .map(([k, v]) => `${k}=${v}\n`)
        .join(""),
    )
  }
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary)
}

async function turbo(args: string[]): Promise<never> {
  console.log(`$ turbo ${args.join(" ")}`)
  const proc = Bun.spawn(["bunx", "turbo", ...args], {
    cwd: root,
    stdio: ["inherit", "inherit", "inherit"],
  })
  process.exit(await proc.exited)
}

async function shard(spec: string | undefined, extra: string[]): Promise<never> {
  const [index, total] = (spec ?? "").split("/").map(Number)
  if (!index || !total || index < 1 || index > total) {
    throw new Error(`usage: bun scripts/ci-plan.ts shard <i>/<n>  (got ${spec})`)
  }
  const listed = JSON.parse(await $`bunx turbo ls --output=json`.cwd(root).quiet().text()) as {
    packages: { items: { name: string; path: string }[] }
  }
  // Round-robin by path: packages cost within a few× of each other, so even counts balance, and
  // each shard restores every shard's cache, so reshuffling on a new package costs no misses.
  const mine = listed.packages.items
    .sort((a, b) => a.path.localeCompare(b.path))
    .filter((_, k) => k % total === index - 1)
  console.log(
    `shard ${index}/${total}: ${mine.length} packages\n  ${mine.map((p) => p.path).join("\n  ")}`,
  )
  return turbo(["run", ...checkTasks().shard, ...mine.map((p) => `--filter=${p.name}`), ...extra])
}

/** Files besides the tarballs whose change can change the consumer smoke's verdict. */
const SMOKE_INPUTS = ["scripts/release/consumer-smoke.ts", "scripts/release/lib.ts"]

/**
 * A fingerprint of everything the consumer smoke installs: each public package's manifest and the
 * `files` it packs (built `dist` included, so run it after the build), plus the smoke script. The
 * smoke job skips when a run with the same fingerprint already passed.
 */
function smokeKey(): void {
  const hasher = new Bun.CryptoHasher("sha256")
  const add = (rel: string) => {
    hasher.update(`${rel}\0`)
    hasher.update(readFileSync(join(root, rel)))
    hasher.update("\0")
  }
  hasher.update(`bun ${Bun.version}\0`)
  for (const rel of SMOKE_INPUTS) add(rel)
  const pkgs = discoverPackages()
    .filter((p) => p.isPublic)
    .sort((a, b) => a.relDir.localeCompare(b.relDir))
  for (const pkg of pkgs) {
    const manifest = JSON.parse(readFileSync(pkg.manifestPath, "utf8")) as { files?: string[] }
    const files = new Set([join(pkg.relDir, "package.json")])
    for (const entry of manifest.files ?? []) {
      const rel = join(pkg.relDir, entry)
      const abs = join(root, rel)
      if (!existsSync(abs)) continue
      if (!statSync(abs).isDirectory()) files.add(rel)
      else for (const f of new Bun.Glob("**/*").scanSync({ cwd: abs })) files.add(join(rel, f))
    }
    for (const rel of [...files].sort()) add(rel)
  }
  console.log(hasher.digest("hex"))
}

const [command, ...rest] = process.argv.slice(2).filter((a) => a !== "--")
switch (command) {
  case "changes":
    await changes(rest)
    break
  case "static":
    await turbo(["run", ...checkTasks().static, ...rest])
    break
  case "shard":
    await shard(rest[0], rest.slice(1))
    break
  case "smoke-key":
    smokeKey()
    break
  default:
    console.error(
      "usage: bun scripts/ci-plan.ts changes [--base <ref> | --all] | static | shard <i>/<n> | smoke-key",
    )
    process.exit(2)
}
