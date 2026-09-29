/**
 * `bun github:resolve-issues [<n>…]`: resolve agent-reported issues on GitHub Actions with Claude
 * Code agents, as you. The agents use your GitHub token and your Claude subscription token, so
 * commits and PRs are yours and the repo holds no secret for them.
 *
 *   bun github:resolve-issues                  the queue: up to 3 issues (--max=<k>)
 *   bun github:resolve-issues 190 191          these issues (a new-service issue runs only when named)
 *     --model=<id>     Claude model for the agents (default claude-opus-5-5)
 *     --ref=<branch>   branch whose workflow runs (default main); the agents always branch from main
 *     --dry-run        hand the credentials over and check them, then stop (no agent, no PR)
 *
 * The queue is /resolve-issues' order: the oldest open `agent-reported` issues, parity first, then
 * bug, then feature, that nobody has claimed (no assignee), that wait on nobody (no `needs-info` or
 * `needs-oracle-check`) and that no open PR already closes.
 *
 * Credentials, from your environment (.env.local is loaded by Bun):
 *   CLAUDE_CODE_OAUTH_TOKEN      your Claude subscription token (`claude setup-token`). Required.
 *                                Subscription only: an API key is never used.
 *   RESOLVE_ISSUES_GITHUB_TOKEN  optional fine-grained token for the agents; otherwise `gh auth token`.
 *
 * The repo is public and workflow_dispatch inputs are neither masked nor secret, so credentials
 * never travel as inputs. Instead:
 *   1. This command creates a secret gist and dispatches the workflow with the gist's id.
 *   2. Each job generates an RSA key pair and uploads only the public key, as an artifact.
 *   3. This command encrypts the credentials to that key (RSA-OAEP wrapping AES-GCM, bound to the
 *      run and the issue) and adds the ciphertext to the gist.
 *   4. The job decrypts them, masks them, and deletes its private key. When every job has its
 *      credentials, this command deletes the gist.
 * A re-run job has a new key and no one to answer it, so it fails and says to dispatch again.
 *
 * The workflow (.github/workflows/resolve-issues.yml) calls the runner side:
 *   bun scripts/resolve-issues.ts keygen <dir>    write <dir>/public.key and <dir>/private.key
 *   bun scripts/resolve-issues.ts receive <dir>   wait for this job's ciphertext, decrypt it, mask
 *                                                 it, export GH_TOKEN and CLAUDE_CODE_OAUTH_TOKEN
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { $ } from "bun"

const WORKFLOW = "resolve-issues.yml"
const DEFAULT_MODEL = "claude-opus-5-5"
/** How long a job waits for its credentials, and this command for every job's public key. */
const HANDSHAKE_TIMEOUT_MS = 15 * 60_000
const POLL_MS = 5_000

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

// --- Credential handover ------------------------------------------------------------------------

export interface Credentials {
  githubToken: string
  claudeCodeOAuthToken: string
}

export interface Sealed {
  v: 1
  /** The AES key, encrypted to the job's RSA public key. */
  key: string
  iv: string
  data: string
}

const RSA = { name: "RSA-OAEP", hash: "SHA-256" } as const
const encode = (text: string) => new TextEncoder().encode(text)
const toBase64 = (bytes: ArrayBuffer | Uint8Array) =>
  Buffer.from(bytes as ArrayBuffer).toString("base64")
const fromBase64 = (text: string) => Uint8Array.from(Buffer.from(text, "base64"))

/** What a ciphertext is bound to, so it opens only in the job it was sealed for. */
export const handoverContext = (repo: string, runId: string, issue: number) =>
  `${repo}/actions/runs/${runId}#${issue}`

/** A fresh RSA-OAEP key pair, both halves base64 (SPKI and PKCS #8). */
export async function generateKeyPair(): Promise<{ publicKey: string; privateKey: string }> {
  const pair = await crypto.subtle.generateKey(
    { ...RSA, modulusLength: 3072, publicExponent: new Uint8Array([1, 0, 1]) },
    true,
    ["encrypt", "decrypt"],
  )
  return {
    publicKey: toBase64(await crypto.subtle.exportKey("spki", pair.publicKey)),
    privateKey: toBase64(await crypto.subtle.exportKey("pkcs8", pair.privateKey)),
  }
}

export async function seal(
  credentials: Credentials,
  publicKey: string,
  context: string,
): Promise<Sealed> {
  const rsa = await crypto.subtle.importKey("spki", fromBase64(publicKey), RSA, false, ["encrypt"])
  const aes = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt"])
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const data = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: encode(context) },
    aes,
    encode(JSON.stringify(credentials)),
  )
  const key = await crypto.subtle.encrypt(RSA, rsa, await crypto.subtle.exportKey("raw", aes))
  return { v: 1, key: toBase64(key), iv: toBase64(iv), data: toBase64(data) }
}

