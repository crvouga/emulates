import { flag, integer, invalid, present, record, rpcError, text } from "./errors.js"
import { fingerprint, type GoogleAdsState, type PropertyFixture } from "./state.js"
export type ValidationMessage = { fieldPath: string; description: string; validationCode: string }
export type AnalyticsEvent = {
  client_id: string
  user_id?: string
  timestamp_micros: number
  event: { name: string; params: Record<string, unknown> }
  request_timestamp_micros?: number
}
const names = /^[A-Za-z][A-Za-z0-9_]{0,39}$/
const reserved = /^(?:firebase_|google_|ga_)/
const micros = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v > 0
export class AnalyticsEngine {
  private readonly credentials: readonly PropertyFixture[]
  constructor(
    readonly state: GoogleAdsState,
    private readonly now: () => number,
    properties: readonly PropertyFixture[],
  ) {
    this.credentials = structuredClone(properties)
  }
  collect(
    url: URL,
    input: unknown,
    malformed = false,
    debug = false,
  ): {
    response: Response
    accepted: number
    rejected: number
    duplicate: number
    reasons: string[]
    propertyId?: string
    eventCount: number
  } {
    const b = record(input),
      messages: ValidationMessage[] = []
    const add = (
      fieldPath: string,
      description: string,
      validationCode = "VALUE_INVALID",
    ): void => {
      messages.push({ fieldPath, description, validationCode })
    }
    const property = this.credentials.find(
      (p) => p.measurementId === url.searchParams.get("measurement_id"),
    )
    if (malformed || !Object.keys(b).length) add("", "Payload must be a JSON object")
    if (typeof b.client_id !== "string" || !b.client_id)
      add("client_id", "client_id is required", "VALUE_REQUIRED")
    if (b.user_id !== undefined && (typeof b.user_id !== "string" || !b.user_id))
      add("user_id", "user_id must be a non-empty string")
    if (b.timestamp_micros !== undefined && !micros(b.timestamp_micros))
      add("timestamp_micros", "timestamp_micros must be a positive integer")
    if (
      b.validation_behavior !== undefined &&
      !["RELAXED", "ENFORCE_RECOMMENDATIONS"].includes(String(b.validation_behavior))
    )
      add("validation_behavior", "Invalid validation behavior")
    if (!Array.isArray(b.events) || !b.events.length)
      add("events", "At least one event is required", "VALUE_REQUIRED")
    if (Array.isArray(b.events) && b.events.length > 25)
      add("events", "At most 25 events are supported per request", "EXCEEDED_MAX_ENTITIES")
    const globalInvalid = messages.length > 0
    const candidates: AnalyticsEvent[] = []
    const eventValues: unknown[] = Array.isArray(b.events) ? b.events : []
    let rejected = 0,
      duplicate = 0
    const settings = present(this.state.settings.get("settings")),
      oldest = this.now() - 72 * 3600000
    for (let i = 0; i < eventValues.length; i++) {
      const e = record(eventValues[i]),
        start = messages.length,
        prefix = `events[${i}]`
      if (typeof e.name !== "string" || !names.test(e.name))
        add(
          `${prefix}.name`,
          "Event name must begin with a letter and contain at most 40 letters, digits or underscores",
          "NAME_INVALID",
        )
      else if (reserved.test(e.name))
        add(`${prefix}.name`, "Event name has a reserved prefix", "NAME_RESERVED")
      const params = record(e.params)
      if (
        e.params !== undefined &&
        (e.params === null || typeof e.params !== "object" || Array.isArray(e.params))
      )
        add(`${prefix}.params`, "params must be an object")
      if (Object.keys(params).length > 25)
        add(`${prefix}.params`, "At most 25 event parameters are allowed", "EXCEEDED_MAX_ENTITIES")
      for (const [name, value] of Object.entries(params)) {
        if (!names.test(name))
          add(`${prefix}.params.${name}`, "Invalid parameter name", "NAME_INVALID")
        else if (reserved.test(name))
          add(`${prefix}.params.${name}`, "Reserved parameter name", "NAME_RESERVED")
        if (typeof value === "number" && !Number.isFinite(value))
          add(`${prefix}.params.${name}`, "Parameter must be finite")
      }
      if (e.timestamp_micros !== undefined && !micros(e.timestamp_micros))
        add(`${prefix}.timestamp_micros`, "timestamp_micros must be a positive integer")
      let timestamp = micros(e.timestamp_micros)
        ? e.timestamp_micros
        : micros(b.timestamp_micros)
          ? b.timestamp_micros
          : this.now() * 1000
      if (
        settings.futureToleranceMs !== null &&
        timestamp > (this.now() + settings.futureToleranceMs) * 1000
      )
        add(
          `${prefix}.timestamp_micros`,
          "Timestamp exceeds the configured local future tolerance",
          "VALUE_OUT_OF_BOUNDS",
        )
      if (timestamp < oldest * 1000) {
        if (b.validation_behavior === "ENFORCE_RECOMMENDATIONS")
          add(
            `${prefix}.timestamp_micros`,
            "Timestamp is older than 72 hours",
            "VALUE_OUT_OF_BOUNDS",
          )
        else timestamp = oldest * 1000
      }
      if (globalInvalid || messages.length !== start) {
        rejected++
        continue
      }
      candidates.push({
        client_id: b.client_id as string,
        ...(typeof b.user_id === "string" ? { user_id: b.user_id } : {}),
        timestamp_micros: timestamp,
        ...(micros(b.timestamp_micros) ? { request_timestamp_micros: b.timestamp_micros } : {}),
        event: { name: e.name as string, params: structuredClone(params) },
      })
    }
    if (debug)
      return {
        response: Response.json({ validationMessages: messages }),
        accepted: 0,
        rejected,
        duplicate: 0,
        reasons: messages.map((m) => m.validationCode),
        eventCount: eventValues.length,
        ...(property ? { propertyId: property.id } : {}),
      }
    const authorized =
      property !== undefined && property.apiSecret === url.searchParams.get("api_secret")
    let accepted = 0
    if (authorized)
      this.state.sqlite.transaction(() => {
        const prior = this.state.events
          .list({ where: (r) => r.propertyId === property.id })
          .map(({ value }) => this.state.open<AnalyticsEvent>(value.sealed, "event", value.id))
        for (const event of candidates) {
          const transaction = event.event.params.transaction_id
          if (
            event.event.name === "purchase" &&
            typeof transaction === "string" &&
            prior.some(
              (p) =>
                p.event.name === "purchase" &&
                (p.user_id ?? p.client_id) === (event.user_id ?? event.client_id) &&
                p.event.params.transaction_id === transaction,
            )
          ) {
            duplicate++
            continue
          }
          const id = this.state.ids.next("event_")
          this.state.events.insert(id, {
            id,
            propertyId: property.id,
            createdAt: this.now(),
            availableAt: this.now() + settings.reportingLagMs,
            fingerprint: fingerprint(event),
            sealed: this.state.seal(event, "event", id),
          })
          prior.push(event)
          accepted++
        }
      })
    const reasons = messages.map((m) => m.validationCode)
    if (!authorized) {
      rejected = eventValues.length
      reasons.push("INVALID_MEASUREMENT_CREDENTIALS")
    } else if (globalInvalid && !eventValues.length) rejected = 1
    return {
      response: new Response(null, { status: 204 }),
      accepted,
      rejected,
      duplicate,
      reasons,
      eventCount: eventValues.length,
      ...(property ? { propertyId: property.id } : {}),
    }
  }
  report(propertyId: string, body: Record<string, unknown>): Response {
    try {
      return Response.json(this.reportValue(propertyId, body))
    } catch (e) {
      if (e instanceof Error) return rpcError(400, e.message)
      throw e
    }
  }
  reportValue(propertyId: string, body: Record<string, unknown>): Record<string, unknown> {
    const property = this.state.properties.get(propertyId)
    if (!property) invalid("Property was not found")
    if (body.property !== undefined && body.property !== `properties/${propertyId}`)
      invalid("Request property must match the batch property")
    const unsupported = ["cohortSpec", "comparisons", "metricAggregations", "returnPropertyQuota"]
    if (unsupported.some((f) => body[f] !== undefined && body[f] !== false))
      invalid("Requested report feature is outside the supported subset")
    if (body.currencyCode !== undefined && body.currencyCode !== property.currencyCode)
      invalid("Currency conversion is not modelled; use the property's fixture currency")
    const dimensions =
      body.dimensions === undefined
        ? []
        : Array.isArray(body.dimensions)
          ? body.dimensions.map((d) => text(record(d).name, "dimensions.name"))
          : invalid("dimensions must be an array")
    const allowedDimensions = ["date", "eventName", "transactionId", "currency", "dateRange"]
    if (
      dimensions.some((d) => !allowedDimensions.includes(d)) ||
      new Set(dimensions).size !== dimensions.length ||
      dimensions.length > 9
    )
      invalid("Unsupported or duplicate dimension")
    if (!Array.isArray(body.metrics) || !body.metrics.length || body.metrics.length > 10)
      invalid("At least one metric is required")
    const metrics = body.metrics.map((m) => text(record(m).name, "metrics.name"))
    const metricTypes: Record<string, string> = {
      eventCount: "TYPE_INTEGER",
      ecommercePurchases: "TYPE_INTEGER",
      purchaseRevenue: "TYPE_CURRENCY",
      grossPurchaseRevenue: "TYPE_CURRENCY",
      refundAmount: "TYPE_CURRENCY",
      totalRevenue: "TYPE_CURRENCY",
    }
    if (metrics.some((m) => !metricTypes[m]) || new Set(metrics).size !== metrics.length)
      invalid("Unsupported or duplicate metric")
    const date = (value: unknown): string => {
      const v = text(value, "dateRange")
      let n: number
      if (v === "today") n = this.now()
      else if (v === "yesterday") n = this.now() - 86400000
      else if (/^\d+daysAgo$/.test(v)) n = this.now() - Number(v.slice(0, -7)) * 86400000
      else if (/^\d{4}-\d{2}-\d{2}$/.test(v)) n = Date.parse(v)
      else return invalid("Invalid date range")
      if (!Number.isFinite(n)) invalid("Invalid date range")
      const result = new Date(n).toISOString().slice(0, 10)
      if (/^\d{4}/.test(v) && result !== v) invalid("Invalid date range")
      return result.replaceAll("-", "")
    }
    const rawRanges = body.dateRanges ?? [{ startDate: "28daysAgo", endDate: "today" }]
    if (!Array.isArray(rawRanges) || !rawRanges.length || rawRanges.length > 4)
      invalid("One to four date ranges are required")
    const ranges = rawRanges.map((r, index) => {
      const b = record(r),
        start = date(b.startDate),
        end = date(b.endDate)
      if (start > end) invalid("Date range is reversed")
      return { start, end, name: typeof b.name === "string" ? b.name : `date_range_${index}` }
    })
    const actualDimensions =
      ranges.length > 1 && !dimensions.includes("dateRange")
        ? [...dimensions, "dateRange"]
        : dimensions
    const offset = integer(body.offset ?? "0", "offset"),
      limit = Math.min(integer(body.limit ?? "10000", "limit", 1), 250000)
    const keepEmpty = flag(body.keepEmptyRows, "keepEmptyRows")
    const dimensionFilter = compileFilter(body.dimensionFilter, new Set(actualDimensions))
    const metricFilter = compileFilter(body.metricFilter, new Set(metrics))
    const groups = new Map<
      string,
      { dimensions: Record<string, string>; metrics: Record<string, number> }
    >()
    const formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone: property.timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    })
    for (const { value: row } of this.state.events.list({
      order: "oldest",
      where: (e) => e.propertyId === propertyId && e.availableAt <= this.now(),
    })) {
      const event = this.state.open<AnalyticsEvent>(row.sealed, "event", row.id)
      const parts = formatter.formatToParts(new Date(event.timestamp_micros / 1000)),
        get = (type: string): string => present(parts.find((p) => p.type === type)).value
      const eventDate = `${get("year")}${get("month")}${get("day")}`,
        params = event.event.params
      for (const range of ranges) {
        if (eventDate < range.start || eventDate > range.end) continue
        const allDims: Record<string, string> = {
          date: eventDate,
          eventName: event.event.name,
          transactionId:
            typeof params.transaction_id === "string" ? params.transaction_id : "(not set)",
          currency: typeof params.currency === "string" ? params.currency : "(not set)",
          dateRange: range.name,
        }
        if (!dimensionFilter(allDims)) continue
        const dim = Object.fromEntries(actualDimensions.map((d) => [d, present(allDims[d])]))
        const k = JSON.stringify(actualDimensions.map((d) => dim[d])),
          group = groups.get(k) ?? {
            dimensions: dim,
            metrics: Object.fromEntries(metrics.map((m) => [m, 0])),
          }
        const purchase = event.event.name === "purchase",
          refund = event.event.name === "refund"
        const value =
          typeof params.value === "number" &&
          Number.isFinite(params.value) &&
          params.currency === property.currencyCode
            ? params.value
            : 0
        const values: Record<string, number> = {
          eventCount: 1,
          ecommercePurchases: purchase ? 1 : 0,
          grossPurchaseRevenue: purchase ? value : 0,
          refundAmount: refund ? value : 0,
          purchaseRevenue: purchase ? value : refund ? -value : 0,
          totalRevenue: purchase ? value : refund ? -value : 0,
        }
        for (const m of metrics) group.metrics[m] = (group.metrics[m] ?? 0) + present(values[m])
        groups.set(k, group)
      }
    }
    let rows = [...groups.values()].filter(
      (r) =>
        metricFilter(r.metrics) && (keepEmpty || Object.values(r.metrics).some((v) => v !== 0)),
    )
    if (body.orderBys !== undefined) {
      if (!Array.isArray(body.orderBys)) invalid("orderBys must be an array")
      const orders = body.orderBys.map((value) => {
        const b = record(value),
          d = record(b.dimension),
          m = record(b.metric),
          field = d.dimensionName ?? m.metricName
        if (
          typeof field !== "string" ||
          (!(field in metricTypes) && !actualDimensions.includes(field)) ||
          (d.dimensionName !== undefined && m.metricName !== undefined)
        )
          invalid("Unsupported orderBy")
        const numeric = m.metricName !== undefined || d.orderType === "NUMERIC"
        if (
          d.orderType !== undefined &&
          ![
            "ALPHANUMERIC",
            "CASE_INSENSITIVE_ALPHANUMERIC",
            "NUMERIC",
            "ORDER_TYPE_UNSPECIFIED",
          ].includes(String(d.orderType))
        )
          invalid("Unsupported order type")
        return {
          field,
          numeric,
          insensitive: d.orderType === "CASE_INSENSITIVE_ALPHANUMERIC",
          desc: flag(b.desc, "orderBy.desc"),
        }
      })
      rows.sort((a, b) => {
        for (const o of orders) {
          let x: string | number = a.metrics[o.field] ?? a.dimensions[o.field] ?? "",
            y: string | number = b.metrics[o.field] ?? b.dimensions[o.field] ?? ""
          if (o.numeric) {
            x = Number(x)
            y = Number(y)
          } else if (o.insensitive) {
            x = String(x).toLowerCase()
            y = String(y).toLowerCase()
          }
          const n = x === y ? 0 : x < y ? -1 : 1
          if (n) return o.desc ? -n : n
        }
        return 0
      })
    }
    const rowCount = rows.length
    rows = rows.slice(offset, offset + limit)
    return {
      dimensionHeaders: actualDimensions.map((name) => ({ name })),
      metricHeaders: metrics.map((name) => ({ name, type: metricTypes[name] })),
      rows: rows.map((r) => ({
        dimensionValues: actualDimensions.map((d) => ({ value: r.dimensions[d] })),
        metricValues: metrics.map((m) => ({ value: String(r.metrics[m]) })),
      })),
      rowCount,
      metadata: { currencyCode: property.currencyCode, timeZone: property.timeZone },
      kind: "analyticsData#runReport",
    }
  }
  batch(propertyId: string, body: Record<string, unknown>): Response {
    try {
      if (!Array.isArray(body.requests) || !body.requests.length || body.requests.length > 5)
        invalid("One to five report requests are required")
      return Response.json({
        reports: body.requests.map((r) => this.reportValue(propertyId, record(r))),
        kind: "analyticsData#batchRunReports",
      })
    } catch (e) {
      if (e instanceof Error) return rpcError(400, e.message)
      throw e
    }
  }
}
type Filter = (row: Record<string, string | number>) => boolean
function compileFilter(input: unknown, permitted: Set<string>): Filter {
  if (input === undefined) return () => true
  const b = record(input),
    keys = ["andGroup", "orGroup", "notExpression", "filter"].filter((k) => b[k] !== undefined)
  if (keys.length !== 1) invalid("FilterExpression requires exactly one expression")
  if (b.notExpression !== undefined) {
    const child = compileFilter(b.notExpression, permitted)
    return (r) => !child(r)
  }
  if (b.andGroup !== undefined || b.orGroup !== undefined) {
    const expressions = record(b.andGroup ?? b.orGroup).expressions
    if (!Array.isArray(expressions) || !expressions.length)
      invalid("Filter group requires expressions")
    const children = expressions.map((e) => compileFilter(e, permitted))
    return b.andGroup !== undefined
      ? (r) => children.every((f) => f(r))
      : (r) => children.some((f) => f(r))
  }
  const f = record(b.filter),
    field = text(f.fieldName, "filter.fieldName")
  if (!permitted.has(field)) invalid("Filter field must be a requested dimension or metric")
  const kinds = [
    "stringFilter",
    "inListFilter",
    "numericFilter",
    "betweenFilter",
    "emptyFilter",
  ].filter((k) => f[k] !== undefined)
  if (kinds.length !== 1) invalid("Filter requires exactly one value filter")
  if (f.emptyFilter !== undefined) return (r) => r[field] === "" || r[field] === "(not set)"
  if (f.inListFilter !== undefined) {
    const v = record(f.inListFilter)
    if (!Array.isArray(v.values) || !v.values.length || v.values.some((x) => typeof x !== "string"))
      invalid("inListFilter requires string values")
    const sensitive = flag(v.caseSensitive, "caseSensitive"),
      values = (v.values as string[]).map((x) => (sensitive ? x : x.toLowerCase()))
    return (r) => values.includes(sensitive ? String(r[field]) : String(r[field]).toLowerCase())
  }
  if (f.stringFilter !== undefined) {
    const v = record(f.stringFilter),
      value = text(v.value, "stringFilter.value"),
      match = text(v.matchType, "stringFilter.matchType"),
      sensitive = flag(v.caseSensitive, "caseSensitive")
    if (
      !["EXACT", "BEGINS_WITH", "ENDS_WITH", "CONTAINS", "FULL_REGEXP", "PARTIAL_REGEXP"].includes(
        match,
      )
    )
      invalid("Invalid string matchType")
    let regex: RegExp | undefined
    if (match.endsWith("REGEXP"))
      try {
        regex = new RegExp(match === "FULL_REGEXP" ? `^(?:${value})$` : value, sensitive ? "" : "i")
      } catch {
        invalid("Invalid regular expression")
      }
    return (r) => {
      const actual = sensitive ? String(r[field]) : String(r[field]).toLowerCase(),
        expected = sensitive ? value : value.toLowerCase()
      switch (match) {
        case "EXACT":
          return actual === expected
        case "BEGINS_WITH":
          return actual.startsWith(expected)
        case "ENDS_WITH":
          return actual.endsWith(expected)
        case "CONTAINS":
          return actual.includes(expected)
        default:
          return present(regex).test(actual)
      }
    }
  }
  const numericValue = (value: unknown): number => {
    const v = record(value),
      n = v.int64Value ?? v.doubleValue
    if ((typeof n !== "string" && typeof n !== "number") || !Number.isFinite(Number(n)))
      invalid("Invalid numeric filter value")
    return Number(n)
  }
  if (f.betweenFilter !== undefined) {
    const v = record(f.betweenFilter),
      min = numericValue(v.fromValue),
      max = numericValue(v.toValue)
    if (min > max) invalid("Invalid numeric range")
    return (r) => Number(r[field]) >= min && Number(r[field]) <= max
  }
  const v = record(f.numericFilter),
    value = numericValue(v.value),
    operation = text(v.operation, "numericFilter.operation")
  if (
    !["EQUAL", "LESS_THAN", "LESS_THAN_OR_EQUAL", "GREATER_THAN", "GREATER_THAN_OR_EQUAL"].includes(
      operation,
    )
  )
    invalid("Invalid numeric operation")
  return (r) => {
    const n = Number(r[field])
    switch (operation) {
      case "EQUAL":
        return n === value
      case "LESS_THAN":
        return n < value
      case "LESS_THAN_OR_EQUAL":
        return n <= value
      case "GREATER_THAN":
        return n > value
      default:
        return n >= value
    }
  }
}
