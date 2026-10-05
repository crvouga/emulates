import { AwsProtocolAPI, type AwsProtocolOptions } from "@crvouga/mockingbird-service"
import { document, operationIds, supportedOperationIds } from "./generated/openapi.js"
export { document, operationIds, supportedOperationIds }
export { createRuntime } from "./runtime.js"
export type { RuntimeOptions, Runtime } from "./runtime.js"
export type APIOptions = AwsProtocolOptions
export class ApigatewayAPI extends AwsProtocolAPI {
  constructor(options: APIOptions = {}) { super("apigateway", options) }
  dispatch(): unknown { return this.unsupported("pending") }
}
