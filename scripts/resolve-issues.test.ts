import { expect, test } from "bun:test"
import {
  type Credentials,
  generateKeyPair,
  handoverContext,
  type Issue,
  open,
  parseIssueNumbers,
  pickFromQueue,
  seal,
} from "./resolve-issues.ts"

let day = 0
const issue = (number: number, labels: string[], over: Partial<Issue> = {}): Issue => ({
  number,
  createdAt: new Date(Date.UTC(2026, 0, 1 + day++)).toISOString(),
  labels: ["agent-reported", ...labels].map((name) => ({ name })),
  assignees: [],
  closedByPullRequestsReferences: [],
  ...over,
})

test("takes parity, then bug, then feature, oldest first", () => {
  const queue = [
    issue(1, ["feature"]),
    issue(2, ["bug"]),
    issue(3, ["parity"]),
    issue(4, ["bug"]),
    issue(5, ["parity"]),
  ]
  expect(pickFromQueue(queue, 10)).toEqual([3, 5, 2, 4, 1])
  expect(pickFromQueue(queue, 2)).toEqual([3, 5])
})

test("skips claimed, waiting, already-fixed, new-service and unreported issues", () => {
  const queue = [
    issue(1, ["bug"], { assignees: [{ login: "someone" }] }),
    issue(2, ["bug", "needs-info"]),
    issue(3, ["parity", "needs-oracle-check"]),
    issue(4, ["feature"], { closedByPullRequestsReferences: [{ number: 99 }] }),
    issue(5, ["new-service"]),
    { ...issue(6, []), labels: [{ name: "bug" }] },
    issue(7, ["feature"]),
  ]
  expect(pickFromQueue(queue, 10)).toEqual([7])
})

test("parses issue numbers, with or without #, once each", () => {
  expect(parseIssueNumbers(["42", "#7", "42"])).toEqual([42, 7])
  expect(parseIssueNumbers([])).toEqual([])
  expect(() => parseIssueNumbers(["abc"])).toThrow("not an issue number: abc")
  expect(() => parseIssueNumbers(["0"])).toThrow()
  expect(() => parseIssueNumbers(["1.5"])).toThrow()
})

// Obviously fake: the handover only checks the shape of a token.
const credentials: Credentials = {
  githubToken: "gh-token-for-tests-only",
  claudeCodeOAuthToken: "claude-token-for-tests-only",
}
const context = handoverContext("owner/repo", "123", 42)

test("credentials sealed to a job's key open only with that key and context", async () => {
  const job = await generateKeyPair()
  const sealed = await seal(credentials, job.publicKey, context)
  expect(JSON.stringify(sealed)).not.toContain(credentials.githubToken)
  expect(await open(sealed, job.privateKey, context)).toEqual(credentials)

  const other = await generateKeyPair()
  await expect(open(sealed, other.privateKey, context)).rejects.toThrow()
  await expect(
    open(sealed, job.privateKey, handoverContext("owner/repo", "123", 43)),
  ).rejects.toThrow()
  await expect(
    open(sealed, job.privateKey, handoverContext("owner/repo", "124", 42)),
  ).rejects.toThrow()
})

test("a token that could inject a line into $GITHUB_ENV is refused", async () => {
  const job = await generateKeyPair()
  const injected = { ...credentials, githubToken: "gh-token\nNODE_OPTIONS=--require=/tmp/x" }
  const sealed = await seal(injected, job.publicKey, context)
  await expect(open(sealed, job.privateKey, context)).rejects.toThrow("not well-formed tokens")
})
