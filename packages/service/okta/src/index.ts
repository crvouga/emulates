import {
  type OktaSeedConfig,
  oktaPlugin,
  ProviderAPI,
  type ProviderOptions,
  seedOkta,
} from "@crvouga/mockingbird-http-provider"
import { document, operationIds, supportedOperationIds } from "./generated/openapi.js"

export type { SqliteClient } from "@crvouga/mockingbird-sqlite"
export const OKTA_NAMESPACE = "okta"
export type OktaAPIOptions = ProviderOptions & { fixtures?: OktaSeedConfig }
export class OktaAPI extends ProviderAPI {
  private readonly fixtures: OktaSeedConfig | undefined
  constructor(options: OktaAPIOptions = {}) {
    super(oktaPlugin, options)
    this.fixtures = options.fixtures
    if (options.fixtures && !this.store.meta.has("configured-fixtures"))
      this.seed(options.fixtures, seedOkta)
    if (options.fixtures) this.store.meta.insert("configured-fixtures", true)
  }
  override async reset(): Promise<void> {
    await super.reset()
    if (this.fixtures) {
      this.seed(this.fixtures, seedOkta)
      this.store.meta.insert("configured-fixtures", true)
    }
  }
}
export type { OktaRuntime, OktaRuntimeOptions } from "./runtime.js"
export { createRuntime } from "./runtime.js"
export { document, operationIds, supportedOperationIds }
