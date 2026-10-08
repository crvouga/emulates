import {
  type GoogleSeedConfig,
  googlePlugin,
  ProviderAPI,
  type ProviderOptions,
  seedGoogle,
} from "@crvouga/mockingbird-http-provider"
import { document, operationIds, supportedOperationIds } from "./generated/openapi.js"

export type { SqliteClient } from "@crvouga/mockingbird-sqlite"
export const GOOGLE_NAMESPACE = "google"
export type GoogleAPIOptions = ProviderOptions & { fixtures?: GoogleSeedConfig }
export class GoogleAPI extends ProviderAPI {
  private readonly fixtures: GoogleSeedConfig | undefined
  constructor(options: GoogleAPIOptions = {}) {
    super(googlePlugin, options)
    this.fixtures = options.fixtures
    if (options.fixtures && !this.store.meta.has("configured-fixtures"))
      this.seed(options.fixtures, seedGoogle)
    if (options.fixtures) this.store.meta.insert("configured-fixtures", true)
  }
  override async reset(): Promise<void> {
    await super.reset()
    if (this.fixtures) {
      this.seed(this.fixtures, seedGoogle)
      this.store.meta.insert("configured-fixtures", true)
    }
  }
}
export type { GoogleRuntime, GoogleRuntimeOptions } from "./runtime.js"
export { createRuntime } from "./runtime.js"
export { document, operationIds, supportedOperationIds }
