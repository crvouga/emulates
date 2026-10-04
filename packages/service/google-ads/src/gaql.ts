import { present, reject } from "./errors.js"
import { type GoogleAdsState, key } from "./state.js"
export type WireRow = Record<string, Record<string, unknown>>
type FlatRow = Record<string, string | number | boolean | undefined>
type Token = { value: string; quoted: boolean }
type Condition = { field: string; op: string; values: string[] }
type Query = {
  fields: string[]
  entity: string
  conditions: Condition[]
  order: { field: string; desc: boolean }[]
  limit?: number
}
const entityFields: Record<string, readonly string[]> = {
  customer: ["id", "resource_name", "descriptive_name", "currency_code", "time_zone"],
  campaign: ["id", "resource_name", "name", "status", "campaign_budget"],
  campaign_budget: [
    "id",
    "resource_name",
    "name",
    "status",
    "amount_micros",
    "total_amount_micros",
    "period",
    "explicitly_shared",
    "delivery_method",
    "reference_count",
  ],
  conversion_action: ["id", "resource_name", "name", "category", "type", "status"],
  metrics: ["cost_micros", "clicks", "impressions", "conversions", "conversions_value"],
  segments: ["date", "conversion_action", "conversion_action_category"],
}
const known = new Set(
  Object.entries(entityFields).flatMap(([entity, fields]) => fields.map((f) => `${entity}.${f}`)),
)
function queryError(code: string, message: string): never {
  return reject(code, message, "queryError")
}
function tokenize(input: string): Token[] {
  const tokens: Token[] = []
  let pos = 0
  while (pos < input.length) {
    const tail = input.slice(pos)
    const ws = /^\s+/.exec(tail)
    if (ws) {
      pos += ws[0].length
      continue
    }
    const str = /^(['"])((?:\\.|(?!\1)[^\\])*)\1/.exec(tail)
    if (str) {
      tokens.push({ value: present(str[2]).replace(/\\(['"\\])/g, "$1"), quoted: true })
      pos += str[0].length
      continue
    }
    const match = /^(?:[A-Za-z_][A-Za-z0-9_.]*|-?\d+(?:\.\d+)?|>=|<=|!=|=|>|<|,|\(|\))/.exec(tail)
    if (!match) queryError("BAD_SYMBOL", "Query contains an unsupported symbol")
    tokens.push({ value: match[0], quoted: false })
    pos += match[0].length
  }
  return tokens
}
export function parseGAQL(input: string): Query {
  const tokens = tokenize(input)
  let pos = 0
  const peek = (): string =>
    tokens[pos]?.quoted ? "<literal>" : (tokens[pos]?.value.toUpperCase() ?? "")
  const eat = (value: string): boolean => {
    if (peek() !== value) return false
    pos++
    return true
  }
  const require = (value: string): void => {
    if (!eat(value)) queryError("UNEXPECTED_INPUT", `Expected ${value}`)
  }
  const field = (): string => {
    const t = tokens[pos++]
    if (!t || t.quoted || !known.has(t.value))
      queryError("UNRECOGNIZED_FIELD", "Unrecognized or unsupported field")
    return t.value
  }
  const literal = (): string => {
    const t = tokens[pos++]
    if (!t || (!t.quoted && !/^(?:-?\d+(?:\.\d+)?|[A-Z][A-Z_0-9]*)$/.test(t.value)))
      queryError("BAD_VALUE", "Expected a literal value")
    return t.value
  }
  require("SELECT")
  const fields = [field()]
  while (eat(",")) fields.push(field())
  if (new Set(fields).size !== fields.length)
    queryError("PROHIBITED_FIELD_COMBINATION_IN_SELECT_CLAUSE", "Duplicate selected fields")
  require("FROM")
  const entity = tokens[pos++]?.value ?? ""
  if (!["customer", "campaign", "campaign_budget", "conversion_action"].includes(entity))
    queryError("BAD_RESOURCE_TYPE_IN_FROM_CLAUSE", "Unsupported resource in FROM")
  const permitted = new Set([
    entity,
    "customer",
    ...(entity === "campaign"
      ? ["campaign_budget", "conversion_action", "metrics", "segments"]
      : []),
  ])
  const checkField = (f: string): void => {
    if (!permitted.has(present(f.split(".")[0])))
      queryError("PROHIBITED_FIELD_IN_SELECT_CLAUSE", "Field is not available for this resource")
  }
  fields.forEach(checkField)
  const conditions: Condition[] = []
  if (eat("WHERE")) {
    do {
      const f = field()
      checkField(f)
      let op = tokens[pos++]?.value.toUpperCase() ?? ""
      if (op === "NOT") {
        require("IN")
        op = "NOT IN"
      }
      const values: string[] = []
      if (op === "IN" || op === "NOT IN") {
        require("(")
        values.push(literal())
        while (eat(",")) values.push(literal())
        require(")")
      } else if (op === "BETWEEN") {
        values.push(literal())
        require("AND")
        values.push(literal())
      } else if (op === "DURING") {
        if (f !== "segments.date")
          queryError("INVALID_VALUE_WITH_DURING_OPERATOR", "DURING requires segments.date")
        values.push(literal())
      } else if (["=", "!=", ">", "<", ">=", "<="].includes(op)) values.push(literal())
      else queryError("BAD_OPERATOR", "Unsupported query operator")
      conditions.push({ field: f, op, values })
    } while (eat("AND"))
  }
  const order: Query["order"] = []
  if (eat("ORDER")) {
    require("BY")
    do {
      const f = field()
      checkField(f)
      const desc = eat("DESC")
      if (!desc) eat("ASC")
      order.push({ field: f, desc })
    } while (eat(","))
  }
  let limit: number | undefined
  if (eat("LIMIT")) {
    const value = tokens[pos++]
    if (
      !value ||
      value.quoted ||
      !/^\d+$/.test(value.value) ||
      !Number.isSafeInteger(Number(value.value)) ||
      Number(value.value) <= 0
    )
      queryError("BAD_LIMIT_VALUE", "LIMIT must be a positive integer")
    limit = Number(value.value)
  }
  if (pos !== tokens.length) queryError("UNEXPECTED_INPUT", "Unexpected trailing query input")
  return { fields, entity, conditions, order, ...(limit !== undefined ? { limit } : {}) }
}
const camel = (s: string): string => s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())
const compare = (a: unknown, b: unknown): number => {
  if (a === b) return 0
  if (typeof a === "string" && typeof b === "string" && /^-?\d+$/.test(a) && /^-?\d+$/.test(b))
    return BigInt(a) < BigInt(b) ? -1 : 1
  if (
    (typeof a === "number" || typeof a === "boolean") &&
    (typeof b === "string" || typeof b === "number" || typeof b === "boolean")
  ) {
    const x = typeof a === "boolean" ? Number(a) : a,
      y = b === "TRUE" ? 1 : b === "FALSE" ? 0 : Number(b)
    if (Number.isFinite(y)) return x === y ? 0 : x < y ? -1 : 1
  }
  return String(a ?? "") < String(b ?? "") ? -1 : 1
}
function during(name: string, now: number): [string, string] {
  const midnight = new Date(new Date(now).toISOString().slice(0, 10)).getTime(),
    day = 86400000
  const iso = (n: number): string => new Date(n).toISOString().slice(0, 10)
  switch (name) {
    case "TODAY":
      return [iso(midnight), iso(midnight)]
    case "YESTERDAY":
      return [iso(midnight - day), iso(midnight - day)]
    case "LAST_7_DAYS":
      return [iso(midnight - 7 * day), iso(midnight - day)]
    case "LAST_30_DAYS":
      return [iso(midnight - 30 * day), iso(midnight - day)]
    case "THIS_MONTH":
      return [`${iso(midnight).slice(0, 7)}-01`, iso(midnight)]
    case "LAST_MONTH": {
      const start = new Date(`${iso(midnight).slice(0, 7)}-01`).getTime()
      return [`${iso(start - day).slice(0, 7)}-01`, iso(start - day)]
    }
    default:
      return queryError("INVALID_VALUE_WITH_DURING_OPERATOR", "Unsupported DURING date range")
  }
}
function matches(row: FlatRow, c: Condition, now: number): boolean {
  const v = row[c.field]
  if (v === undefined) return false
  if (c.op === "IN" || c.op === "NOT IN") {
    const includes = c.values.some((x) => compare(v, x) === 0)
    return c.op === "IN" ? includes : !includes
  }
  if (c.op === "BETWEEN" || c.op === "DURING") {
    const range = c.op === "DURING" ? during(present(c.values[0]), now) : c.values
    return compare(v, range[0]) >= 0 && compare(v, range[1]) <= 0
  }
  const n = compare(v, c.values[0])
  switch (c.op) {
    case "=":
      return n === 0
    case "!=":
      return n !== 0
    case ">":
      return n > 0
    case "<":
      return n < 0
    case ">=":
      return n >= 0
    case "<=":
      return n <= 0
    default:
      return false
  }
}
function addObject(row: FlatRow, entity: string, value: Record<string, unknown>): void {
  for (const field of entityFields[entity] ?? []) {
    const v = value[camel(field)]
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean")
      row[`${entity}.${field}`] = v
  }
}
function project(row: FlatRow, fields: readonly string[]): WireRow {
  const out: WireRow = {}
  for (const f of fields) {
    const [entity, field] = f.split(".") as [string, string]
    const v = row[f]
    if (v !== undefined) {
      const target = out[camel(entity)] ?? {}
      target[camel(field)] = v
      out[camel(entity)] = target
    }
  }
  return out
}
/** Bounded GAQL implementation: filters precede aggregation; int64 sums never pass through Number. */
export function executeGAQL(
  state: GoogleAdsState,
  customerId: string,
  input: string,
  now: number,
): { results: WireRow[]; fieldMask: string; summaryRow: WireRow } {
  const query = parseGAQL(input)
  const customer = present(state.customers.get(customerId))
  const base = (): FlatRow => {
    const r: FlatRow = {}
    addObject(r, "customer", { ...customer, resourceName: `customers/${customerId}` })
    return r
  }
  let rows: FlatRow[] = []
  const metricsNeeded = [
    ...query.fields,
    ...query.conditions.map((c) => c.field),
    ...query.order.map((o) => o.field),
  ].some((f) => /^(metrics|segments|conversion_action)\./.test(f))
  const references = new Map<string, number>()
  for (const { value: c } of state.campaigns.list({
    where: (c) => c.customerId === customerId && c.status !== "REMOVED",
  }))
    references.set(c.budgetId, (references.get(c.budgetId) ?? 0) + 1)
  const metricsByCampaign = new Map<string, import("./state.js").MetricFixture[]>()
  if (metricsNeeded)
    for (const { value: m } of state.metrics.list({
      order: "oldest",
      where: (m) => m.customerId === customerId && (m.availableAt ?? 0) <= now,
    })) {
      const group = metricsByCampaign.get(m.campaignId) ?? []
      group.push(m)
      metricsByCampaign.set(m.campaignId, group)
    }
  if (query.entity === "campaign") {
    for (const { value: campaign } of state.campaigns.list({
      order: "oldest",
      where: (v) => v.customerId === customerId,
    })) {
      const row = base()
      addObject(row, "campaign", {
        ...campaign,
        resourceName: `customers/${customerId}/campaigns/${campaign.id}`,
        campaignBudget: `customers/${customerId}/campaignBudgets/${campaign.budgetId}`,
      })
      const budget = state.budgets.get(key(customerId, campaign.budgetId))
      if (budget)
        addObject(row, "campaign_budget", {
          ...budget,
          referenceCount: String(references.get(budget.id) ?? 0),
        })
      if (!metricsNeeded) {
        rows.push(row)
        continue
      }
      for (const metric of metricsByCampaign.get(campaign.id) ?? []) {
        const next = { ...row }
        addObject(next, "metrics", metric)
        next["segments.date"] = metric.date
        if (metric.conversionActionId) {
          next["segments.conversion_action"] =
            `customers/${customerId}/conversionActions/${metric.conversionActionId}`
          const action = state.actions.get(key(customerId, metric.conversionActionId))
          if (action) {
            next["segments.conversion_action_category"] = action.category
            addObject(next, "conversion_action", {
              ...action,
              resourceName: next["segments.conversion_action"],
            })
          }
        }
        rows.push(next)
      }
    }
  } else if (query.entity === "campaign_budget") {
    rows = state.budgets
      .list({ order: "oldest", where: (v) => v.customerId === customerId })
      .map(({ value: b }) => {
        const row = base()
        addObject(row, "campaign_budget", {
          ...b,
          referenceCount: String(references.get(b.id) ?? 0),
        })
        return row
      })
  } else if (query.entity === "conversion_action") {
    rows = state.actions
      .list({ order: "oldest", where: (v) => v.customerId === customerId })
      .map(({ value: a }) => {
        const row = base()
        addObject(row, "conversion_action", {
          ...a,
          resourceName: `customers/${customerId}/conversionActions/${a.id}`,
        })
        return row
      })
  } else rows = [base()]
  rows = rows.filter((row) => query.conditions.every((c) => matches(row, c, now)))
  const sum = (group: FlatRow[]): FlatRow => {
    const out = { ...group[0] }
    for (const f of present(entityFields.metrics)) {
      const name = `metrics.${f}`
      out[name] = ["cost_micros", "clicks", "impressions"].includes(f)
        ? group.reduce((acc, row) => acc + BigInt(String(row[name] ?? "0")), 0n).toString()
        : group.reduce((acc, row) => acc + Number(row[name] ?? 0), 0)
    }
    return out
  }
  const summaryRow = project(
    sum(rows),
    query.fields.filter((f) => f.startsWith("metrics.")),
  )
  if (metricsNeeded) {
    const groups = new Map<string, FlatRow[]>()
    const groupFields = [
      ...new Set([
        "campaign.id",
        ...query.fields.filter((f) => !f.startsWith("metrics.")),
        ...query.order.filter((o) => !o.field.startsWith("metrics.")).map((o) => o.field),
      ]),
    ]
    for (const row of rows) {
      const groupKey = JSON.stringify(groupFields.map((f) => row[f]))
      const group = groups.get(groupKey) ?? []
      group.push(row)
      groups.set(groupKey, group)
    }
    rows = [...groups.values()].map(sum)
  }
  if (query.order.length)
    rows.sort((a, b) => {
      for (const o of query.order) {
        const n = compare(a[o.field], b[o.field])
        if (n) return o.desc ? -n : n
      }
      return 0
    })
  if (query.limit !== undefined) rows = rows.slice(0, query.limit)
  return {
    results: rows.map((row) => project(row, query.fields)),
    fieldMask: query.fields.map((f) => f.split(".").map(camel).join(".")).join(","),
    summaryRow,
  }
}
