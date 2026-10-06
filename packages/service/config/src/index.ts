import { type AwsOperation, AwsProtocolAPI, type AwsProtocolOptions } from "@emulates/service"
import { document, operationIds, supportedOperationIds } from "./generated/openapi.js"

export type { Runtime, RuntimeOptions } from "./runtime.js"
export { createRuntime } from "./runtime.js"
export { document, operationIds, supportedOperationIds }
export type APIOptions = AwsProtocolOptions
export class ConfigAPI extends AwsProtocolAPI {
  constructor(options: APIOptions = {}) {
    super("config", options)
  }
  dispatch({ operation }: AwsOperation): unknown {
    return this.unsupported(operation)
  }
}
