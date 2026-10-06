/**
 * The project's identity: the one place its name, npm scope, repository and site are written.
 *
 * Scripts, the release pipeline, the docs site, README.md and llms.txt read it from here. A
 * rebrand edits this file, renames the workspace packages (`check:boundaries` names any that
 * disagree with `packageName`), then runs `bun run readme:sync && bun run llms:sync`.
 *
 * Package ids are the directory names under `packages/service/` and never change with branding:
 * package id `postgres` is published as `packageName("postgres")`.
 */
export const project = {
  name: "Emulators",
  slug: "emulators",
  description: "High-fidelity, in-process emulators for APIs and databases.",
  npmScope: "@emulators",
  /** GitHub `owner/name`. */
  repository: "crvouga/emulators",
  site: "https://emulators.chrisvouga.dev",
} as const

/** npm name for a stable package id: `postgres` → `@emulators/postgres`. */
export const packageName = (id: string): string => `${project.npmScope}/${id}`

export const repositoryUrl = `https://github.com/${project.repository}`
