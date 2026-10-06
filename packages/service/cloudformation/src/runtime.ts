import {
  type Clock,
  type RequestLog,
  type ServiceRuntime,
  createRuntime as serviceRuntime,
  sigV4AccessKeyId,
} from "@emulators/service"
import type { SqliteClient } from "@emulators/sqlite-client"
import { document } from "./generated/openapi.js"
import { CloudformationAPI } from "./index.js"
export type RuntimeOptions = {
  sqlite?: SqliteClient
  clock?: Clock
  seed?: number | string
  region?: string
  accountId?: string
  adminPrefix?: string
  adminKey?: string
  onLog?: (entry: RequestLog) => void
}
export type Runtime = ServiceRuntime<CloudformationAPI>
export const createRuntime = (options: RuntimeOptions = {}): Runtime =>
  serviceRuntime({
    name: "cloudformation",
    document,
    credential: sigV4AccessKeyId,
    ...(options.sqlite ? { sqlite: options.sqlite } : {}),
    ...(options.clock ? { clock: options.clock } : {}),
    ...(options.seed !== undefined ? { seed: options.seed } : {}),
    ...(options.adminPrefix !== undefined ? { adminPrefix: options.adminPrefix } : {}),
    ...(options.adminKey !== undefined ? { adminKey: options.adminKey } : {}),
    ...(options.onLog ? { onLog: options.onLog } : {}),
    create: ({ sqlite, namespace, clock }) =>
      new CloudformationAPI({
        sqlite,
        namespace,
        now: clock.now,
        ...(options.region ? { region: options.region } : {}),
        ...(options.accountId ? { accountId: options.accountId } : {}),
      }),
  })
