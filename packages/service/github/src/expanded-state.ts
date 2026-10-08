import {
  type GitHubPullRequest,
  getGitHubStore,
  type ProviderExpansion,
  seedGithub,
} from "@crvouga/mockingbird-http-provider"
import { Collection } from "@crvouga/mockingbird-service"
import type { PullRequest } from "./pulls.js"
import type { GitHubState, Repository } from "./state.js"

/** Both route sets share repositories, commit ancestry, refs and pull/issue numbering. */
export function syncToExpanded(state: GitHubState, expansion: ProviderExpansion): void {
  const gh = getGitHubStore(expansion.store)
  for (const { value: repo } of state.repositories.list()) {
    if (!gh.repos.findOneBy("full_name", repo.full_name)) {
      seedGithub(expansion.store, expansion.options.baseUrl ?? "http://mock.local", {
        orgs: [{ login: repo.owner.login }],
        repos: [
          {
            owner: repo.owner.login,
            name: repo.name,
            private: repo.private,
            default_branch: repo.default_branch,
          },
        ],
      })
    }
    const extended = gh.repos.findOneBy("full_name", repo.full_name)
    if (!extended) continue
    const prefix = `${repo.full_name.toLowerCase()}:`
    for (const { id, value: commit } of state.commits.list()) {
      if (
        !id.startsWith(prefix) ||
        gh.commits.findBy("repo_id", extended.id).some((row) => row.sha === commit.sha)
      )
        continue
      gh.commits.insert({
        repo_id: extended.id,
        sha: commit.sha,
        node_id: `C_${commit.sha}`,
        message: "Synthetic seeded commit",
        author_name: repo.owner.login,
        author_email: "fixture@example.test",
        author_date: repo.created_at,
        committer_name: repo.owner.login,
        committer_email: "fixture@example.test",
        committer_date: repo.created_at,
        tree_sha: "0".repeat(40),
        parent_shas: commit.parents,
        user_id: null,
      })
      if (!gh.trees.findBy("repo_id", extended.id).some((tree) => tree.sha === "0".repeat(40)))
        gh.trees.insert({
          repo_id: extended.id,
          sha: "0".repeat(40),
          node_id: `TREE_${extended.id}`,
          tree: [],
          truncated: false,
        })
    }
    const native = state.references(repo.owner.login, repo.name)
    for (const reference of native) {
      const existing = gh.refs
        .findBy("repo_id", extended.id)
        .find((row) => row.ref === reference.ref)
      const value = {
        repo_id: extended.id,
        ref: reference.ref,
        sha: reference.object.sha,
        node_id: reference.node_id,
      }
      if (existing) gh.refs.update(existing.id, value)
      else gh.refs.insert(value)
      if (reference.ref.startsWith("refs/heads/")) {
        const name = reference.ref.slice(11)
        const branch = gh.branches.findBy("repo_id", extended.id).find((row) => row.name === name)
        if (branch) gh.branches.update(branch.id, { sha: reference.object.sha })
        else
          gh.branches.insert({
            repo_id: extended.id,
            name,
            sha: reference.object.sha,
            protected: false,
          })
      }
    }
  }
  const rows = new Collection<PullRequest>(expansion.sqlite, expansion.namespace, "github-pulls")
  for (const { value: pull } of rows.list()) {
    const repo = gh.repos.findOneBy("full_name", pull.base.repo.full_name)
    const head = gh.repos.findOneBy("full_name", pull.head.repo.full_name)
    if (!repo || !head) continue
    const actor = gh.users.all()[0]?.id ?? 1
    const existing = gh.pullRequests
      .findBy("repo_id", repo.id)
      .find((row) => row.number === pull.number)
    const data: Omit<GitHubPullRequest, "id" | "created_at" | "updated_at"> = {
      node_id: pull.node_id,
      number: pull.number,
      repo_id: repo.id,
      title: pull.title,
      body: pull.body,
      state: pull.state,
      locked: false,
      user_id: actor,
      assignee_ids: [],
      label_ids: [],
      milestone_id: null,
      head_ref: pull.head.ref,
      head_sha: pull.head.sha,
      head_repo_id: head.id,
      base_ref: pull.base.ref,
      base_sha: pull.base.sha,
      base_repo_id: repo.id,
      merged: pull.merged,
      merged_at: pull.merged_at,
      merged_by_id: null,
      merge_commit_sha: pull.merge_commit_sha,
      mergeable: pull.mergeable,
      mergeable_state: "clean",
      comments: 0,
      review_comments: 0,
      commits: 1,
      additions: 0,
      deletions: 0,
      changed_files: 0,
      draft: pull.draft,
      requested_reviewer_ids: [],
      requested_team_ids: [],
      closed_at: pull.closed_at,
      auto_merge: null,
    }
    if (existing)
      gh.pullRequests.update(existing.id, {
        title: pull.title,
        body: pull.body,
        state: pull.state,
        head_ref: pull.head.ref,
        head_sha: pull.head.sha,
        base_ref: pull.base.ref,
        base_sha: pull.base.sha,
        merged: pull.merged,
        merged_at: pull.merged_at,
        merge_commit_sha: pull.merge_commit_sha,
        mergeable: pull.mergeable,
        draft: pull.draft,
        closed_at: pull.closed_at,
      })
    else gh.pullRequests.insert(data)
    const issue = gh.issues.findBy("repo_id", repo.id).find((row) => row.number === pull.number)
    const values = {
      node_id: pull.node_id,
      number: pull.number,
      repo_id: repo.id,
      title: pull.title,
      body: pull.body,
      state: pull.state,
      state_reason: null,
      locked: false,
      active_lock_reason: null,
      user_id: actor,
      assignee_ids: [],
      label_ids: [],
      milestone_id: null,
      comments: 0,
      closed_at: pull.closed_at,
      closed_by_id: null,
      is_pull_request: true,
    } as const
    if (issue)
      gh.issues.update(issue.id, {
        title: pull.title,
        body: pull.body,
        state: pull.state,
        closed_at: pull.closed_at,
      })
    else gh.issues.insert({ ...values, assignee_ids: [], label_ids: [] })
  }
}

