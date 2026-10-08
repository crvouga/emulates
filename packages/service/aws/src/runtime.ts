import {
  type RuntimeOptions,
  type ServiceRuntime,
  createRuntime as serviceRuntime,
} from "@crvouga/mockingbird-service"
import { AWS_NAMESPACE, AwsAPI, type AwsAPIOptions, document } from "./index.js"
export type AwsRuntimeOptions = Pick<
  RuntimeOptions<AwsAPI>,
  | "sqlite"
  | "clock"
  | "seed"
  | "adminPrefix"
  | "adminKey"
  | "onLog"
  | "journalSize"
  | "maxCheckpoints"
> &
  Pick<AwsAPIOptions, "fixtures" | "baseUrl" | "tokens">
export type AwsRuntime = ServiceRuntime<AwsAPI>
export function createRuntime(options: AwsRuntimeOptions = {}): AwsRuntime {
  return serviceRuntime({
    ...options,
    name: AWS_NAMESPACE,
    document,
    create: ({ sqlite, namespace, publicNamespace, adminPrefix, clock }) =>
      new AwsAPI({
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
