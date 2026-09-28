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
export const createRuntime = (options: GitHubRuntimeOptions = {}): GitHubRuntime =>
  createServiceRuntime({
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
