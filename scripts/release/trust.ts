import { publisherGap, type TrustConfig } from "../health/trusted-publisher.ts"

/** npm trust list --json returns an array. Invalid output never proves a package is trusted. */
export function hasReleasePublisher(output: string): boolean {
  try {
    const configs: unknown = JSON.parse(output)
    if (!Array.isArray(configs)) return false
    return publisherGap(true, configs as TrustConfig[]) === null
  } catch {
    return false
  }
}

/** Keep trust failures separate from publish failures: an already-published dependency is usable. */
export function trustedPublisherReconciler(options: {
  list: (name: string) => Promise<string | null>
  create: (name: string) => Promise<boolean>
  onError: (name: string, error: unknown) => void
  now?: () => number
  sleep?: (ms: number) => Promise<unknown>
}) {
  const failed = new Set<string>()
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? ((ms: number) => Bun.sleep(ms))
  let lastMutationFinishedAt: number | undefined

  async function ensure(name: string): Promise<void> {
    // A thrown command is also a failed reconciliation, not an abort of independent packages.
    failed.add(name)
    try {
      const listed = await options.list(name)
      if (listed !== null && hasReleasePublisher(listed)) {
        failed.delete(name)
        return
      }
      // https://docs.npmjs.com/cli/v11/commands/npm-trust/#bulk-usage
      if (lastMutationFinishedAt !== undefined) {
        const delay = Math.max(0, 2_000 - (now() - lastMutationFinishedAt))
        if (delay > 0) await sleep(delay)
      }
      try {
        if (await options.create(name)) failed.delete(name)
      } finally {
        lastMutationFinishedAt = now()
      }
    } catch (error) {
      options.onError(name, error)
    }
  }

  return { failed, ensure }
}
