import { AwsProtocolAPI, type AwsProtocolOptions } from "@crvouga/mockingbird-service"
import { document, operationIds, supportedOperationIds } from "./generated/openapi.js"
export { document, operationIds, supportedOperationIds }
export { createRuntime } from "./runtime.js"
export type { RuntimeOptions, Runtime } from "./runtime.js"
export type APIOptions = AwsProtocolOptions
export class SupportAPI extends AwsProtocolAPI {
  constructor(options: APIOptions = {}) { super("support", options) }
  dispatch(): unknown { return this.unsupported("pending") }
}
