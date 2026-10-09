import {
  ProviderAPI,
  type ProviderOptions,
  seedVercel,
  type VercelSeedConfig,
  vercelPlugin,
} from "@crvouga/mockingbird-http-provider"
import { document, operationIds, supportedOperationIds } from "./generated/openapi.js"

export type { SqliteClient } from "@crvouga/mockingbird-sqlite"
export const VERCEL_NAMESPACE = "vercel"
export type VercelAPIOptions = ProviderOptions & { fixtures?: VercelSeedConfig }
export class VercelAPI extends ProviderAPI {
  private readonly fixtures: VercelSeedConfig | undefined
  constructor(options: VercelAPIOptions = {}) {
    super(vercelPlugin, options)
    this.fixtures = options.fixtures
    if (options.fixtures && !this.store.meta.has("configured-fixtures"))
      this.seed(options.fixtures, seedVercel)
    if (options.fixtures) this.store.meta.insert("configured-fixtures", true)
  }
  override async reset(): Promise<void> {
    await super.reset()
    if (this.fixtures) {
      this.seed(this.fixtures, seedVercel)
      this.store.meta.insert("configured-fixtures", true)
    }
  }
}
export type { VercelRuntime, VercelRuntimeOptions } from "./runtime.js"
export { createRuntime } from "./runtime.js"
export { document, operationIds, supportedOperationIds }
