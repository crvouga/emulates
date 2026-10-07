import {
  type APIOptions,
  annotateResponse,
  bearerToken,
  bootSqlite,
  Collection,
  IdSequence,
} from "@crvouga/mockingbird-service"
import { clearNamespace } from "@crvouga/mockingbird-sqlite"

export { document, operationIds, supportedOperationIds } from "./generated/openapi.js"
export type { TavilyRuntime, TavilyRuntimeOptions } from "./runtime.js"
export { createRuntime, TAVILY_PRESETS } from "./runtime.js"
export const TAVILY_NAMESPACE = "tavily"
export type SearchHit = {
  title: string
  url: string
  content: string
  score: number
  raw_content?: string | null
  [key: string]: unknown
}
export type SearchScript = {
  query: string
  match?: Record<string, unknown>
  results: SearchHit[]
  answer?: string
  response_time?: number
}
export type Extraction = { url: string; raw_content?: string; error?: string; images?: string[] }
export type ApiKey = { key: string; status?: "active" | "quota" | "plan_limit" | "payg_limit" }
export type TavilyAPIOptions = APIOptions & {
  searches?: SearchScript[]
  extractions?: Extraction[]
  apiKeys?: ApiKey[]
}
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v)
export class TavilyAPI {
  readonly searches: Collection<SearchScript>
  readonly extractions: Collection<Extraction>
  readonly apiKeys: Collection<ApiKey>
  private readonly initialized: Collection<boolean>
  private readonly ids: IdSequence
  private readonly sqlite
  private readonly namespace: string
  constructor(private readonly options: TavilyAPIOptions = {}) {
    this.sqlite = bootSqlite(options.sqlite)
    this.namespace = options.namespace ?? TAVILY_NAMESPACE
    this.searches = new Collection(this.sqlite, this.namespace, "searches")
    this.extractions = new Collection(this.sqlite, this.namespace, "extractions")
    this.apiKeys = new Collection(this.sqlite, this.namespace, "apiKeys")
    this.initialized = new Collection(this.sqlite, this.namespace, "initialized")
    this.ids = new IdSequence(this.sqlite, this.namespace, "tavily")
    this.seed()
  }
  private seed() {
    if (this.initialized.get("seed")) return
    for (const [i, row] of (this.options.searches ?? []).entries())
      this.searches.insert(String(i), row)
    for (const [i, row] of (this.options.extractions ?? []).entries())
      this.extractions.insert(String(i), row)
    for (const row of this.options.apiKeys ?? [{ key: "mock_tavily_key" }])
      this.apiKeys.insert(row.key, row)
    this.initialized.insert("seed", true)
  }
  async reset() {
    clearNamespace(this.sqlite, this.namespace)
    this.seed()
  }
  private error(status: number, error: string) {
    return Response.json({ detail: { error } }, { status })
  }
  private validation(field: string) {
    return Response.json(
      { detail: [{ type: "value_error", loc: ["body", field], msg: "Invalid value" }] },
      { status: 422 },
    )
  }
  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname
    if (request.method !== "POST" || !["/search", "/extract"].includes(path))
      return this.error(404, "Not Found")
    const credential = bearerToken(request)
    const key = credential ? this.apiKeys.get(credential) : undefined
    if (!key) return this.error(401, "Unauthorized: missing or invalid API key.")
    if (key.status === "quota")
      return this.error(
        429,
        "Your request has been blocked due to excessive requests. Please reduce the rate of requests.",
      )
    if (key.status === "plan_limit")
      return this.error(432, "This request exceeds your plan's set usage limit.")
    if (key.status === "payg_limit")
      return this.error(433, "This request exceeds the pay-as-you-go limit.")
    const body: unknown = await request.json().catch(() => null)
    if (!object(body)) return this.validation("body")
    const request_id = this.ids.next("mock-request-", 16)
    if (path === "/search") {
      if (typeof body.query !== "string" || !body.query.trim()) return this.validation("query")
      const limit = body.max_results ?? 10
      if (!Number.isInteger(limit) || Number(limit) < 0 || Number(limit) > 20)
        return this.validation("max_results")
      const topic = body.topic ?? "general"
      if (!["general", "news", "finance"].includes(String(topic)))
        return this.error(400, "Invalid topic.")
      if (
        body.search_depth != null &&
        !["basic", "advanced", "fast", "ultra-fast"].includes(String(body.search_depth))
      )
        return this.error(400, "Invalid search_depth.")
      if (
        body.time_range != null &&
        !["day", "week", "month", "year", "d", "w", "m", "y"].includes(String(body.time_range))
      )
        return this.error(400, "Invalid time_range.")
      const effective = { ...body, topic, search_depth: body.search_depth ?? "basic" }
      const script = this.searches
        .list({ order: "oldest" })
        .map((row) => row.value)
        .filter(
          (row) =>
            row.query === body.query &&
            Object.entries(row.match ?? {}).every(
              ([k, v]) =>
                JSON.stringify(effective[k as keyof typeof effective]) === JSON.stringify(v),
            ),
        )
        .sort((a, b) => Object.keys(b.match ?? {}).length - Object.keys(a.match ?? {}).length)[0]
      const results = (script?.results ?? []).slice(0, Number(limit)).map((hit) => ({
        ...hit,
        raw_content: body.include_raw_content ? (hit.raw_content ?? null) : null,
      }))
      return annotateResponse(
        Response.json({
          query: body.query,
          results,
          images: [],
          ...(body.include_answer ? { answer: script?.answer ?? "" } : {}),
          response_time: script?.response_time ?? 0,
          request_id,
        }),
        { ids: { request: request_id } },
      )
    }
    const urls = typeof body.urls === "string" ? [body.urls] : body.urls
    if (
      !Array.isArray(urls) ||
      !urls.length ||
      urls.length > 20 ||
      urls.some((url) => typeof url !== "string")
    )
      return this.validation("urls")
    const results: { url: string; raw_content: string; images: string[] }[] = []
    const failed_results: { url: string; error: string }[] = []
    for (const url of urls as string[]) {
      const row = this.extractions
        .list({ order: "oldest" })
        .find(({ value }) => value.url === url)?.value
      if (row?.raw_content !== undefined && !row.error)
        results.push({ url, raw_content: row.raw_content, images: row.images ?? [] })
      else failed_results.push({ url, error: row?.error ?? "Failed to retrieve content" })
    }
    return annotateResponse(
      Response.json({ results, failed_results, response_time: 0, request_id }),
      { ids: { request: request_id } },
    )
  }
}
