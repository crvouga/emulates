import {
  type AwsSeedConfig,
  awsPlugin,
  ProviderAPI,
  type ProviderOptions,
  seedAws,
} from "@crvouga/mockingbird-http-provider"
import { document, operationIds, supportedOperationIds } from "./generated/openapi.js"

export type { SqliteClient } from "@crvouga/mockingbird-sqlite"
export const AWS_NAMESPACE = "aws"
export type AwsAPIOptions = ProviderOptions & { fixtures?: AwsSeedConfig }
export class AwsAPI extends ProviderAPI {
  private readonly fixtures: AwsSeedConfig | undefined
  constructor(options: AwsAPIOptions = {}) {
    super(awsPlugin, options)
    this.fixtures = options.fixtures
    if (options.fixtures && !this.store.meta.has("configured-fixtures"))
      this.seed(options.fixtures, seedAws)
    if (options.fixtures) this.store.meta.insert("configured-fixtures", true)
  }
  override async reset(): Promise<void> {
    await super.reset()
    if (this.fixtures) {
      this.seed(this.fixtures, seedAws)
      this.store.meta.insert("configured-fixtures", true)
    }
  }
}
export type { AwsRuntime, AwsRuntimeOptions } from "./runtime.js"
export { createRuntime } from "./runtime.js"
export { document, operationIds, supportedOperationIds }
