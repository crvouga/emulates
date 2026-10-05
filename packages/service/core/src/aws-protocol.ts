import { clearNamespace, type SqliteClient } from "@crvouga/mockingbird-sqlite"
import { awsParseXml, awsXml } from "./aws-xml.js"
import { Collection } from "./collection.js"
import { IdSequence } from "./ids.js"
import { bootSqlite, type APIOptions } from "./service.js"

export type AwsInput = Record<string, unknown>
export class AwsError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) { super(message) }
}
export type AwsProtocolOptions = APIOptions & { region?: string; accountId?: string }
export type AwsOperation = { operation: string; input: AwsInput; request: Request; url: URL }
export const awsRecord = (value: unknown): AwsInput => typeof value === "object" && value !== null && !Array.isArray(value) ? value as AwsInput : {}
export const awsList = (value: unknown): unknown[] => Array.isArray(value) ? value : value === undefined || value === null ? [] : [value]
export const awsRequired = (input: AwsInput, key: string): string => {
  if (typeof input[key] !== "string" || !(input[key] as string).length) throw new AwsError("ValidationException", `${key} is required`)
  return input[key] as string
}
export const awsPage = <T>(values: T[], input: AwsInput, tokenKey = "NextToken", limitKey = "MaxResults") => {
  const offset = Number(input[tokenKey] ?? 0), max = Number(input[limitKey] ?? 100)
  if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(max) || max < 1 || max > 10000) throw new AwsError("InvalidParameterException", "Invalid pagination")
  return { items: values.slice(offset, offset + max), ...(offset + max < values.length ? { token: String(offset + max) } : {}) }
}

/** Fetch-native AWS wire transport. Service subclasses own operations and persisted state. */
export abstract class AwsProtocolAPI {
  readonly sqlite: SqliteClient
  readonly namespace: string
  readonly now: () => number
  readonly region: string
  readonly accountId: string
  readonly ids: IdSequence
  private readonly collections = new Map<string, Collection<AwsInput>>()
  constructor(readonly service: string, options: AwsProtocolOptions = {}) {
    this.sqlite = bootSqlite(options.sqlite)
    this.namespace = options.namespace ?? service
    this.now = options.now ?? Date.now
    this.region = options.region ?? "us-east-1"
    this.accountId = options.accountId ?? "000000000000"
    this.ids = new IdSequence(this.sqlite, this.namespace, service)
  }
  collection(name: string): Collection<AwsInput> {
    let collection = this.collections.get(name)
    if (!collection) { collection = new Collection(this.sqlite, this.namespace, `${this.service.replace(/-/g, "_")}_${name}`); this.collections.set(name, collection) }
    return collection
  }
  arn(type: string, name: string, service = this.service) { return `arn:aws:${service}:${this.region}:${this.accountId}:${type}${name}` }
  async reset() { clearNamespace(this.sqlite, this.namespace) }
  abstract dispatch(context: AwsOperation): unknown | Promise<unknown>
  route(_method: string, _pathname: string): { operation: string; params: AwsInput } | undefined { return undefined }
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const requestId = this.ids.next("req-", 32)
    let query = false
    let operation = ""
    try {
      let input: AwsInput = {}
      const route = this.route(request.method, url.pathname)
      const target = request.headers.get("x-amz-target")
      if (target) { operation = target.split(".").at(-1) ?? ""; input = awsRecord(await request.json()) }
      else if (route) {
        operation = route.operation
        const raw = request.method === "GET" || request.method === "DELETE" || request.method === "HEAD" ? "" : await request.text()
        input = raw ? request.headers.get("content-type")?.includes("xml") ? awsParseXml(raw) : awsRecord(JSON.parse(raw)) : {}
        Object.assign(input, Object.fromEntries(url.searchParams), route.params)
      } else {
        const params = new URLSearchParams(request.method === "GET" ? url.search : await request.text())
        operation = params.get("Action") ?? ""; query = true
        input = decodeAwsQuery(params)
      }
      if (!operation) throw new AwsError("UnknownOperationException", "Unknown operation", 400)
      const result = await this.dispatch({ operation, input, request, url })
      if (result instanceof Response) return result
      const headers = { "x-amzn-requestid": requestId, "x-amz-request-id": requestId }
      if (query) {
        const ec2 = this.service === "ec2"
        return new Response(ec2 ? `<${operation}Response xmlns="http://ec2.amazonaws.com/doc/2016-11-15/"><requestId>${requestId}</requestId>${awsXml(result, "item")}</${operation}Response>` : `<${operation}Response><${operation}Result>${awsXml(result)}</${operation}Result><ResponseMetadata><RequestId>${requestId}</RequestId></ResponseMetadata></${operation}Response>`, { headers: { ...headers, "content-type": "text/xml" } })
      }
      return new Response(JSON.stringify(result ?? {}), { headers: { ...headers, "content-type": target ? request.headers.get("content-type") ?? "application/x-amz-json-1.1" : "application/json" } })
    } catch (error) {
      const failure = error instanceof AwsError ? error : new AwsError(error instanceof SyntaxError ? "SerializationException" : "ValidationException", error instanceof Error ? error.message : "Invalid request")
      if (query) return new Response(`<ErrorResponse><Error><Type>Sender</Type><Code>${awsXml(failure.code)}</Code><Message>${awsXml(failure.message)}</Message></Error><RequestId>${requestId}</RequestId></ErrorResponse>`, { status: failure.status, headers: { "content-type": "text/xml" } })
      return new Response(JSON.stringify({ __type: failure.code, message: failure.message, Message: failure.message }), { status: failure.status, headers: { "content-type": "application/x-amz-json-1.1", "x-amzn-errortype": failure.code, "x-amzn-requestid": requestId } })
    }
  }
  unsupported(operation: string): never { throw new AwsError("UnknownOperationException", `Unsupported operation ${operation}`) }
  get(collection: string, id: string, code = "ResourceNotFoundException") {
    const value = this.collection(collection).get(id)
    if (!value) throw new AwsError(code, `Resource ${id} does not exist`)
    return value
  }
}

export function decodeAwsQuery(params: URLSearchParams): AwsInput {
  const result: AwsInput = {}
  for (const [key, value] of params) {
    if (key === "Action" || key === "Version") continue
    const parts = key.split(".").filter(part => part !== "member")
    let current: AwsInput | unknown[] = result
    for (let index = 0; index < parts.length; index++) {
      const part = parts[index] as string
      const numeric = /^\d+$/.test(part)
      const slot = numeric ? Number(part) - 1 : part
      const object = current as AwsInput
      if (index === parts.length - 1) object[slot] = value
      else {
        const array = /^\d+$/.test(parts[index + 1] ?? "") || parts[index + 1] === "member"
        if (!object[slot]) object[slot] = array ? [] : {}
        current = object[slot] as AwsInput | unknown[]
      }
    }
  }
  return result
}
