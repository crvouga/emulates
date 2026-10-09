import { dirname, join, resolve } from "node:path"

/**
 * Keep the seed checkout beside the primary repository, not beside the current
 * worktree. App-managed worktree parents may remove unknown sibling directories.
 */
export function seedCachePath(gitCommonDir: string): string {
  const primaryRepository = dirname(resolve(gitCommonDir))
  return join(dirname(primaryRepository), ".mockingbird-seed-main")
}
