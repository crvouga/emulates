import type { FetchAPI } from "@crvouga/mockingbird-core"
import {
  type APIOptions,
  bootSqlite,
  createService,
  defineOperations,
  jsonRes,
  type Service,
} from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"
import type { Hono } from "hono"
import { document, type SupportedOperationId } from "./generated/openapi.js"

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
  private readonly service: Service
  constructor(options: DockerAPIOptions = {}) {
    this.sqlite = bootSqlite(options.sqlite)
    this.namespace = options.namespace ?? DOCKER_NAMESPACE
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
      }),
      notFound: () => jsonRes(404, { message: "page not found" }),
      unsupported: (_request, operation) =>
        jsonRes(501, {
          message: `Mockingbird: ${operation.operationId} is not implemented`,
        }),
      onError: (error) => {
        throw error
      },
    })
    this.app = this.service.app
  }
  fetch(request: Request): Promise<Response> {
    return this.service.fetch(request)
  }
  async reset(): Promise<void> {
    await this.service.reset()
  }
}