/** A token is one line of printable ASCII: anything else could inject into $GITHUB_ENV. */
const isToken = (value: unknown): value is string =>
  typeof value === "string" && /^[\x21-\x7e]{8,4096}$/.test(value)

export async function open(
  sealed: Sealed,
  privateKey: string,
  context: string,
): Promise<Credentials> {
  if (sealed.v !== 1) throw new Error(`unknown handover version: ${sealed.v}`)
  const rsa = await crypto.subtle.importKey("pkcs8", fromBase64(privateKey), RSA, false, [
    "decrypt",
  ])
  const raw = await crypto.subtle.decrypt(RSA, rsa, fromBase64(sealed.key))
  const aes = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["decrypt"])
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64(sealed.iv), additionalData: encode(context) },
    aes,
    fromBase64(sealed.data),
  )
  const credentials = JSON.parse(new TextDecoder().decode(plain)) as Credentials
  if (!isToken(credentials.githubToken) || !isToken(credentials.claudeCodeOAuthToken)) {
    throw new Error("the handed-over credentials are not well-formed tokens")
  }
  return credentials
}

// --- Commands -----------------------------------------------------------------------------------

const fail = (message: string, code = 1): never => {
  console.error(`resolve-issues: ${message}`)
  process.exit(code)
}

/** A bad command line: exit 2. Anything else thrown exits 1. */
class UsageError extends Error {}

const sh = async (strings: TemplateStringsArray, ...values: unknown[]) => {
  const result = await $(strings, ...values)
    .quiet()
    .nothrow()
  return {
    ok: result.exitCode === 0,
    out: result.stdout.toString().trim(),
    err: result.stderr.toString().trim(),
  }
}

/** `gh api` with a JSON body; the parsed response, or an error naming the call. */
async function ghApi(path: string, method: string, body: unknown): Promise<unknown> {
  const input = Buffer.from(JSON.stringify(body))
  const result = await $`gh api ${path} --method ${method} --input - < ${input}`.quiet().nothrow()
  if (result.exitCode !== 0) {
    throw new Error(`gh api ${method} ${path} failed: ${result.stderr.toString().trim()}`)
  }
  return JSON.parse(result.stdout.toString() || "null")
}

const USAGE =
  "usage: bun github:resolve-issues [<issue>…] [--max=<k>] [--model=<id>] [--ref=<branch>] [--dry-run]"

const flag = (args: string[], name: string) =>
  args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3)

/** Named issues that are open, or the queue. */
async function selectIssues(repo: string, named: number[], max: number): Promise<number[]> {
  if (named.length > 0) {
    const open: number[] = []
    for (const n of named) {
      const view = await sh`gh issue view ${n} --repo ${repo} --json state`
      if (!view.ok) fail(`issue #${n} not found`)
      const { state } = JSON.parse(view.out) as { state: string }
      if (state === "OPEN") open.push(n)
      else console.error(`resolve-issues: skipping #${n}: it is ${state.toLowerCase()}`)
    }
    return open
  }
  const fields = "number,createdAt,labels,assignees,closedByPullRequestsReferences"
  const listed =
    await sh`gh issue list --repo ${repo} --label agent-reported --state open --limit 500 --json ${fields}`
  if (!listed.ok) fail(`gh issue list failed: ${listed.err}`)
  return pickFromQueue(JSON.parse(listed.out) as Issue[], max)
}

