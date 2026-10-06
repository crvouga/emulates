import { jsonRes, type OperationContext } from "@emulates/service"
import { fromFilters, restView } from "./flags.js"
import type { ExperimentRecord, PostHogState } from "./state.js"

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
const error = (status: number, detail: string) =>
  jsonRes(status, {
    type: status === 404 ? "invalid_request" : "validation_error",
    code: status === 404 ? "not_found" : "invalid_input",
    detail,
    attr: null,
  })
const variants = [
  { key: "control", name: "Control Group", rollout_percentage: 50 },
  { key: "test", name: "Test Variant", rollout_percentage: 50 },
]
const legacyVariants = (
  parameters: Record<string, unknown>,
): (Record<string, unknown> & { rollout_percentage: unknown })[] | undefined =>
  Array.isArray(parameters.feature_flag_variants)
    ? parameters.feature_flag_variants.filter(isRecord).map((variant) => ({
        ...variant,
        rollout_percentage: variant.rollout_percentage ?? variant.split_percent,
      }))
    : undefined

export const experimentOperations = (
  state: PostHogState,
  now: () => number,
  adminPrefix: string,
) => {
  const view = (record: ExperimentRecord) => {
    const { projectId: _project, ...body } = record
    const flag = state.flags.get(record.feature_flag_key)
    const wire = flag ? restView(flag) : null
    const multivariate =
      wire && isRecord(wire.filters.multivariate) ? wire.filters.multivariate : undefined
    const liveVariants = Array.isArray(multivariate?.variants)
      ? multivariate.variants
          .filter(isRecord)
          .map((v) => ({ ...v, split_percent: v.rollout_percentage }))
      : []
    return {
      ...body,
      parameters: { ...record.parameters, feature_flag_variants: liveVariants },
      feature_flag: wire,
    }
  }
  const find = (context: OperationContext) => {
    const record = state.experiments.get(context.params.experimentId ?? "")
    return record?.projectId === context.params.projectId ? record : undefined
  }
  const validate = (body: unknown, current?: ExperimentRecord): string | undefined => {
    if (!isRecord(body)) return "Expected a JSON object."
    if (
      (!current || body.name !== undefined) &&
      (typeof body.name !== "string" || !body.name.trim())
    )
      return "name is required."
    if (
      !current &&
      (typeof body.feature_flag_key !== "string" || !/^[A-Za-z0-9_-]+$/.test(body.feature_flag_key))
    )
      return "feature_flag_key is required."
    if (
      current &&
      body.feature_flag_key !== undefined &&
      body.feature_flag_key !== current.feature_flag_key
    )
      return "The linked feature flag cannot be changed."
    if (body.parameters !== undefined && !isRecord(body.parameters))
      return "parameters must be an object."
    if (
      body.metrics !== undefined &&
      (!Array.isArray(body.metrics) || !body.metrics.every(isRecord))
    )
      return "metrics must be an array of objects."
    if (isRecord(body.parameters)) {
      const roll = body.parameters.rollout_percentage
      if (roll !== undefined && (typeof roll !== "number" || roll < 0 || roll > 100))
        return "Invalid rollout_percentage."
      const variants = legacyVariants(body.parameters)
      if (
        body.parameters.feature_flag_variants !== undefined &&
        (!Array.isArray(body.parameters.feature_flag_variants) ||
          !variants ||
          variants.length < 2 ||
          variants.some(
            (v) =>
              typeof v.key !== "string" ||
              !v.key ||
              typeof v.rollout_percentage !== "number" ||
              v.rollout_percentage < 0 ||
              v.rollout_percentage > 100,
          ) ||
          variants.reduce((sum, v) => sum + Number(v.rollout_percentage), 0) !== 100)
      )
        return "Variant weights must sum to 100."
    }
    if (body.archived !== undefined && typeof body.archived !== "boolean")
      return "archived must be boolean."
    for (const field of ["start_date", "end_date"])
      if (
        body[field] !== undefined &&
        body[field] !== null &&
        (typeof body[field] !== "string" || !Number.isFinite(Date.parse(body[field])))
      )
        return `${field} must be a date or null.`
    const start = body.start_date === undefined ? current?.start_date : body.start_date
    const end = body.end_date === undefined ? current?.end_date : body.end_date
    if (
      typeof start === "string" &&
      typeof end === "string" &&
      Date.parse(start) >= Date.parse(end)
    )
      return "start_date must precede end_date."
    return undefined
  }
  return {
    ListExperiments: (context: OperationContext) => {
      const limit = Number(context.query.limit ?? 100)
      const offset = Number(context.query.offset ?? 0)
      if (!Number.isInteger(limit) || limit < 1 || !Number.isInteger(offset) || offset < 0)
        return error(400, "Invalid pagination.")
      const rows = state.experiments
        .list({ order: "newest", where: (row) => row.projectId === context.params.projectId })
        .map((row) => row.value)
      const page = (at: number) => {
        const url = new URL(context.url)
        const namespace = context.request.headers.get("x-emulates-namespace")
        url.pathname = `${namespace ? `${adminPrefix}/ns/${encodeURIComponent(namespace)}` : ""}${context.url.pathname.replace(/\/$/, "")}/`
        url.searchParams.set("limit", String(limit))
        url.searchParams.set("offset", String(at))
        return url.href
      }
      return jsonRes(200, {
        count: rows.length,
        next: offset + limit < rows.length ? page(offset + limit) : null,
        previous: offset > 0 ? page(Math.max(0, offset - limit)) : null,
        results: rows.slice(offset, offset + limit).map(view),
      })
    },
    CreateExperiment: (context: OperationContext) => {
      const body = context.body.kind === "json" ? context.body.value : undefined
      const issue = validate(body)
      if (issue || !isRecord(body)) return error(400, issue ?? "Invalid body.")
      const parameters = isRecord(body.parameters) ? body.parameters : {}
      const key = String(body.feature_flag_key)
      const existing = state.flags.get(key)
      if (existing?.deleted) return error(400, "The feature flag has been deleted.")
      if (!existing) {
        const flagFilters = {
          aggregation_group_type_index: null,
          groups: [
            { properties: [], rollout_percentage: Number(parameters.rollout_percentage ?? 100) },
          ],
          multivariate: { variants: legacyVariants(parameters) ?? variants },
          payloads: isRecord(parameters.feature_flag_payloads)
            ? parameters.feature_flag_payloads
            : {},
        }
        state.putFlag(key, {
          ...fromFilters(flagFilters),
          filters: flagFilters,
          name: `Feature Flag for Experiment ${body.name}`,
          active: typeof body.start_date === "string",
        })
      }
      const id = state.experiments.list().reduce((max, row) => Math.max(max, row.value.id), 0) + 1
      const timestamp = new Date(now()).toISOString()
      const record: ExperimentRecord = {
        id,
        projectId: context.params.projectId ?? "",
        name: String(body.name),
        feature_flag_key: key,
        parameters,
        metrics: Array.isArray(body.metrics) ? body.metrics : [],
        start_date: typeof body.start_date === "string" ? body.start_date : null,
        end_date: typeof body.end_date === "string" ? body.end_date : null,
        archived: body.archived === true,
        created_at: timestamp,
        updated_at: timestamp,
      }
      state.experiments.insert(String(id), record)
      return jsonRes(201, view(record))
    },
    GetExperiment: (context: OperationContext) => {
      const record = find(context)
      return record ? jsonRes(200, view(record)) : error(404, "Not found.")
    },
    UpdateExperiment: (context: OperationContext) => {
      const record = find(context)
      if (!record) return error(404, "Not found.")
      const body = context.body.kind === "json" ? context.body.value : undefined
      const issue = validate(body, record)
      if (issue || !isRecord(body)) return error(400, issue ?? "Invalid body.")
      const updated = { ...record, updated_at: new Date(now()).toISOString() }
      for (const field of [
        "name",
        "parameters",
        "metrics",
        "start_date",
        "end_date",
        "archived",
      ] as const)
        if (body[field] !== undefined) Object.assign(updated, { [field]: body[field] })
      const flag = state.flags.get(record.feature_flag_key)
      const parameters = isRecord(body.parameters) ? body.parameters : undefined
      const configChanged =
        parameters &&
        ["feature_flag_variants", "rollout_percentage", "feature_flag_payloads"].some(
          (key) => key in parameters,
        )
      if (flag && configChanged) {
        if (record.start_date)
          return error(400, "Edit a running experiment's flag through the feature flag API.")
        const filters = { ...restView(flag).filters }
        if (parameters?.feature_flag_variants !== undefined)
          filters.multivariate = { variants: legacyVariants(parameters) ?? [] }
        if (parameters?.rollout_percentage !== undefined)
          filters.groups = [{ properties: [], rollout_percentage: parameters.rollout_percentage }]
        if (isRecord(parameters?.feature_flag_payloads))
          filters.payloads = parameters.feature_flag_payloads
        state.patchFlag(flag.key, {
          ...fromFilters(filters),
          filters,
          ...(!record.start_date && updated.start_date ? { active: true } : {}),
        })
      } else if (flag && !record.start_date && updated.start_date && !flag.active)
        state.patchFlag(flag.key, { active: true })
      // end_date and archived fields do not automatically disable the linked flag.
      state.experiments.update(String(record.id), updated)
      return jsonRes(200, view(updated))
    },
  }
}
