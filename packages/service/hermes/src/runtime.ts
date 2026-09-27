import {
  createRuntime as createServiceRuntime,
  jsonRes,
  type RuntimeOptions,
  type ServiceRuntime,
} from "@crvouga/mockingbird-service"
import { document } from "./generated/openapi.js"
import { HERMES_NAMESPACE, HermesAPI } from "./index.js"
import { HermesError } from "./runs.js"

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
    admin: (runtime) => ({
      "POST /hermes/runs/:id/observe": ({ params, body, namespace }) => {
        try {
          const run = runtime.instance(namespace).runs.observe(params.id ?? "", body)
          runtime.checkpoint(namespace)
          return jsonRes(200, run)
        } catch (error) {
          if (error instanceof HermesError) return jsonRes(error.status, error.envelope())
          throw error
        }
      },
    }),
    create: ({ sqlite, namespace, clock }) => new HermesAPI({ sqlite, namespace, now: clock.now }),
  })
