/**
 * Which agent-reported issues the Resolve issues workflow (.github/workflows/resolve-issues.yml)
 * dispatches an agent to, one `/resolve-issues <n>` run per issue.
 *
 *   bun run resolve-issues:remote -- [<n>…]        dispatch the workflow on main (needs `gh`)
 *   bun scripts/resolve-issues.ts pick [<n>…] [--max=<k>]
 *
 * `pick` is the workflow's plan step. Named issues are taken as long as they are open (a
 * `new-service` issue only runs when named, as in /resolve-issues). With none, it takes up to `max`
 * of the queue: the oldest open `agent-reported` issues in the order parity, bug, feature, that
 * nobody has claimed (no assignee), that wait on nobody (no `needs-info` or `needs-oracle-check`)
 * and that no open PR already closes. It prints the numbers and writes `issues=<JSON array>` to
 * $GITHUB_OUTPUT.
 */
import { appendFileSync } from "node:fs"
import { $ } from "bun"

const WORKFLOW = "resolve-issues.yml"

/** Queue order: /resolve-issues takes parity first, then bug, then feature. */
export const QUEUE_KINDS = ["parity", "bug", "feature"] as const

/** Labels that mean the issue waits on someone else. */
export const WAITING_LABELS = ["needs-info", "needs-oracle-check"] as const

export const DEFAULT_MAX = 3

export interface Issue {
  number: number
  createdAt: string
  labels: { name: string }[]
  assignees: { login: string }[]
  closedByPullRequestsReferences: { number: number }[]
}

const labelled = (issue: Issue, name: string) => issue.labels.some((l) => l.name === name)

/** The queue, in the order agents take it, at most `max` long. */
export function pickFromQueue(open: Issue[], max: number): number[] {
  const rank = (issue: Issue) => QUEUE_KINDS.findIndex((kind) => labelled(issue, kind))
  return open
    .filter((issue) => labelled(issue, "agent-reported"))
    .filter((issue) => rank(issue) !== -1)
    .filter((issue) => issue.assignees.length === 0)
    .filter((issue) => !WAITING_LABELS.some((name) => labelled(issue, name)))
    .filter((issue) => issue.closedByPullRequestsReferences.length === 0)
    .sort((a, b) => rank(a) - rank(b) || Date.parse(a.createdAt) - Date.parse(b.createdAt))
    .slice(0, max)
    .map((issue) => issue.number)
}

/** `["42", "#7", "42"]` → `[42, 7]`; anything that is not an issue number throws. */
export function parseIssueNumbers(args: string[]): number[] {
  const numbers = args.map((arg) => {
    const n = Number(arg.replace(/^#/, ""))
    if (!Number.isInteger(n) || n <= 0) throw new Error(`not an issue number: ${arg}`)
    return n
  })
  return [...new Set(numbers)]
}

const fail = (message: string, code = 1): never => {
  console.error(`resolve-issues: ${message}`)
  process.exit(code)
}

const USAGE = "usage: bun scripts/resolve-issues.ts pick [<n>…] [--max=<k>] | dispatch [<n>…]"

async function pick(args: string[]) {
  const maxArg = args.find((a) => a.startsWith("--max="))
  const max = maxArg ? Number(maxArg.slice("--max=".length)) : DEFAULT_MAX
  if (!Number.isInteger(max) || max <= 0) fail(`--max must be a positive integer: ${maxArg}`, 2)
  const named = parseIssueNumbers(args.filter((a) => !a.startsWith("--")))

  let issues: number[]
  if (named.length > 0) {
    issues = []
    for (const n of named) {
      const view = await $`gh issue view ${n} --json state`.quiet().nothrow()
      if (view.exitCode !== 0) fail(`issue #${n} not found`)
      const { state } = JSON.parse(view.stdout.toString()) as { state: string }
      if (state === "OPEN") issues.push(n)
      else console.error(`resolve-issues: skipping #${n}: it is ${state.toLowerCase()}`)
    }
  } else {
    const fields = "number,createdAt,labels,assignees,closedByPullRequestsReferences"
    const listed =
      await $`gh issue list --label agent-reported --state open --limit 500 --json ${fields}`
        .quiet()
        .nothrow()
    if (listed.exitCode !== 0) fail(`gh issue list failed: ${listed.stderr.toString().trim()}`)
    issues = pickFromQueue(JSON.parse(listed.stdout.toString()) as Issue[], max)
  }

  console.log(issues.length > 0 ? issues.map((n) => `#${n}`).join(" ") : "nothing to resolve")
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `issues=${JSON.stringify(issues)}\n`)
  }
}

async function dispatch(args: string[]) {
  const issues = parseIssueNumbers(args)
  const repo = (
    await $`gh repo view --json nameWithOwner --jq .nameWithOwner`.quiet().nothrow()
  ).stdout
    .toString()
    .trim()
  if (!repo) fail("gh is not authenticated or this is not a GitHub checkout. Run: gh auth login")
  const run =
    await $`gh workflow run ${WORKFLOW} --repo ${repo} --ref main -f ${`issues=${issues.join(" ")}`}`
      .quiet()
      .nothrow()
  if (run.exitCode !== 0) fail(`could not dispatch ${WORKFLOW} (needs write access to ${repo})`)
  console.log(
    `Dispatched ${WORKFLOW} on ${repo} for ${issues.length > 0 ? issues.map((n) => `#${n}`).join(" ") : "the queue"}`,
  )
  console.log(`https://github.com/${repo}/actions/workflows/${WORKFLOW}`)
}

if (import.meta.main) {
  const [command, ...rest] = process.argv.slice(2).filter((a) => a !== "--")
  try {
    if (command === "pick") await pick(rest)
    else if (command === "dispatch") await dispatch(rest)
    else fail(USAGE, 2)
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error), 2)
  }
}
