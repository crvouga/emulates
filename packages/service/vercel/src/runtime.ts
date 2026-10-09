import {
  type RuntimeOptions,
  type ServiceRuntime,
  createRuntime as serviceRuntime,
} from "@crvouga/mockingbird-service"
import { document, VERCEL_NAMESPACE, VercelAPI, type VercelAPIOptions } from "./index.js"
export type VercelRuntimeOptions = Pick<
  RuntimeOptions<VercelAPI>,
  | "sqlite"
  | "clock"
  | "seed"
  | "adminPrefix"
  | "adminKey"
  | "onLog"
  | "journalSize"
  | "maxCheckpoints"
> &
  Pick<VercelAPIOptions, "fixtures" | "baseUrl" | "tokens">
export type VercelRuntime = ServiceRuntime<VercelAPI>
export function createRuntime(options: VercelRuntimeOptions = {}): VercelRuntime {
  return serviceRuntime({
    ...options,
    name: VERCEL_NAMESPACE,
    document,
    create: ({ sqlite, namespace, publicNamespace, adminPrefix, clock }) =>
      new VercelAPI({
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
