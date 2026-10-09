import {
  type RuntimeOptions,
  type ServiceRuntime,
  createRuntime as serviceRuntime,
} from "@crvouga/mockingbird-service"
import { CLERK_NAMESPACE, ClerkAPI, type ClerkAPIOptions, document } from "./index.js"
export type ClerkRuntimeOptions = Pick<
  RuntimeOptions<ClerkAPI>,
  | "sqlite"
  | "clock"
  | "seed"
  | "adminPrefix"
  | "adminKey"
  | "onLog"
  | "journalSize"
  | "maxCheckpoints"
> &
  Pick<ClerkAPIOptions, "fixtures" | "baseUrl" | "tokens">
export type ClerkRuntime = ServiceRuntime<ClerkAPI>
export function createRuntime(options: ClerkRuntimeOptions = {}): ClerkRuntime {
  return serviceRuntime({
    ...options,
    name: CLERK_NAMESPACE,
    document,
    create: ({ sqlite, namespace, publicNamespace, adminPrefix, clock }) =>
      new ClerkAPI({
        sqlite,
        namespace,
        publicNamespace,
        adminPrefix,
        now: clock.now,
        ...(options.fixtures ? { fixtures: options.fixtures } : {}),
        ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
        ...(options.tokens ? { tokens: options.tokens } : {}),
      }),
  })
}