async function dispatch(args: string[]) {
  const maxArg = flag(args, "max")
  const max = maxArg === undefined ? DEFAULT_MAX : Number(maxArg)
  if (!Number.isInteger(max) || max <= 0) {
    throw new UsageError(`--max must be a positive integer: ${maxArg}`)
  }
  const model = flag(args, "model") ?? DEFAULT_MODEL
  const ref = flag(args, "ref") ?? "main"
  const dryRun = args.includes("--dry-run")
  const unknown = args.filter(
    (a) => a.startsWith("--") && !/^--(max|model|ref)=|^--dry-run$/.test(a),
  )
  if (unknown.length > 0) throw new UsageError(`unknown option ${unknown.join(" ")}\n${USAGE}`)
  let named: number[]
  try {
    named = parseIssueNumbers(args.filter((a) => !a.startsWith("--")))
  } catch (error) {
    throw new UsageError((error as Error).message)
  }

  // Credentials first: fail before anything is created on GitHub. Never print their values.
  if (!(await sh`gh auth status`).ok) fail("gh is not authenticated. Run: gh auth login")
  const claudeCodeOAuthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim() ?? ""
  if (!claudeCodeOAuthToken) {
    fail(
      "CLAUDE_CODE_OAUTH_TOKEN is not set. Run `claude setup-token` and put the token in .env.local as CLAUDE_CODE_OAUTH_TOKEN=… (gitignored; never commit it). An API key is not accepted.",
    )
  }
  const githubToken =
    process.env.RESOLVE_ISSUES_GITHUB_TOKEN?.trim() || (await sh`gh auth token`).out
  if (!isToken(githubToken)) fail("no GitHub token: run gh auth login")
  if (!isToken(claudeCodeOAuthToken)) fail("CLAUDE_CODE_OAUTH_TOKEN does not look like a token")
  const credentials: Credentials = { githubToken, claudeCodeOAuthToken }

  const repo = (await sh`gh repo view --json nameWithOwner --jq .nameWithOwner`).out
  if (!repo) fail("not a GitHub checkout")
  const agent = (await sh`gh api user --jq .login`.then((r) => r.out)) || "you"

  const issues = await selectIssues(repo, named, max)
  if (issues.length === 0) {
    console.log("Nothing to resolve.")
    return
  }
  const list = issues.map((n) => `#${n}`).join(" ")

  const gist = (await ghApi("gists", "POST", {
    description: `Encrypted credential handover for a ${repo} Resolve issues run; deleted when the run has them.`,
    public: false,
    files: { "README.md": { content: "Encrypted, one-time credential handover.\n" } },
  })) as { id: string }

  // Ctrl-C skips `finally`; the gist holds only ciphertext, but it should not outlive the run.
  const deleteGist = () => sh`gh api gists/${gist.id} --method DELETE`
  process.once("SIGINT", () => void deleteGist().finally(() => process.exit(130)))

  let runId = ""
  try {
    const dispatchedAt = Date.now()
    const run =
      await sh`gh workflow run ${WORKFLOW} --repo ${repo} --ref ${ref} -f ${`issues=${issues.join(" ")}`} -f ${`handshake=${gist.id}`} -f ${`model=${model}`} -f ${`dry_run=${dryRun}`}`
    if (!run.ok) throw new Error(`could not dispatch ${WORKFLOW} on ${ref}: ${run.err}`)

    // The run's title carries the gist id, so this finds our run even beside a teammate's.
    for (let attempt = 0; attempt < 30 && !runId; attempt++) {
      await Bun.sleep(2000)
      const listed =
        await sh`gh run list --repo ${repo} --workflow ${WORKFLOW} --event workflow_dispatch --limit 20 --json databaseId,displayTitle,createdAt`
      if (!listed.ok) continue
      const runs = JSON.parse(listed.out) as {
        databaseId: number
        displayTitle: string
        createdAt: string
      }[]
      const ours = runs.find(
        (r) => r.displayTitle.includes(gist.id) && Date.parse(r.createdAt) >= dispatchedAt - 60_000,
      )
      if (ours) runId = String(ours.databaseId)
    }
    if (!runId) {
      throw new Error(
        `the run did not appear; see https://github.com/${repo}/actions/workflows/${WORKFLOW}`,
      )
    }
    const url = `https://github.com/${repo}/actions/runs/${runId}`
    console.log(`${dryRun ? "Dry run" : "Resolving"} ${list} as ${agent} on ${ref} (${model})`)
    console.log(url)

    await handOver(repo, runId, gist.id, issues, credentials)
    console.log(`Every job has its credentials; the handover gist is deleted.`)
    console.log(`Follow it: gh run watch ${runId} --repo ${repo}`)
  } finally {
    await deleteGist()
  }
}

type Job = { name: string; status: string; steps?: { name: string; status: string }[] }

