import { type AwsOperation, AwsProtocolAPI, type AwsProtocolOptions } from "@emulators/service"
import { document, operationIds, supportedOperationIds } from "./generated/openapi.js"

export type { Runtime, RuntimeOptions } from "./runtime.js"
export { createRuntime } from "./runtime.js"
export { document, operationIds, supportedOperationIds }
export type APIOptions = AwsProtocolOptions
export class Route53API extends AwsProtocolAPI {
  constructor(options: APIOptions = {}) {
    super("route53", options)
  }
  dispatch({ operation }: AwsOperation): unknown {
    return this.unsupported(operation)
  }
}
