import {
  createRuntime as createServiceRuntime,
  type RuntimeOptions,
  type ServiceRuntime,
} from "@crvouga/mockingbird-service"
import { document } from "./generated/openapi.js"
import { HERMES_NAMESPACE, HermesAPI } from "./index.js"

export type HermesRuntimeOptions = Pick<
  RuntimeOptions<HermesAPI>,
  "sqlite" | "clock" | "seed" | "adminKey" | "onLog" | "journalSize" | "maxCheckpoints"
>
export type HermesRuntime = ServiceRuntime<HermesAPI>

/** Standard controls and Timeline coordination; no provider-local history. */
export const createRuntime = (options: HermesRuntimeOptions = {}): HermesRuntime =>
  createServiceRuntime({
    ...options,
    name: HERMES_NAMESPACE,
    document,
    create: ({ sqlite, namespace, clock }) => new HermesAPI({ sqlite, namespace, now: clock.now }),
  })
