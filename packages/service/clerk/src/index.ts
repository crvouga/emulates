import {
  type ClerkSeedConfig,
  clerkPlugin,
  ProviderAPI,
  type ProviderOptions,
  seedClerk,
} from "@crvouga/mockingbird-http-provider"
import { document, operationIds, supportedOperationIds } from "./generated/openapi.js"

export type { SqliteClient } from "@crvouga/mockingbird-sqlite"
export const CLERK_NAMESPACE = "clerk"
export type ClerkAPIOptions = ProviderOptions & { fixtures?: ClerkSeedConfig }
export class ClerkAPI extends ProviderAPI {
  private readonly fixtures: ClerkSeedConfig | undefined
  constructor(options: ClerkAPIOptions = {}) {
    super(clerkPlugin, options)
    this.fixtures = options.fixtures
    if (options.fixtures && !this.store.meta.has("configured-fixtures"))
      this.seed(options.fixtures, seedClerk)
    if (options.fixtures) this.store.meta.insert("configured-fixtures", true)
  }
  override async reset(): Promise<void> {
    await super.reset()
    if (this.fixtures) {
      this.seed(this.fixtures, seedClerk)
      this.store.meta.insert("configured-fixtures", true)
    }
  }
}
export type { ClerkRuntime, ClerkRuntimeOptions } from "./runtime.js"
export { createRuntime } from "./runtime.js"
export { document, operationIds, supportedOperationIds }
