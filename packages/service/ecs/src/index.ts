import {
  type APIOptions,
  annotateResponse,
  bootSqlite,
  Collection,
  IdSequence,
} from "@emulates/service"
import { clearNamespace } from "@emulates/sqlite-client"

export { document, operationIds, supportedOperationIds } from "./generated/openapi.js"
export type { ECSRuntime, ECSRuntimeOptions } from "./runtime.js"
export { createRuntime, ECS_PRESETS } from "./runtime.js"
export const ECS_NAMESPACE = "ecs"
export type Cluster = { clusterArn: string; clusterName: string }
export type TaskDefinition = {
  taskDefinitionArn: string
  family: string
  revision: number
  containerDefinitions: { name: string }[]
  status?: string
}
export type Failure = { arn?: string; reason?: string; detail?: string }
export type Task = {
  taskArn: string
  clusterArn: string
  taskDefinitionArn: string
  lastStatus: string
  desiredStatus: string
  launchType: string
  createdAt: number
  overrides: Record<string, unknown>
  [key: string]: unknown
}
type RunResult = { tasks: Task[]; failures: Failure[] }
type Token = { fingerprint: string; result: RunResult; expiresAt: number }
export type ECSAPIOptions = APIOptions & {
  clusters?: Cluster[]
  taskDefinitions?: TaskDefinition[]
}
const prefix = "arn:aws:ecs:us-east-1:000000000000"
export const DEFAULT_CLUSTER: Cluster = {
  clusterArn: `${prefix}:cluster/default`,
  clusterName: "default",
}
export const DEFAULT_TASK_DEFINITION: TaskDefinition = {
  taskDefinitionArn: `${prefix}:task-definition/fixture:1`,
  family: "fixture",
  revision: 1,
  containerDefinitions: [{ name: "app" }],
}
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v)
const canonical = (v: unknown): string =>
  JSON.stringify(v, (_key, value) =>
    object(value)
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
      : value,
  )
