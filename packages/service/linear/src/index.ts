import {
  type LinearSeedConfig,
  linearPlugin,
  ProviderAPI,
  type ProviderOptions,
  seedLinear,
} from "@crvouga/mockingbird-http-provider"
import { document, operationIds, supportedOperationIds } from "./generated/openapi.js"

export type { SqliteClient } from "@crvouga/mockingbird-sqlite"
export const LINEAR_NAMESPACE = "linear"
export type LinearAPIOptions = ProviderOptions & { fixtures?: LinearSeedConfig }
export class LinearAPI extends ProviderAPI {
  private readonly fixtures: LinearSeedConfig | undefined
  constructor(options: LinearAPIOptions = {}) {
    super(linearPlugin, options)
    this.fixtures = options.fixtures
    if (options.fixtures && !this.store.meta.has("configured-fixtures"))
      this.seed(options.fixtures, seedLinear)
    if (options.fixtures) this.store.meta.insert("configured-fixtures", true)
  }
  override async reset(): Promise<void> {
    await super.reset()
    if (this.fixtures) {
      this.seed(this.fixtures, seedLinear)
      this.store.meta.insert("configured-fixtures", true)
    }
  }
}
export type { LinearRuntime, LinearRuntimeOptions } from "./runtime.js"
export { createRuntime } from "./runtime.js"
export { document, operationIds, supportedOperationIds }
