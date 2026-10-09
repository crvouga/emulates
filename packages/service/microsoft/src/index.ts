import {
  type MicrosoftSeedConfig,
  microsoftPlugin,
  ProviderAPI,
  type ProviderOptions,
  seedMicrosoft,
} from "@crvouga/mockingbird-http-provider"
import { document, operationIds, supportedOperationIds } from "./generated/openapi.js"

export type { SqliteClient } from "@crvouga/mockingbird-sqlite"
export const MICROSOFT_NAMESPACE = "microsoft"
export type MicrosoftAPIOptions = ProviderOptions & { fixtures?: MicrosoftSeedConfig }
export class MicrosoftAPI extends ProviderAPI {
  private readonly fixtures: MicrosoftSeedConfig | undefined
  constructor(options: MicrosoftAPIOptions = {}) {
    super(microsoftPlugin, options)
    this.fixtures = options.fixtures
    if (options.fixtures && !this.store.meta.has("configured-fixtures"))
      this.seed(options.fixtures, seedMicrosoft)
    if (options.fixtures) this.store.meta.insert("configured-fixtures", true)
  }
  override async reset(): Promise<void> {
    await super.reset()
    if (this.fixtures) {
      this.seed(this.fixtures, seedMicrosoft)
      this.store.meta.insert("configured-fixtures", true)
    }
  }
}
export type { MicrosoftRuntime, MicrosoftRuntimeOptions } from "./runtime.js"
export { createRuntime } from "./runtime.js"
export { document, operationIds, supportedOperationIds }
