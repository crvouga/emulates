import { expect, test } from "bun:test"
import {
  APP_PERMISSIONS,
  appManifest,
  checkTokenReach,
  type Installation,
  reachProblems,
} from "./github-app-token.ts"

const repo = "owner/emulators"
const installation = (over: Partial<Installation> = {}): Installation => ({
  id: 1,
  repository_selection: "selected",
  permissions: { ...APP_PERMISSIONS },
  ...over,
})

test("a token on this repository alone, with the agents' permissions, passes", () => {
  expect(reachProblems([installation()], [repo], repo)).toEqual([])
  expect(reachProblems([installation()], [repo.toUpperCase()], repo)).toEqual([])
  // Fewer permissions than the app asks for is fine.
  expect(
    reachProblems([installation({ permissions: { metadata: "read" } })], [repo], repo),
  ).toEqual([])
})

test("a token that reaches another repository is refused", () => {
  expect(reachProblems([installation()], [repo, "owner/other"], repo)).toEqual([
    "it reaches owner/emulators, owner/other, not owner/emulators alone",
  ])
  expect(reachProblems([installation()], ["owner/other"], repo)).toHaveLength(1)
  expect(reachProblems([installation()], [], repo)).toEqual([
    "it reaches no repository, not owner/emulators alone",
  ])
})

test("an app installed on every repository, or twice, is refused", () => {
  expect(
    reachProblems([installation({ repository_selection: "all" })], [repo], repo),
  ).toContainEqual("the app is installed on all repositories, not only owner/emulators")
  expect(reachProblems([installation(), installation({ id: 2 })], [repo], repo)).toContainEqual(
    "it reaches 2 installations of the app, not exactly one",
  )
  expect(reachProblems([], [repo], repo)).toContainEqual(
    "it reaches 0 installations of the app, not exactly one",
  )
})

test("a permission beyond the agents' list is refused", () => {
  const broader = (permissions: Record<string, string>) =>
    reachProblems(
      [installation({ permissions: { ...APP_PERMISSIONS, ...permissions } })],
      [repo],
      repo,
    )
  expect(broader({ workflows: "write" })).toEqual([
    "it has workflows: write; the agents get no such permission",
  ])
  expect(broader({ administration: "read" })).toHaveLength(1)
  expect(broader({ secrets: "write" })).toHaveLength(1)
  expect(broader({ checks: "write" })).toEqual(["it has checks: write; the agents get read"])
  expect(broader({ contents: "admin" })).toHaveLength(1)
})

test("a token that is not a GitHub App user token is refused before any request", async () => {
  for (const token of ["gho_classic-oauth", "ghp_classic-pat", "github_pat_fine-grained"]) {
    expect(await checkTokenReach(token, repo)).toEqual([
      "it is not a GitHub App user access token (ghu_…), so its reach cannot be bounded",
    ])
  }
})

test("the app is registered private, without a webhook, with exactly the agents' permissions", () => {
  const manifest = appManifest(repo, "owner", "http://localhost:1234/created")
  expect(manifest.public).toBe(false)
  expect(manifest.hook_attributes.active).toBe(false)
  expect(manifest.default_events).toEqual([])
  expect(manifest.default_permissions).toEqual(APP_PERMISSIONS)
  expect(manifest.default_permissions).not.toHaveProperty("workflows")
  expect(manifest.name.length).toBeLessThanOrEqual(34)
})
