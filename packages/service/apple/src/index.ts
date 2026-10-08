import {
  type AppleSeedConfig,
  applePlugin,
  ProviderAPI,
  type ProviderOptions,
  seedApple,
} from "@crvouga/mockingbird-http-provider"
import { document, operationIds, supportedOperationIds } from "./generated/openapi.js"

export type { SqliteClient } from "@crvouga/mockingbird-sqlite"
export const APPLE_NAMESPACE = "apple"
export type AppleAPIOptions = ProviderOptions & { fixtures?: AppleSeedConfig }
export class AppleAPI extends ProviderAPI {
  private readonly fixtures: AppleSeedConfig | undefined
  constructor(options: AppleAPIOptions = {}) {
    super(applePlugin, options)
    this.fixtures = options.fixtures
    if (options.fixtures && !this.store.meta.has("configured-fixtures"))
      this.seed(options.fixtures, seedApple)
    if (options.fixtures) this.store.meta.insert("configured-fixtures", true)
  }
  override async reset(): Promise<void> {
    await super.reset()
    if (this.fixtures) {
      this.seed(this.fixtures, seedApple)
      this.store.meta.insert("configured-fixtures", true)
    }
  }
}
export type { AppleRuntime, AppleRuntimeOptions } from "./runtime.js"
export { createRuntime } from "./runtime.js"
export { document, operationIds, supportedOperationIds }
