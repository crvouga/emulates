import type { FetchAPI } from "@crvouga/mockingbird-core"
import {
  type APIOptions,
  annotateResponse,
  bootSqlite,
  createService,
  defineOperations,
  forwardRequestContext,
  jsonRes,
  markMutationAccepted,
  type Service,
} from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"
import type { Hono } from "hono"
import { document, type SupportedOperationId } from "./generated/openapi.js"
import { HermesError, HermesRuns, unsupported } from "./runs.js"

export type { OperationId, SupportedOperationId } from "./generated/openapi.js"
export { document, operationIds, supportedOperationIds } from "./generated/openapi.js"
export type { RunRecord, RunStatus, RunUsage } from "./runs.js"
export type { HermesRuntime, HermesRuntimeOptions } from "./runtime.js"
export { createRuntime } from "./runtime.js"
export const HERMES_NAMESPACE = "hermes"
export type HermesAPIOptions = APIOptions

export class HermesAPI implements FetchAPI {
  readonly app: Hono
  readonly sqlite: SqliteClient
  readonly namespace: string
  readonly runs: HermesRuns
  private readonly service: Service
  constructor(options: HermesAPIOptions = {}) {
    this.sqlite = bootSqlite(options.sqlite)
    this.namespace = options.namespace ?? HERMES_NAMESPACE
    this.runs = new HermesRuns(this.sqlite, this.namespace, options.now ?? Date.now)
    this.service = createService({
      document,
      sqlite: this.sqlite,
      namespace: this.namespace,
      now: options.now,
      handlers: defineOperations<SupportedOperationId>({
        RunCreate: ({ body, request }) => {
          const memoryKey = request.headers.get("X-Hermes-Session-Key")?.trim() ?? ""
          if (memoryKey.length > 256 || /[\r\n\0]/.test(memoryKey))
            return unsupported("invalid memory-scope headers are outside the current subset")
          if (request.headers.get("Idempotency-Key")?.trim())
            return unsupported("idempotency is scheduled for US-018")
          if (body.kind !== "json") throw new HermesError(400, "Invalid JSON")
          const run = this.runs.create(body.value)
          markMutationAccepted(request, { ids: { runId: run.run_id } })
          const response = jsonRes(202, { run_id: run.run_id, status: "started", replayed: false })
          if (memoryKey) response.headers.set("X-Hermes-Session-Key", memoryKey)
          return annotateResponse(response, { ids: { runId: run.run_id } })
        },
        RunGet: ({ params }) => jsonRes(200, this.runs.get(params.run_id ?? "")),
      }),
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
        if (error instanceof HermesError) return jsonRes(error.status, error.envelope())
        throw error
      },
    })
    this.app = this.service.app
  }
  fetch(request: Request): Promise<Response> {
    // aiohttp Request.json() parses JSON independent of Content-Type.
    if (request.method === "POST" && new URL(request.url).pathname === "/v1/runs") {
      const headers = new Headers(request.headers)
      headers.set("content-type", "application/json")
      request = forwardRequestContext(request, new Request(request, { headers }))
    }
    return this.service.fetch(request)
  }
  async reset(): Promise<void> {
    await this.service.reset()
  }
}