export class ECSAPI {
  readonly clusters: Collection<Cluster>
  readonly taskDefinitions: Collection<TaskDefinition>
  readonly tasks: Collection<Task>
  readonly requests: Collection<{
    clusterArn: string
    taskDefinitionArn: string
    networkConfiguration: unknown
    taskArns: string[]
    failures: Failure[]
  }>
  readonly placementFailures: Collection<Failure>
  readonly tokens: Collection<Token>
  private readonly initialized: Collection<boolean>
  private readonly ids: IdSequence
  private readonly sqlite
  private readonly namespace: string
  private readonly now: () => number
  constructor(private readonly options: ECSAPIOptions = {}) {
    this.sqlite = bootSqlite(options.sqlite)
    this.namespace = options.namespace ?? ECS_NAMESPACE
    this.now = options.now ?? Date.now
    this.clusters = new Collection(this.sqlite, this.namespace, "clusters")
    this.taskDefinitions = new Collection(this.sqlite, this.namespace, "taskDefinitions")
    this.tasks = new Collection(this.sqlite, this.namespace, "tasks")
    this.requests = new Collection(this.sqlite, this.namespace, "requests")
    this.placementFailures = new Collection(this.sqlite, this.namespace, "placementFailures")
    this.tokens = new Collection(this.sqlite, this.namespace, "tokens")
    this.initialized = new Collection(this.sqlite, this.namespace, "initialized")
    this.ids = new IdSequence(this.sqlite, this.namespace, "ecs")
    this.seed()
  }
  private seed() {
    if (this.initialized.get("seed")) return
    for (const row of this.options.clusters ?? [DEFAULT_CLUSTER])
      this.clusters.insert(row.clusterArn, row)
    for (const row of this.options.taskDefinitions ?? [DEFAULT_TASK_DEFINITION])
      this.taskDefinitions.insert(row.taskDefinitionArn, row)
    this.initialized.insert("seed", true)
  }
  async reset() {
    clearNamespace(this.sqlite, this.namespace)
    this.seed()
  }
  private response(body: unknown, status = 200) {
    return Response.json(body, {
      status,
      headers: {
        "content-type": "application/x-amz-json-1.1",
        "x-amzn-requestid": "mock-ecs-request",
      },
    })
  }
  private error(type: string, message: string, extra = {}) {
    return this.response({ __type: type, message, ...extra }, 400)
  }
  async fetch(request: Request): Promise<Response> {
    if (
      request.method !== "POST" ||
      new URL(request.url).pathname !== "/" ||
      request.headers.get("x-amz-target") !== "AmazonEC2ContainerServiceV20141113.RunTask"
    )
      return this.error("UnknownOperationException", "Unknown operation")
    const body: unknown = await request.json().catch(() => null)
    if (!object(body)) return this.error("InvalidParameterException", "Expected a JSON object")
    const invalid = (message: string) => this.error("InvalidParameterException", message)
    if (typeof body.taskDefinition !== "string" || !body.taskDefinition)
      return invalid("taskDefinition is required")
    if (body.cluster !== undefined && (typeof body.cluster !== "string" || !body.cluster))
      return invalid("Invalid cluster")
    const count = body.count ?? 1
    if (!Number.isInteger(count) || Number(count) < 1 || Number(count) > 10)
      return invalid("count must be between 1 and 10")
    if (body.launchType !== "FARGATE")
      return invalid("This emulator supports the FARGATE launch type")
    if (
      body.clientToken !== undefined &&
      (typeof body.clientToken !== "string" || !/^[!-~]{1,64}$/.test(body.clientToken))
    )
      return invalid("Invalid clientToken")
    const cluster = this.clusters
      .list()
      .map((row) => row.value)
      .find(
        (row) => row.clusterName === (body.cluster ?? "default") || row.clusterArn === body.cluster,
      )
    if (!cluster) return this.error("ClusterNotFoundException", "Cluster not found")
    const definition = this.taskDefinitions
      .list()
      .map((row) => row.value)
      .filter(
        (row) =>
          row.status !== "INACTIVE" &&
          (row.taskDefinitionArn === body.taskDefinition ||
            `${row.family}:${row.revision}` === body.taskDefinition ||
            row.family === body.taskDefinition),
      )
      .sort((a, b) => b.revision - a.revision)[0]
    if (!definition) return this.error("ClientException", "Task definition not found")
    const network = body.networkConfiguration
    if (!object(network) || !object(network.awsvpcConfiguration))
      return invalid("Fargate requires awsvpcConfiguration")
    const awsvpc = network.awsvpcConfiguration
    if (
      !Array.isArray(awsvpc.subnets) ||
      !awsvpc.subnets.length ||
      awsvpc.subnets.length > 16 ||
      awsvpc.subnets.some((v) => typeof v !== "string" || !v)
    )
      return invalid("Invalid subnets")
    if (
      awsvpc.securityGroups !== undefined &&
      (!Array.isArray(awsvpc.securityGroups) ||
        awsvpc.securityGroups.length > 5 ||
        awsvpc.securityGroups.some((v) => typeof v !== "string" || !v))
    )
      return invalid("Invalid securityGroups")
    if (
      awsvpc.assignPublicIp !== undefined &&
      !["ENABLED", "DISABLED"].includes(String(awsvpc.assignPublicIp))
    )
      return invalid("Invalid assignPublicIp")
    const overrides = body.overrides ?? {}
    if (!object(overrides) || JSON.stringify(overrides).length > 8192)
      return invalid("Invalid overrides")
    if (overrides.containerOverrides !== undefined) {
      if (!Array.isArray(overrides.containerOverrides)) return invalid("Invalid containerOverrides")
      for (const override of overrides.containerOverrides) {
        if (
          !object(override) ||
          typeof override.name !== "string" ||
          !definition.containerDefinitions.some((c) => c.name === override.name)
        )
          return invalid("Override container not in task definition")
        if (
          override.command !== undefined &&
          (!Array.isArray(override.command) || override.command.some((v) => typeof v !== "string"))
        )
          return invalid("Invalid command override")
        if (
          override.environment !== undefined &&
          (!Array.isArray(override.environment) ||
            override.environment.some(
              (v) => !object(v) || typeof v.name !== "string" || typeof v.value !== "string",
            ))
        )
          return invalid("Invalid environment override")
      }
    }
    const fingerprint = canonical({
      ...body,
      cluster: cluster.clusterArn,
      taskDefinition: definition.taskDefinitionArn,
      count,
      clientToken: undefined,
    })
    const tokenKey =
      typeof body.clientToken === "string" ? `${cluster.clusterArn}:${body.clientToken}` : undefined
    const existing = tokenKey ? this.tokens.get(tokenKey) : undefined
    if (existing && existing.expiresAt > this.now()) {
      if (existing.fingerprint !== fingerprint)
        return this.error(
          "ConflictException",
          "clientToken is already associated with different parameters",
          { resourceIds: existing.result.tasks.map((t) => t.taskArn) },
        )
      return this.response(existing.result)
    }
    const failures = this.placementFailures
      .list({ order: "oldest" })
      .slice(0, Number(count))
      .map((row) => row.value)
    const tasks: Task[] = []
    for (let i = failures.length; i < Number(count); i++) {
      const taskArn = `${cluster.clusterArn.split(":cluster/")[0]}:task/${cluster.clusterName}/${this.ids.next("", 32)}`
      const task: Task = {
        taskArn,
        clusterArn: cluster.clusterArn,
        taskDefinitionArn: definition.taskDefinitionArn,
        lastStatus: "PROVISIONING",
        desiredStatus: "RUNNING",
        launchType: "FARGATE",
        createdAt: this.now() / 1000,
        overrides,
        group: body.group ?? `family:${definition.family}`,
        platformVersion: body.platformVersion ?? "LATEST",
        ...(typeof body.startedBy === "string" ? { startedBy: body.startedBy } : {}),
      }
      this.tasks.insert(taskArn, task)
      tasks.push(task)
    }
    const result = { tasks, failures }
    this.requests.insert(this.ids.next("request-", 16), {
      clusterArn: cluster.clusterArn,
      taskDefinitionArn: definition.taskDefinitionArn,
      networkConfiguration: network,
      taskArns: tasks.map((t) => t.taskArn),
      failures,
    })
    if (tokenKey)
      this.tokens.insert(tokenKey, { fingerprint, result, expiresAt: this.now() + 86400000 })
    return annotateResponse(this.response(result), {
      ids: Object.fromEntries(tasks.map((t, i) => [String(i), t.taskArn])),
    })
  }
}
