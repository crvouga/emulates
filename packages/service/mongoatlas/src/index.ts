import {
  type MongoAtlasSeedConfig,
  mongoatlasPlugin,
  ProviderAPI,
  type ProviderOptions,
  seedMongoatlas,
} from "@crvouga/mockingbird-http-provider"
import { document, operationIds, supportedOperationIds } from "./generated/openapi.js"

export type { SqliteClient } from "@crvouga/mockingbird-sqlite"
export const MONGOATLAS_NAMESPACE = "mongoatlas"
export type MongoAtlasAPIOptions = ProviderOptions & { fixtures?: MongoAtlasSeedConfig }
export class MongoAtlasAPI extends ProviderAPI {
  private readonly fixtures: MongoAtlasSeedConfig | undefined
  constructor(options: MongoAtlasAPIOptions = {}) {
    super(mongoatlasPlugin, options)
    this.fixtures = options.fixtures
    if (options.fixtures && !this.store.meta.has("configured-fixtures"))
      this.seed(options.fixtures, seedMongoatlas)
    if (options.fixtures) this.store.meta.insert("configured-fixtures", true)
  }
  override async reset(): Promise<void> {
    await super.reset()
    if (this.fixtures) {
      this.seed(this.fixtures, seedMongoatlas)
      this.store.meta.insert("configured-fixtures", true)
    }
  }
}
export type { MongoAtlasRuntime, MongoAtlasRuntimeOptions } from "./runtime.js"
export { createRuntime } from "./runtime.js"
export { document, operationIds, supportedOperationIds }
