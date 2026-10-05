import {
  type AdsError,
  adsFailure,
  flag,
  int64,
  integer,
  invalid,
  present,
  Rejection,
  record,
  reject,
  text,
} from "./errors.js"
import { executeGAQL, type WireRow } from "./gaql.js"
import {
  type Budget,
  type BudgetFixture,
  fingerprint,
  type GoogleAdsState,
  key,
  normalizeBudget,
} from "./state.js"

const PAGE_SIZE = 10000
const indexed = (detail: AdsError, fieldName: string, index: number): AdsError => ({
  ...detail,
  location: {
    fieldPathElements: [{ fieldName, index }, ...(detail.location?.fieldPathElements ?? [])],
  },
})
const partialError = (errors: AdsError[], requestId: string) => ({
  code: 3,
  message: "Partial failure",
  details: [adsFailure(errors, requestId)],
})
type SearchData = { results: WireRow[]; fieldMask: string; summaryRow: WireRow }
const resource = (name: unknown, customerId: string, type: string): string => {
  const value = text(name, "resourceName")
  const match = new RegExp(`^customers/${customerId}/${type}/([1-9][0-9]*)$`).exec(value)
  if (!match)
    reject(
      "RESOURCE_NAME_MALFORMED",
      "Resource name is malformed",
      "requestError",
      400,
      "resourceName",
    )
  return present(match[1])
}
export class AdsEngine {
  constructor(
    readonly state: GoogleAdsState,
    private readonly now: () => number,
  ) {}
  search(
    customerId: string,
    body: Record<string, unknown>,
    stream = false,
    requestId = "",
  ): unknown {
    const query = text(body.query, "query")
    if (body.validateOnly === true && body.pageToken)
      reject("VALIDATE_ONLY_REQUEST_HAS_PAGE_TOKEN", "validateOnly cannot contain a page token")
    if (body.pageSize !== undefined)
      reject(
        "PAGE_SIZE_NOT_SUPPORTED",
        "Setting pageSize is not supported; pages contain up to 10000 rows",
        "requestError",
        400,
        "pageSize",
      )
    const validateOnly = flag(body.validateOnly, "validateOnly")
    const settings = record(body.searchSettings)
    const summary = flag(settings.returnSummaryRow, "searchSettings.returnSummaryRow")
    const total = flag(settings.returnTotalResultsCount, "searchSettings.returnTotalResultsCount")
    const omit = flag(settings.omitResults, "searchSettings.omitResults")
    if (validateOnly && summary)
      reject(
        "CANNOT_RETURN_SUMMARY_ROW_FOR_VALIDATE_ONLY_REQUESTS",
        "Summary row is unavailable for validateOnly",
      )
    if (summary && !query.includes("metrics."))
      reject(
        "CANNOT_RETURN_SUMMARY_ROW_FOR_REQUEST_WITHOUT_METRICS",
        "Summary row requires metrics",
      )
    if (
      stream &&
      (body.pageToken !== undefined ||
        body.searchSettings !== undefined ||
        body.validateOnly !== undefined)
    )
      invalid("Unsupported SearchStream field")
    const queryHash = fingerprint({ query, settings })
    let data: SearchData,
      snapshotId: string | undefined,
      offset = 0
    if (body.pageToken !== undefined && body.pageToken !== "") {
      const token = this.state.pageTokens.get(text(body.pageToken, "pageToken"))
      const snapshot = token ? this.state.snapshots.get(token.snapshotId) : undefined
      if (
        !token ||
        !snapshot ||
        snapshot.customerId !== customerId ||
        snapshot.queryHash !== queryHash
      )
        reject("INVALID_PAGE_TOKEN", "Invalid page token", "requestError", 400, "pageToken")
      if (snapshot.expiresAt <= this.now())
        reject("EXPIRED_PAGE_TOKEN", "Page token has expired", "requestError", 400, "pageToken")
      snapshotId = snapshot.id
      offset = token.offset
      data = this.state.open<SearchData>(snapshot.sealed, "snapshot", snapshot.id)
    } else data = executeGAQL(this.state, customerId, query, this.now())
    if (validateOnly) return {}
    if (stream) {
      if (
        body.summaryRowSetting !== undefined &&
        !["NO_SUMMARY_ROW", "SUMMARY_ROW_WITH_RESULTS", "SUMMARY_ROW_ONLY", "UNSPECIFIED"].includes(
          String(body.summaryRowSetting),
        )
      )
        invalid("Invalid summaryRowSetting")
      const batches: Record<string, unknown>[] = []
      if (body.summaryRowSetting !== "SUMMARY_ROW_ONLY")
        for (let start = 0; start < data.results.length; start += PAGE_SIZE)
          batches.push({
            results: data.results.slice(start, start + PAGE_SIZE),
            fieldMask: data.fieldMask,
            requestId,
          })
      if (!batches.length && body.summaryRowSetting !== "SUMMARY_ROW_ONLY")
        batches.push({ results: [], fieldMask: data.fieldMask, requestId })
      if (["SUMMARY_ROW_WITH_RESULTS", "SUMMARY_ROW_ONLY"].includes(String(body.summaryRowSetting)))
        batches.push({ summaryRow: data.summaryRow, fieldMask: data.fieldMask, requestId })
      return batches
    }
    const result: Record<string, unknown> = {
      fieldMask: data.fieldMask,
      ...(omit ? {} : { results: data.results.slice(offset, offset + PAGE_SIZE) }),
      ...(total ? { totalResultsCount: String(data.results.length) } : {}),
      ...(summary ? { summaryRow: data.summaryRow } : {}),
    }
    if (!omit && offset + PAGE_SIZE < data.results.length) {
      if (!snapshotId) {
        snapshotId = this.state.ids.next("snapshot_")
        this.state.snapshots.insert(snapshotId, {
          id: snapshotId,
          customerId,
          queryHash,
          expiresAt: this.now() + present(this.state.settings.get("settings")).pageTokenTtlMs,
          sealed: this.state.seal(data, "snapshot", snapshotId),
        })
      }
      // One immutable continuation per offset; retries return the same token.
      const previous = this.state.pageTokens.list({
        where: (p) => p.snapshotId === snapshotId && p.offset === offset + PAGE_SIZE,
      })[0]?.value
      const id = previous?.id ?? this.state.ids.next("page_", 32)
      if (!previous)
        this.state.pageTokens.insert(id, { id, snapshotId, offset: offset + PAGE_SIZE })
      result.nextPageToken = id
    }
    return result
  }
  mutate(
    customerId: string,
    body: Record<string, unknown>,
    requestId: string,
    injectedPartial = false,
  ): Record<string, unknown> {
    if (!Array.isArray(body.operations) || !body.operations.length)
      invalid("At least one operation is required", "operations")
    const validateOnly = flag(body.validateOnly, "validateOnly"),
      partial = flag(body.partialFailure, "partialFailure")
    if (
      body.responseContentType !== undefined &&
      !["RESOURCE_NAME_ONLY", "MUTABLE_RESOURCE", "UNSPECIFIED"].includes(
        String(body.responseContentType),
      )
    )
      invalid("Invalid responseContentType")
    const settings = present(this.state.settings.get("settings"))
    let nextId = BigInt(settings.nextBudgetId)
    const working = new Map(
      this.state.budgets
        .list({ where: (b) => b.customerId === customerId })
        .map(({ value }) => [value.id, value]),
    )
    const plans: ({ before: Budget | null; after: Budget } | null)[] = []
    const errors: AdsError[] = []
    for (let index = 0; index < body.operations.length; index++) {
      try {
        if (injectedPartial && index === body.operations.length - 1)
          reject("RESOURCE_NOT_FOUND", "Injected operation failure", "mutateError")
        const op = record(body.operations[index])
        const kinds = ["create", "update", "remove"].filter((k) => op[k] !== undefined)
        if (kinds.length !== 1) invalid("Exactly one create, update or remove is required")
        let before: Budget | null = null,
          after: Budget
        if (op.create !== undefined) {
          const value = record(op.create)
          if (
            value.resourceName !== undefined ||
            value.id !== undefined ||
            op.updateMask !== undefined
          )
            invalid("Create cannot contain an ID, resourceName or updateMask")
          after = normalizeBudget({ ...value, customerId, id: nextId.toString() } as BudgetFixture)
          if (working.has(after.id)) invalid("Allocated budget ID conflicts with a fixture")
          if (
            after.explicitlyShared &&
            [...working.values()].some((b) => b.status !== "REMOVED" && b.name === after.name)
          )
            reject(
              "DUPLICATE_NAME",
              "A shared budget with this name already exists",
              "campaignBudgetError",
            )
          nextId++
        } else {
          const value = record(op.update)
          const id = resource(op.remove ?? value.resourceName, customerId, "campaignBudgets")
          before = working.get(id) ?? null
          if (!before || before.status === "REMOVED")
            reject("RESOURCE_NOT_FOUND", "Campaign budget not found", "mutateError")
          if (op.remove !== undefined) {
            if (
              this.state.campaigns.list({
                where: (c) =>
                  c.customerId === customerId && c.budgetId === id && c.status !== "REMOVED",
              }).length
            )
              reject("CAMPAIGN_BUDGET_IN_USE", "Campaign budget is in use", "campaignBudgetError")
            after = { ...before, status: "REMOVED" }
          } else {
            const mask = text(op.updateMask, "updateMask")
              .split(",")
              .map((s) => s.trim().replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()))
            if (
              mask.some(
                (f) =>
                  ![
                    "name",
                    "amountMicros",
                    "totalAmountMicros",
                    "deliveryMethod",
                    "explicitlyShared",
                  ].includes(f),
              )
            )
              reject(
                "FIELD_NOT_FOUND",
                "Unknown or immutable update mask field",
                "fieldMaskError",
                400,
                "updateMask",
              )
            const candidate: Record<string, unknown> = { ...before }
            for (const f of mask) {
              if (value[f] === undefined) delete candidate[f]
              else candidate[f] = value[f]
            }
            if (before.explicitlyShared && candidate.explicitlyShared === false)
              reject(
                "CANNOT_UPDATE_CAMPAIGN_BUDGET_TO_IMPLICITLY_SHARED",
                "A shared budget cannot become non-shared",
                "campaignBudgetError",
              )
            after = normalizeBudget(candidate as BudgetFixture)
            if (
              after.explicitlyShared &&
              [...working.values()].some(
                (b) => b.id !== id && b.status !== "REMOVED" && b.name === after.name,
              )
            )
              reject(
                "DUPLICATE_NAME",
                "A shared budget with this name already exists",
                "campaignBudgetError",
              )
          }
        }
        working.set(after.id, after)
        plans.push({ before, after })
      } catch (error) {
        if (!(error instanceof Rejection)) throw error
        errors.push(indexed(error.detail, "operations", index))
        plans.push(null)
      }
    }
    if (errors.length && !partial) throw new Rejection(400, present(errors[0]))
    const response: Record<string, unknown> = errors.length
      ? { partialFailureError: partialError(errors, requestId) }
      : {}
    if (validateOnly) return response
    const results = this.state.sqlite.transaction(() => {
      const out = plans.map((plan) => {
        if (!plan) return {}
        const { before, after } = plan
        this.state.budgets.insert(key(customerId, after.id), after)
        const auditId = this.state.ids.next("mutation_")
        this.state.mutations.insert(auditId, {
          id: auditId,
          requestId,
          customerId,
          resourceName: after.resourceName,
          before,
          after,
          createdAt: this.now(),
        })
        const {
          customerId: _customer,
          id: _id,
          status: _status,
          period: _period,
          ...mutable
        } = after
        return {
          resourceName: after.resourceName,
          ...(body.responseContentType === "MUTABLE_RESOURCE" ? { campaignBudget: mutable } : {}),
        }
      })
      this.state.settings.update("settings", { ...settings, nextBudgetId: nextId.toString() })
      return out
    })
    return { ...response, results }
  }
  upload(
    customerId: string,
    body: Record<string, unknown>,
    requestId: string,
    injectedPartial = false,
  ): Record<string, unknown> {
    if (!Array.isArray(body.conversions) || !body.conversions.length)
      invalid("At least one conversion is required", "conversions")
    if (body.partialFailure === undefined) invalid("partialFailure is required", "partialFailure")
    const partial = flag(body.partialFailure, "partialFailure"),
      validateOnly = flag(body.validateOnly, "validateOnly")
    const inputJobId =
      body.jobId === undefined ? undefined : integer(body.jobId, "jobId", 0, 2147483647)
    const prior = this.state.conversions
      .list({ where: (c) => c.customerId === customerId })
      .map(({ value }) =>
        this.state.open<Record<string, unknown>>(value.sealed, "conversion", value.id),
      )
    const plans: ({ payload: Record<string, unknown>; result: Record<string, unknown> } | null)[] =
        [],
      errors: AdsError[] = []
    for (let index = 0; index < body.conversions.length; index++) {
      try {
        if (injectedPartial && index === body.conversions.length - 1)
          reject(
            "NO_CONVERSION_ACTION_FOUND",
            "Injected conversion failure",
            "conversionUploadError",
          )
        const v = record(body.conversions[index])
        const clickFields = ["gclid", "gbraid", "wbraid"].filter((f) => v[f] !== undefined)
        if (clickFields.length !== 1) invalid("Exactly one click identifier is required")
        const clickField = present(clickFields[0]),
          click = text(v[clickField], clickField)
        const actionId = resource(v.conversionAction, customerId, "conversionActions")
        const action = this.state.actions.get(key(customerId, actionId))
        if (action?.status !== "ENABLED")
          reject(
            "NO_CONVERSION_ACTION_FOUND",
            "Conversion action was not found or is disabled",
            "conversionUploadError",
          )
        if (action.type !== "UPLOAD_CLICKS")
          reject(
            "INVALID_CONVERSION_ACTION_TYPE",
            "Conversion action must be UPLOAD_CLICKS",
            "conversionUploadError",
          )
        const date = text(v.conversionDateTime, "conversionDateTime")
        const timestamp = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/.test(date)
          ? Date.parse(date.replace(" ", "T"))
          : Number.NaN
        if (!Number.isFinite(timestamp))
          invalid("Conversion date must include a timezone", "conversionDateTime")
        if (timestamp > this.now())
          invalid("Conversion date is in the future", "conversionDateTime")
        if (
          v.conversionValue !== undefined &&
          (typeof v.conversionValue !== "number" || !Number.isFinite(v.conversionValue))
        )
          invalid("Invalid conversionValue")
        if (
          v.currencyCode !== undefined &&
          (typeof v.currencyCode !== "string" || !/^[A-Z]{3}$/.test(v.currencyCode))
        )
          invalid("Invalid currencyCode")
        if (v.orderId !== undefined) text(v.orderId, "orderId")
        const sameAction = (r: Record<string, unknown>): boolean =>
          r.conversionAction === v.conversionAction
        if (v.orderId !== undefined && prior.some((r) => sameAction(r) && r.orderId === v.orderId))
          reject(
            "ORDER_ID_ALREADY_IN_USE",
            "Order ID has already been used for this conversion action",
            "conversionUploadError",
          )
        if (
          v.orderId !== undefined &&
          body.conversions.map(record).filter((r) => sameAction(r) && r.orderId === v.orderId)
            .length > 1
        )
          reject(
            "DUPLICATE_ORDER_ID",
            "Duplicate order ID in this request",
            "conversionUploadError",
          )
        const sameClick = (r: Record<string, unknown>): boolean =>
          sameAction(r) && r[clickField] === click && r.conversionDateTime === date
        if (body.conversions.map(record).filter(sameClick).length > 1)
          reject(
            "DUPLICATE_CLICK_CONVERSION_IN_REQUEST",
            "Duplicate click conversion in this request",
            "conversionUploadError",
          )
        if (prior.some(sameClick))
          reject(
            "CLICK_CONVERSION_ALREADY_EXISTS",
            "Click conversion already exists",
            "conversionUploadError",
          )
        const payload = structuredClone(v)
        plans.push({
          payload,
          result: {
            [clickField]: click,
            conversionAction: v.conversionAction,
            conversionDateTime: date,
          },
        })
      } catch (error) {
        if (!(error instanceof Rejection)) throw error
        errors.push(indexed(error.detail, "conversions", index))
        plans.push(null)
      }
    }
    if (errors.length && !partial) throw new Rejection(400, present(errors[0]))
    const settings = present(this.state.settings.get("settings"))
    const jobId = inputJobId !== undefined ? String(inputJobId) : int64(settings.nextJobId, "jobId")
    const response: Record<string, unknown> = {
      jobId,
      ...(errors.length ? { partialFailureError: partialError(errors, requestId) } : {}),
    }
    if (validateOnly) return response
    this.state.sqlite.transaction(() => {
      for (const plan of plans)
        if (plan) {
          const id = this.state.ids.next("conversion_")
          this.state.conversions.insert(id, {
            id,
            customerId,
            createdAt: this.now(),
            availableAt: this.now() + settings.reportingLagMs,
            fingerprint: fingerprint(plan.payload),
            sealed: this.state.seal(plan.payload, "conversion", id),
          })
        }
      if (inputJobId === undefined)
        this.state.settings.update("settings", {
          ...settings,
          nextJobId: (BigInt(jobId) + 1n).toString(),
        })
    })
    return { ...response, results: plans.map((p) => p?.result ?? {}) }
  }
}
