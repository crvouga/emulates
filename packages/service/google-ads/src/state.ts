import { Collection, IdSequence } from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"
import { sha256 } from "@noble/hashes/sha2.js"
import { int64, integer, invalid, present, record, text } from "./errors.js"
import type { Sealed, Vault } from "./vault.js"
export const DEFAULT_TOKEN = "fixture-google-ads-token"
export const DEFAULT_CUSTOMER = "1000000001"
export const DEFAULT_PROPERTY = "1000000001"
export const DEFAULT_MEASUREMENT = "G-FIXTURE"
export const DEFAULT_API_SECRET = "fixture-ga4-secret"
export const fingerprint = (v: unknown): string =>
  Array.from(sha256(new TextEncoder().encode(JSON.stringify(v))), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("")
export type CustomerFixture = {
  id: string
  descriptiveName: string
  currencyCode: string
  timeZone: string
  managerId?: string
}
export type BudgetFixture = {
  customerId: string
  id: string
  name: string
  amountMicros?: string
  totalAmountMicros?: string
  period?: "DAILY" | "CUSTOM_PERIOD"
  explicitlyShared?: boolean
  deliveryMethod?: "STANDARD"
  status?: "ENABLED" | "REMOVED"
}
export type Budget = BudgetFixture & {
  resourceName: string
  period: "DAILY" | "CUSTOM_PERIOD"
  explicitlyShared: boolean
  deliveryMethod: "STANDARD"
  status: "ENABLED" | "REMOVED"
}
export type CampaignFixture = {
  customerId: string
  id: string
  name: string
  budgetId: string
  status: "ENABLED" | "PAUSED" | "REMOVED"
}
export type ActionFixture = {
  customerId: string
  id: string
  name: string
  category: string
  type: string
  status: "ENABLED" | "REMOVED"
}
export type MetricFixture = {
  customerId: string
  campaignId: string
  date: string
  costMicros: string
  clicks: string
  impressions: string
  conversions: number
  conversionsValue: number
  conversionActionId?: string
  availableAt?: number
}
export type PropertyFixture = {
  id: string
  measurementId: string
  apiSecret: string
  currencyCode?: string
  timeZone?: string
}
export type PublicProperty = Omit<PropertyFixture, "apiSecret"> & {
  currencyCode: string
  timeZone: string
}
export type PrivateRecord = {
  id: string
  customerId?: string
  propertyId?: string
  createdAt: number
  availableAt: number
  fingerprint: string
  sealed: Sealed
}
export type Snapshot = {
  id: string
  customerId: string
  queryHash: string
  expiresAt: number
  sealed: Sealed
}
export type PageToken = { id: string; snapshotId: string; offset: number }
export type RequestMetadata = {
  id: string
  operationId: string
  createdAt: number
  bodyHash: string
  customerId?: string
  propertyId?: string
  eventCount?: number
  validateOnly?: boolean
  accepted?: number
  rejected?: number
  duplicate?: number
  reasons?: string[]
  developerTokenPresent: boolean
  loginCustomerPresent: boolean
}
export type Settings = {
  initialized: boolean
  nextBudgetId: string
  nextJobId: string
  reportingLagMs: number
  pageTokenTtlMs: number
  futureToleranceMs: number | null
  /** Synthetic test policy: Google fixes Search pages at 10000 rows and requests cannot change it. */
  searchPageSize: number
  /** Ambiguous-write faults that landed on a call which executed nothing and await the next write. */
  pendingAmbiguousWrites: number
}
export type PublicSettings = Pick<
  Settings,
  "reportingLagMs" | "pageTokenTtlMs" | "futureToleranceMs" | "searchPageSize"
>
const publicSettings = ["reportingLagMs", "pageTokenTtlMs", "futureToleranceMs", "searchPageSize"]
export type Fixtures = {
  customers?: readonly CustomerFixture[]
  budgets?: readonly BudgetFixture[]
  campaigns?: readonly CampaignFixture[]
  actions?: readonly ActionFixture[]
  metrics?: readonly MetricFixture[]
  properties?: readonly PropertyFixture[]
}
export const DEFAULT_CUSTOMERS: readonly CustomerFixture[] = [
  {
    id: DEFAULT_CUSTOMER,
    descriptiveName: "Fixture account",
    currencyCode: "USD",
    timeZone: "UTC",
    managerId: "1000000099",
  },
]
export const DEFAULT_BUDGETS: readonly BudgetFixture[] = [
  {
    customerId: DEFAULT_CUSTOMER,
    id: "2000000001",
    name: "Fixture shared budget",
    amountMicros: "25000000",
  },
]
export const DEFAULT_CAMPAIGNS: readonly CampaignFixture[] = [
  {
    customerId: DEFAULT_CUSTOMER,
    id: "3000000001",
    name: "Fixture campaign",
    budgetId: "2000000001",
    status: "ENABLED",
  },
]
export const DEFAULT_ACTIONS: readonly ActionFixture[] = [
  {
    customerId: DEFAULT_CUSTOMER,
    id: "4000000001",
    name: "Fixture purchase",
    category: "PURCHASE",
    type: "UPLOAD_CLICKS",
    status: "ENABLED",
  },
]
export const key = (customerId: string, id: string): string => `${customerId}/${id}`
export function normalizeBudget(value: BudgetFixture): Budget {
  const id = int64(value.id, "id", 1n),
    customerId = text(value.customerId, "customerId")
  const period = value.period ?? "DAILY",
    explicitlyShared = value.explicitlyShared ?? true
  if (!["DAILY", "CUSTOM_PERIOD"].includes(period) || typeof explicitlyShared !== "boolean")
    invalid("Invalid budget period or sharing")
  const name = typeof value.name === "string" ? value.name.trim() : ""
  if ((explicitlyShared && !name) || new TextEncoder().encode(name).length > 255)
    invalid("Invalid budget name", "name")
  if (value.amountMicros !== undefined && value.totalAmountMicros !== undefined)
    invalid("Daily and total amounts are mutually exclusive")
  if (
    (period === "DAILY" && value.totalAmountMicros !== undefined) ||
    (period === "CUSTOM_PERIOD" && value.amountMicros !== undefined)
  )
    invalid("Budget amount does not match period")
  if (value.deliveryMethod !== undefined && value.deliveryMethod !== "STANDARD")
    invalid("Unsupported delivery method")
  if (value.status !== undefined && !["ENABLED", "REMOVED"].includes(value.status))
    invalid("Invalid status")
  return {
    customerId,
    id,
    name,
    resourceName: `customers/${customerId}/campaignBudgets/${id}`,
    period,
    explicitlyShared,
    deliveryMethod: "STANDARD",
    status: value.status ?? "ENABLED",
    ...(value.amountMicros !== undefined
      ? { amountMicros: int64(value.amountMicros, "amountMicros") }
      : {}),
    ...(value.totalAmountMicros !== undefined
      ? { totalAmountMicros: int64(value.totalAmountMicros, "totalAmountMicros") }
      : {}),
  }
}
export function validateMetric(value: unknown): MetricFixture {
  const b = record(value)
  const date = text(b.date, "date")
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || new Date(date).toISOString().slice(0, 10) !== date)
    invalid("Invalid metric date")
  if (
    typeof b.conversions !== "number" ||
    !Number.isFinite(b.conversions) ||
    b.conversions < 0 ||
    typeof b.conversionsValue !== "number" ||
    !Number.isFinite(b.conversionsValue)
  )
    invalid("Invalid conversion metrics")
  return {
    customerId: text(b.customerId, "customerId"),
    campaignId: int64(b.campaignId, "campaignId", 1n),
    date,
    costMicros: int64(b.costMicros, "costMicros"),
    clicks: int64(b.clicks, "clicks"),
    impressions: int64(b.impressions, "impressions"),
    conversions: b.conversions,
    conversionsValue: b.conversionsValue,
    ...(b.conversionActionId !== undefined
      ? { conversionActionId: int64(b.conversionActionId, "conversionActionId", 1n) }
      : {}),
    ...(b.availableAt !== undefined ? { availableAt: integer(b.availableAt, "availableAt") } : {}),
  }
}
export class GoogleAdsState {
  readonly customers: Collection<CustomerFixture>
  readonly budgets: Collection<Budget>
  readonly campaigns: Collection<CampaignFixture>
  readonly actions: Collection<ActionFixture>
  readonly metrics: Collection<MetricFixture>
  readonly properties: Collection<PublicProperty>
  readonly conversions: Collection<PrivateRecord>
  readonly events: Collection<PrivateRecord>
  readonly snapshots: Collection<Snapshot>
  readonly pageTokens: Collection<PageToken>
  readonly requests: Collection<RequestMetadata>
  readonly mutations: Collection<{
    id: string
    requestId: string
    customerId: string
    resourceName: string
    before: Budget | null
    after: Budget
    createdAt: number
  }>
  readonly settings: Collection<Settings>
  readonly ids: IdSequence
  constructor(
    readonly sqlite: SqliteClient,
    readonly namespace: string,
    private readonly vault: Vault,
    private readonly publicNamespace = namespace,
  ) {
    this.customers = new Collection(sqlite, namespace, "customers")
    this.budgets = new Collection(sqlite, namespace, "budgets")
    this.campaigns = new Collection(sqlite, namespace, "campaigns")
    this.actions = new Collection(sqlite, namespace, "conversion_actions")
    this.metrics = new Collection(sqlite, namespace, "daily_metrics")
    this.properties = new Collection(sqlite, namespace, "properties")
    this.conversions = new Collection(sqlite, namespace, "conversions")
    this.events = new Collection(sqlite, namespace, "events")
    this.snapshots = new Collection(sqlite, namespace, "query_snapshots")
    this.pageTokens = new Collection(sqlite, namespace, "page_tokens")
    this.requests = new Collection(sqlite, namespace, "request_metadata")
    this.mutations = new Collection(sqlite, namespace, "budget_mutations")
    this.settings = new Collection(sqlite, namespace, "settings")
    this.ids = new IdSequence(sqlite, namespace)
  }
  seal(value: unknown, kind: string, id: string): Sealed {
    return this.vault.seal(value, JSON.stringify([this.publicNamespace, kind, id]))
  }
  open<T>(value: Sealed, kind: string, id: string): T {
    return this.vault.open<T>(value, JSON.stringify([this.publicNamespace, kind, id]))
  }
  configure(value: Partial<PublicSettings>): Settings {
    if (Object.keys(value).some((k) => !publicSettings.includes(k))) invalid("Unknown setting")
    const current = present(this.settings.get("settings"))
    const whole = (v: unknown, field: string, min = 0, max?: number): void => {
      if (typeof v !== "number") invalid(`Invalid ${field}`, field)
      integer(v, field, min, max)
    }
    if (value.reportingLagMs !== undefined) whole(value.reportingLagMs, "reportingLagMs")
    if (value.pageTokenTtlMs !== undefined) whole(value.pageTokenTtlMs, "pageTokenTtlMs", 1)
    if (value.futureToleranceMs !== undefined && value.futureToleranceMs !== null)
      whole(value.futureToleranceMs, "futureToleranceMs")
    if (value.searchPageSize !== undefined) whole(value.searchPageSize, "searchPageSize", 1, 10000)
    const next = { ...current, ...value }
    this.settings.update("settings", next)
    return next
  }
  view(): PublicSettings {
    const { reportingLagMs, pageTokenTtlMs, futureToleranceMs, searchPageSize } = present(
      this.settings.get("settings"),
    )
    return { reportingLagMs, pageTokenTtlMs, futureToleranceMs, searchPageSize }
  }
  /** Carry an ambiguous-write fault over to the next executed mutation. */
  deferAmbiguousWrite(): void {
    const current = present(this.settings.get("settings"))
    this.settings.update("settings", {
      ...current,
      pendingAmbiguousWrites: (current.pendingAmbiguousWrites ?? 0) + 1,
    })
  }
  takeAmbiguousWrite(): boolean {
    const current = present(this.settings.get("settings"))
    if (!current.pendingAmbiguousWrites) return false
    this.settings.update("settings", {
      ...current,
      pendingAmbiguousWrites: current.pendingAmbiguousWrites - 1,
    })
    return true
  }
}
