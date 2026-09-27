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
export type { HermesRuntime, HermesRuntimeOptions } from "./runtime.js"
export { createRuntime } from "./runtime.js"
export const HERMES_NAMESPACE = "hermes"
export type HermesAPIOptions = APIOptions

export class HermesAPI implements FetchAPI {
  readonly app: Hono
  readonly sqlite: SqliteClient
  readonly namespace: string
  private readonly service: Service
  constructor(options: HermesAPIOptions = {}) {
    this.sqlite = bootSqlite(options.sqlite)
    this.namespace = options.namespace ?? HERMES_NAMESPACE
    this.service = createService({
      document,
      sqlite: this.sqlite,
      namespace: this.namespace,
      now: options.now,
      handlers: defineOperations<SupportedOperationId>({}),
      notFound: () => jsonRes(404, { message: "page not found" }),
      unsupported: (_request, operation) =>
        jsonRes(501, {
          error: {
            message: `Mockingbird: ${operation.operationId} is not implemented`,
            type: "mockingbird_unsupported",
            param: null,
            code: "operation_not_implemented",
          },
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
