import {
  type AdminRoutes,
  createRuntime as createServiceRuntime,
  jsonRes,
  type RuntimeOptions,
  type ServiceRuntime,
} from "@crvouga/mockingbird-service"
import { document } from "./generated/openapi.js"
import { DOCKER_NAMESPACE, DockerAPI } from "./index.js"
import { DockerInputError } from "./state.js"

export type DockerRuntimeOptions = Pick<
  RuntimeOptions<DockerAPI>,
  "sqlite" | "clock" | "seed" | "adminKey" | "onLog" | "journalSize" | "maxCheckpoints"
>
export type DockerRuntime = ServiceRuntime<DockerAPI>

const admin = (runtime: DockerRuntime): AdminRoutes => {
  const respond = (status: number, action: () => unknown) => {
    try {
      return jsonRes(status, action())
    } catch (error) {
      if (error instanceof DockerInputError)
        return jsonRes(error.status, { message: error.message })
      throw error
    }
  }
  return {
    "POST /docker/seed": ({ body, namespace }) =>
      respond(201, () => runtime.instance(namespace).state.seed(body)),
    "POST /docker/daemon": ({ body, namespace }) =>
      respond(200, () => runtime.instance(namespace).state.updateDaemon(body)),
    "GET /docker/daemon": ({ namespace }) =>
      jsonRes(200, { ...runtime.instance(namespace).state.daemon(), simulated: true }),
  }
}

/** Standard controls and Timeline coordination; no provider-local history. */
export const createRuntime = (options: DockerRuntimeOptions = {}): DockerRuntime => {
  const runtime = createServiceRuntime({
    ...options,
    name: DOCKER_NAMESPACE,
    document,
    admin,
    create: ({ sqlite, namespace, clock }) => new DockerAPI({ sqlite, namespace, now: clock.now }),
  })
  return {
    ...runtime,
    fetch: (request: Request) => {
      const url = new URL(request.url)
      const match = /^(\/ns\/[^/]+)?\/v1\.52(\/.*)$/.exec(url.pathname)
      // Normalize provider aliases before shared operation matching (faults and journal).
      // Administrative endpoints retain their existing, unversioned routing.
      if (match?.[2] && /^(?:\/(?:_ping|version|info)$|\/containers(?:\/|$))/.test(match[2])) {
        url.pathname = `${match[1] ?? ""}${match[2]}`
        request = new Request(url, request)
      }
      return runtime.fetch(request)
    },
  }
}
