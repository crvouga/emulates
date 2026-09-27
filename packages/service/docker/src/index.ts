import type { FetchAPI } from "@crvouga/mockingbird-core"
import {
  type APIOptions,
  bootSqlite,
  createService,
  DroppedConnectionError,
  defineOperations,
  jsonRes,
  type Service,
} from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"
import type { Hono } from "hono"
import { document, type SupportedOperationId } from "./generated/openapi.js"
import { booleanQuery, info, inspect, list, version } from "./observations.js"
import { DockerInputError, DockerState } from "./state.js"

export type { OperationId, SupportedOperationId } from "./generated/openapi.js"
export { document, operationIds, supportedOperationIds } from "./generated/openapi.js"
export type { DockerRuntime, DockerRuntimeOptions } from "./runtime.js"
export { createRuntime } from "./runtime.js"
export const DOCKER_NAMESPACE = "docker"
export type DockerAPIOptions = APIOptions

export class DockerAPI implements FetchAPI {
  readonly app: Hono
  readonly sqlite: SqliteClient
  readonly namespace: string
  readonly state: DockerState
  private readonly service: Service
  constructor(options: DockerAPIOptions = {}) {
    this.sqlite = bootSqlite(options.sqlite)
    this.namespace = options.namespace ?? DOCKER_NAMESPACE
    const now = options.now ?? Date.now
    this.state = new DockerState(this.sqlite, this.namespace, now)
    const ping = (head: boolean) =>
      new Response(head ? null : "OK", {
        headers: {
          "content-type": "text/plain; charset=utf-8",
          "api-version": "1.52",
          "docker-experimental": "false",
          "builder-version": "2",
          swarm: "inactive",
          "cache-control": "no-cache, no-store, must-revalidate",
          pragma: "no-cache",
        },
      })
    this.service = createService({
      document,
      sqlite: this.sqlite,
      namespace: this.namespace,
      now: options.now,
      handlers: defineOperations<SupportedOperationId>({
        SystemPing: () => ping(false),
        SystemPingHead: () => ping(true),
        SystemVersion: () => jsonRes(200, version()),
        SystemInfo: () => jsonRes(200, info(this.state, now)),
        ContainerList: ({ url }) => list(this.state, url, now),
        ContainerInspect: ({ params, url }) =>
          jsonRes(200, inspect(this.state.find(params.id ?? ""), booleanQuery(url, "size"))),
      }),
      notFound: () => jsonRes(404, { message: "page not found" }),
      unsupported: (_request, operation) =>
        jsonRes(501, {
          message: `Mockingbird: ${operation.operationId} is not implemented`,
        }),
      onError: (error) => {
        if (error instanceof DockerInputError)
          return jsonRes(error.status, { message: error.message })
        throw error
      },
    })
    this.app = this.service.app
  }
  fetch(request: Request): Promise<Response> {
    if (!this.state.daemon().available) return Promise.reject(new DroppedConnectionError())
    const url = new URL(request.url)
    const match = /^\/v(\d+)\.(\d+)(\/.*)$/.exec(url.pathname)
    if (match) {
      const major = Number(match[1])
      const minor = Number(match[2])
      const v = `${match[1]}.${match[2]}`
      const tooNew = major > 1 || (major === 1 && minor > 52)
      const tooOld = major < 1 || (major === 1 && minor < 44)
      if (tooNew || tooOld) {
        const message = tooNew
          ? `client version ${v} is too new. Maximum supported API version is 1.52`
          : `client version ${v} is too old. Minimum supported API version is 1.44, please upgrade your client to a newer version`
        return Promise.resolve(
          major < 1 || (major === 1 && minor < 24)
            ? new Response(message, {
                status: 400,
                headers: { "content-type": "text/plain; charset=utf-8" },
              })
            : jsonRes(400, { message }),
        )
      }
      if (v !== "1.52")
        return Promise.resolve(
          jsonRes(501, { message: `Mockingbird: API ${v} is not implemented; use 1.52` }),
        )
      url.pathname = match[3] ?? "/"
      request = new Request(url, request)
    }
    return this.service.fetch(request)
  }
  async reset(): Promise<void> {
    await this.service.reset()
  }
}