export function syncFromExpanded(state: GitHubState, expansion: ProviderExpansion): void {
  const gh = getGitHubStore(expansion.store)
  for (const repo of gh.repos.all()) {
    const owner =
      repo.owner_type === "User" ? gh.users.get(repo.owner_id) : gh.orgs.get(repo.owner_id)
    if (!owner) continue
    const key = repo.full_name.toLowerCase()
    if (!state.repositories.has(key)) {
      const identity: Repository["owner"] = {
        login: owner.login,
        id: owner.id,
        node_id: owner.node_id,
        type: repo.owner_type,
      }
      state.owners.insert(owner.login.toLowerCase(), identity)
      state.repositories.insert(key, {
        id: repo.id,
        node_id: repo.node_id,
        name: repo.name,
        full_name: repo.full_name,
        owner: identity,
        private: repo.private,
        fork: repo.fork,
        default_branch: repo.default_branch,
        url: `https://api.github.com/repos/${repo.full_name}`,
        html_url: `https://github.com/${repo.full_name}`,
        created_at: repo.created_at,
        updated_at: repo.updated_at,
      })
    }
    const nativeRepo = state.repositories.get(key)
    if (nativeRepo)
      state.repositories.update(key, {
        ...nativeRepo,
        name: repo.name,
        full_name: repo.full_name,
        private: repo.private,
        default_branch: repo.default_branch,
        updated_at: repo.updated_at,
      })
    for (const commit of gh.commits.findBy("repo_id", repo.id)) {
      const id = `${key}:${commit.sha}`
      const value = { sha: commit.sha, parents: commit.parent_shas }
      if (state.commits.has(id)) state.commits.update(id, value)
      else state.commits.insert(id, value)
    }
    for (const ref of gh.refs.findBy("repo_id", repo.id)) {
      if (!ref.ref.startsWith("refs/heads/")) continue
      const id = `${key}:${ref.ref}`
      const value = { ref: ref.ref, sha: ref.sha, node_id: ref.node_id }
      if (state.branches.has(id)) state.branches.update(id, value)
      else state.branches.insert(id, value)
    }
    for (const row of state.branches.list())
      if (
        row.id.startsWith(`${key}:`) &&
        !gh.refs.findBy("repo_id", repo.id).some((ref) => row.value.ref === ref.ref)
      )
        state.branches.delete(row.id)
  }
  for (const row of state.repositories.list())
    if (!gh.repos.findOneBy("full_name", row.value.full_name)) {
      state.repositories.delete(row.id)
      for (const commit of state.commits.list())
        if (commit.id.startsWith(`${row.id}:`)) state.commits.delete(commit.id)
      for (const branch of state.branches.list())
        if (branch.id.startsWith(`${row.id}:`)) state.branches.delete(branch.id)
    }
  // Pull creation and issue creation must share the vendor's per-repository number space.
  const nativePulls = new Collection<PullRequest>(
    expansion.sqlite,
    expansion.namespace,
    "github-pulls",
  )
  for (const pull of nativePulls.list()) {
    const repo = gh.repos.findOneBy("full_name", pull.value.base.repo.full_name)
    if (!repo) {
      nativePulls.delete(pull.id)
      continue
    }
    const merged = gh.pullRequests
      .findBy("repo_id", repo.id)
      .find((row) => row.number === pull.value.number)
    if (merged)
      nativePulls.update(pull.id, {
        ...pull.value,
        title: merged.title,
        body: merged.body,
        state: merged.state,
        merged: merged.merged,
        merged_at: merged.merged_at,
        merge_commit_sha: merged.merge_commit_sha,
        mergeable: merged.mergeable,
      })
  }
}
