import {
  createRuntime as createServiceRuntime,
  jsonRes,
  type RuntimeOptions,
  type ServiceRuntime,
} from "@crvouga/mockingbird-service"
import { document } from "./generated/openapi.js"
import { GITHUB_NAMESPACE, GitHubAPI } from "./index.js"
import { SeedError } from "./state.js"
export type GitHubRuntimeOptions = Pick<
  RuntimeOptions<GitHubAPI>,
  "sqlite" | "clock" | "seed" | "adminKey" | "onLog" | "journalSize" | "maxCheckpoints"
>
export type GitHubRuntime = ServiceRuntime<GitHubAPI>
export const createRuntime = (options: GitHubRuntimeOptions = {}): GitHubRuntime => {
  const runtime = createServiceRuntime<GitHubAPI>({
    ...options,
    name: GITHUB_NAMESPACE,
    document,
    admin: (runtime) => ({
      "POST /github/repositories": ({ body, namespace }) => {
        try {
          const repo = runtime.instance(namespace).state.seed(body)
          runtime.checkpoint(namespace)
          return jsonRes(201, { repository: repo, simulated: true })
        } catch (error) {
          if (error instanceof SeedError)
            return jsonRes(error.status, {
              message: error.message,
              code: "mockingbird_seed_invalid",
            })
          throw error
        }
      },
    }),
    create: ({ sqlite, namespace, clock }) => new GitHubAPI({ sqlite, namespace, now: clock.now }),
  })

  const fetch = runtime.fetch
  runtime.fetch = async (request) => {
    const response = await fetch(request)
    const links = response.headers.get("link")
    if (!links) return response
    const source = new URL(request.url)
    const prefix = /^\/ns\/([^/]+)(?:\/|$)/.exec(source.pathname)
    const namespace =
      request.headers.get("x-mockingbird-namespace") ??
      (prefix?.[1] ? decodeURIComponent(prefix[1]) : undefined)
    if (!namespace) return response
    response.headers.set(
      "link",
      links.replace(/<([^>]+)>/g, (original, href: string) => {
        const target = new URL(href, source)
        if (target.origin !== source.origin || !target.pathname.startsWith("/repos/"))
          return original
        target.pathname = `/ns/${encodeURIComponent(namespace)}${target.pathname}`
        return `<${target.href}>`
      }),
    )
    return response
  }
  return runtime
}