/** Serve each job's public key with sealed credentials, then wait until every job has read them. */
async function handOver(
  repo: string,
  runId: string,
  gistId: string,
  issues: number[],
  credentials: Credentials,
) {
  const waiting = new Set(issues)
  const received = (jobs: Job[], issue: number) =>
    jobs.some(
      (job) =>
        job.name === `#${issue}` &&
        (job.status === "completed" ||
          job.steps?.some((s) => s.name === "Receive credentials" && s.status === "completed")),
    )
  const deadline = Date.now() + HANDSHAKE_TIMEOUT_MS
  const dir = mkdtempSync(join(tmpdir(), "resolve-issues-"))
  try {
    while (Date.now() < deadline) {
      const artifacts =
        await sh`gh api ${`repos/${repo}/actions/runs/${runId}/artifacts`} --jq ${".artifacts[].name"}`
      const names = new Set(artifacts.out.split("\n"))
      for (const issue of waiting) {
        const name = `resolve-issues-key-${issue}`
        if (!names.has(name)) continue
        const target = join(dir, String(issue))
        const download =
          await sh`gh run download ${runId} --repo ${repo} --name ${name} --dir ${target}`
        if (!download.ok) continue
        const publicKey = readFileSync(join(target, "public.key"), "utf8").trim()
        const sealed = await seal(credentials, publicKey, handoverContext(repo, runId, issue))
        await ghApi(`gists/${gistId}`, "PATCH", {
          files: { [`issue-${issue}.json`]: { content: JSON.stringify(sealed) } },
        })
        waiting.delete(issue)
        console.log(`  #${issue}: credentials sealed to its job's key`)
      }

      if (waiting.size === 0) {
        const jobs =
          await sh`gh api ${`repos/${repo}/actions/runs/${runId}/jobs?per_page=100`} --jq .jobs`
        if (jobs.ok && issues.every((issue) => received(JSON.parse(jobs.out) as Job[], issue)))
          return
      }
      // After the check above: a dry run can finish between two polls.
      const status = await sh`gh run view ${runId} --repo ${repo} --json status --jq .status`
      if (status.out === "completed") break
      await Bun.sleep(POLL_MS)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
  const missing = [...waiting].map((n) => `#${n}`).join(" ")
  throw new Error(
    missing
      ? `no public key from the job for ${missing}; see https://github.com/${repo}/actions/runs/${runId}`
      : `the jobs did not confirm they received their credentials; see https://github.com/${repo}/actions/runs/${runId}`,
  )
}

/** Runner: write a fresh key pair; only public.key leaves the job. */
async function keygen(dir: string) {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const { publicKey, privateKey } = await generateKeyPair()
  writeFileSync(join(dir, "private.key"), privateKey, { mode: 0o600 })
  writeFileSync(join(dir, "public.key"), `${publicKey}\n`)
}

/** Runner: wait for this job's ciphertext in the handover gist, then export the credentials. */
async function receive(dir: string) {
  const {
    HANDSHAKE: gist,
    ISSUE: issue,
    GITHUB_REPOSITORY: repo,
    GITHUB_RUN_ID: runId,
  } = process.env
  const githubEnv = process.env.GITHUB_ENV
  if (!gist || !/^[0-9a-f]+$/.test(gist)) fail("HANDSHAKE must be the handover gist's id", 2)
  if (!issue || !repo || !runId || !githubEnv)
    fail("receive runs inside the Resolve issues workflow", 2)
  const privateKeyPath = join(dir, "private.key")
  if (!existsSync(privateKeyPath)) fail(`no private key in ${dir}; run keygen first`, 2)

  // The gist's git remote, not its API: no rate limit and no cache in front of it.
  const file = `issue-${issue}.json`
  const deadline = Date.now() + HANDSHAKE_TIMEOUT_MS
  let sealed: Sealed | undefined
  while (!sealed && Date.now() < deadline) {
    const clone = mkdtempSync(join(tmpdir(), "handover-"))
    const cloned =
      await sh`git clone --quiet --depth 1 ${`https://gist.github.com/${gist}.git`} ${clone}`
    if (cloned.ok && existsSync(join(clone, file))) {
      sealed = JSON.parse(readFileSync(join(clone, file), "utf8")) as Sealed
    }
    rmSync(clone, { recursive: true, force: true })
    if (!sealed) await Bun.sleep(POLL_MS)
  }
  if (!sealed) {
    rmSync(privateKeyPath, { force: true })
    fail(
      "no credentials arrived. Credentials are handed over only while `bun github:resolve-issues` runs, and a re-run cannot get them: dispatch again with that command.",
    )
  }

  const privateKey = readFileSync(privateKeyPath, "utf8")
  rmSync(privateKeyPath, { force: true })
  const credentials = await open(
    sealed,
    privateKey,
    handoverContext(repo, runId, Number(issue)),
  ).catch((error: Error) =>
    fail(
      `the credentials in the handover gist do not open with this job's key (${error.message}). They were sealed for another run or job: dispatch again with bun github:resolve-issues.`,
    ),
  )
  // Mask before anything else can print them, then hand them to the later steps.
  console.log(`::add-mask::${credentials.githubToken}`)
  console.log(`::add-mask::${credentials.claudeCodeOAuthToken}`)
  appendFileSync(
    githubEnv,
    `GH_TOKEN=${credentials.githubToken}\nCLAUDE_CODE_OAUTH_TOKEN=${credentials.claudeCodeOAuthToken}\n`,
  )
  console.log(`Credentials for #${issue} received.`)
}

if (import.meta.main) {
  const [command, ...rest] = process.argv.slice(2).filter((a) => a !== "--")
  try {
    if (command === "dispatch") await dispatch(rest)
    else if (command === "keygen" && rest[0]) await keygen(rest[0])
    else if (command === "receive" && rest[0]) await receive(rest[0])
    else fail(USAGE, 2)
  } catch (error) {
    fail(
      error instanceof Error ? error.message : String(error),
      error instanceof UsageError ? 2 : 1,
    )
  }
}
