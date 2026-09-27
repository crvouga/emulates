import {
  createRuntime as createServiceRuntime,
  type RuntimeOptions,
  type ServiceRuntime,
} from "@crvouga/mockingbird-service"
import { document } from "./generated/openapi.js"
import { DOCKER_NAMESPACE, DockerAPI } from "./index.js"

export type DockerRuntimeOptions = Pick<
  RuntimeOptions<DockerAPI>,
  "sqlite" | "clock" | "seed" | "adminKey" | "onLog" | "journalSize" | "maxCheckpoints"
>
export type DockerRuntime = ServiceRuntime<DockerAPI>

/** Standard controls and Timeline coordination; no provider-local history. */
export const createRuntime = (options: DockerRuntimeOptions = {}): DockerRuntime =>
  createServiceRuntime({
    ...options,
    name: DOCKER_NAMESPACE,
    document,
    create: ({ sqlite, namespace, clock }) => new DockerAPI({ sqlite, namespace, now: clock.now }),
  })
