/**
 * Worktree lifecycle scripts live once in `scripts/worktree/` and every orchestrator's project
 * config is generated from `LIFECYCLE` below, so Superset, super.engineering (and any host added
 * to `HOSTS`) run the same setup, run and teardown. Edit the scripts or this file; never the
 * generated configs.
 *
 *   bun run worktree:sync     write every host's config
 *   bun run check:worktree    fail if any host's config is missing or stale (CI)
 *
 * Adding a host: append an entry to `HOSTS` that renders `LIFECYCLE` into the file it reads.
 */
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { isDeepStrictEqual } from "node:util"

const root = join(import.meta.dir, "../..")

/** One command per phase, run from the worktree root. */
const LIFECYCLE = {
  /** Worktree created: copy local files from the main checkout, reserve a port, `bun run setup`. */
  setup: "./scripts/worktree/setup.sh",
  /** Run action: serve the docs site on the reserved port. */
  run: { name: "docs", command: "./scripts/worktree/run.sh" },
  /** Worktree deleted: stop the dev server, release the port. */
  teardown: "./scripts/worktree/teardown.sh",
} as const

type Lifecycle = typeof LIFECYCLE

/** Where each orchestrator reads project lifecycle scripts, and in what shape. */
const HOSTS: Array<{ host: string; path: string; render: (l: Lifecycle) => object }> = [
  // https://docs.superset.sh/setup-teardown-scripts
  {
    host: "Superset",
    path: ".superset/config.json",
    render: (l) => ({ setup: [l.setup], teardown: [l.teardown], run: [l.run.command] }),
  },
  // https://super.engineering/docs/project-config-and-scripts/
  {
    host: "super.engineering",
    path: ".super.engineering/config.json",
    render: (l) => ({
      setup: [l.setup],
      run: [{ name: l.run.name, commands: [l.run.command], default: true }],
      teardown: [l.teardown],
    }),
  },
]

const check = process.argv.includes("--check")
const problems: string[] = []
const written: string[] = []

for (const { host, path, render } of HOSTS) {
  const file = join(root, path)
  const want = render(LIFECYCLE)
  // Compare parsed JSON: the formatter owns the layout.
  const have = existsSync(file) ? parse(file) : undefined
  if (isDeepStrictEqual(have, want)) continue
  if (check) {
    problems.push(`${path} (${host}) is ${have === undefined ? "missing" : "stale"}`)
    continue
  }
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(want, null, 2)}\n`)
  written.push(path)
}

for (const phase of [LIFECYCLE.setup, LIFECYCLE.run.command, LIFECYCLE.teardown]) {
  if (!existsSync(join(root, phase))) problems.push(`${phase} does not exist`)
}

function parse(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8"))
  } catch {
    return null
  }
}

if (written.length > 0) {
  spawnSync("bunx", ["biome", "format", "--write", ...written], { cwd: root, stdio: "inherit" })
}

if (problems.length > 0) {
  for (const p of problems) console.error(`::error::${p}`)
  console.error("\nRun: bun run worktree:sync")
  process.exit(1)
}
console.log(
  `worktree: setup/run/teardown in sync across ${HOSTS.length} hosts (${HOSTS.map((h) => h.host).join(", ")})${written.length ? ` (${written.length} config(s) written)` : ""}`,
)
