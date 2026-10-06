import {
  AwsError,
  type AwsInput,
  type AwsOperation,
  AwsProtocolAPI,
  type AwsProtocolOptions,
  awsList,
  awsMd5,
  awsPage,
  awsParseXml,
  awsRecord,
  awsRequired,
  awsXml,
} from "@emulators/service"
import { document, operationIds, supportedOperationIds } from "./generated/openapi.js"

export type { Runtime, RuntimeOptions } from "./runtime.js"
export { createRuntime } from "./runtime.js"
export { document, operationIds, supportedOperationIds }
export type APIOptions = AwsProtocolOptions
export class SchedulerAPI extends AwsProtocolAPI {
  constructor(options: APIOptions = {}) {
    super("scheduler", options)
  }
  dispatch({ operation, input }: AwsOperation): unknown {
    if (
      ![
        "CreateSchedule",
        "GetSchedule",
        "ListSchedules",
        "UpdateSchedule",
        "DeleteSchedule",
        "CreateScheduleGroup",
        "GetScheduleGroup",
        "ListScheduleGroups",
        "DeleteScheduleGroup",
        "TagResource",
        "UntagResource",
        "ListTagsForResource",
      ].includes(operation)
    )
      return this.unsupported(operation)
    const schedules = this.collection("schedules"),
      groups = this.collection("groups")
    if (!groups.has("default"))
      groups.insert("default", {
        Name: "default",
        Arn: this.arn("schedule-group/", "default", "scheduler"),
        State: "ACTIVE",
        CreationDate: this.now() / 1000,
        LastModificationDate: this.now() / 1000,
      })
    if (operation === "CreateScheduleGroup") {
      const name = awsRequired(input, "Name")
      if (groups.has(name)) throw new AwsError("ConflictException", "Schedule group exists", 409)
      const arn = this.arn("schedule-group/", name, "scheduler")
      groups.insert(name, {
        Name: name,
        Arn: arn,
        State: "ACTIVE",
        CreationDate: this.now() / 1000,
        LastModificationDate: this.now() / 1000,
        Tags: input.Tags ?? [],
      })
      return { ScheduleGroupArn: arn }
    }
    if (operation === "ListScheduleGroups")
      return { ScheduleGroups: groups.list({ order: "oldest" }).map(({ value }) => value) }
    if (operation === "GetScheduleGroup") return this.get("groups", awsRequired(input, "Name"))
    if (operation === "DeleteScheduleGroup") {
      const name = awsRequired(input, "Name")
      this.get("groups", name)
      groups.delete(name)
      for (const row of schedules.list({ where: (item) => item.GroupName === name }))
        schedules.delete(row.id)
      return {}
    }
    if (["TagResource", "UntagResource", "ListTagsForResource"].includes(operation)) {
      const arn = awsRequired(input, "ResourceArn"),
        row = groups.list().find((row) => row.value.Arn === arn)
      if (!row) throw new AwsError("ResourceNotFoundException", "Group not found", 404)
      if (operation === "ListTagsForResource") return { Tags: row.value.Tags ?? [] }
      const incoming = awsList(input.Tags).map(awsRecord),
        removed =
          operation === "UntagResource" ? awsList(input.TagKeys) : incoming.map((tag) => tag.Key)
      groups.insert(row.id, {
        ...row.value,
        Tags: [
          ...awsList(row.value.Tags)
            .map(awsRecord)
            .filter((tag) => !removed.includes(tag.Key)),
          ...incoming,
        ],
      })
      return {}
    }
    const group = String(input.GroupName ?? "default"),
      name = String(input.Name ?? ""),
      id = `${group}:${name}`
    if (operation === "ListSchedules")
      return {
        Schedules: schedules
          .list({
            order: "oldest",
            where: (item) =>
              (!input.GroupName || item.GroupName === group) &&
              String(item.Name).startsWith(String(input.NamePrefix ?? "")),
          })
          .map(({ value }) => value),
      }
    if (operation === "CreateSchedule" || operation === "UpdateSchedule") {
      awsRequired(input, "Name")
      awsRequired(input, "ScheduleExpression")
      this.get("groups", group)
      const prior = schedules.get(id)
      if (operation === "CreateSchedule" && prior)
        throw new AwsError("ConflictException", "Schedule exists", 409)
      if (operation === "UpdateSchedule" && !prior)
        throw new AwsError("ResourceNotFoundException", "Schedule does not exist", 404)
      const arn = this.arn("schedule/", `${group}/${name}`, "scheduler")
      schedules.insert(id, {
        ...input,
        Arn: arn,
        GroupName: group,
        State: input.State ?? "ENABLED",
        ScheduleExpressionTimezone: input.ScheduleExpressionTimezone ?? "UTC",
        CreationDate: prior?.CreationDate ?? this.now() / 1000,
        LastModificationDate: this.now() / 1000,
      })
      return { ScheduleArn: arn }
    }
    if (operation === "GetSchedule") return this.get("schedules", id)
    if (operation === "DeleteSchedule") {
      this.get("schedules", id)
      schedules.delete(id)
      return {}
    }
    return this.unsupported(operation)
  }
  override route(method: string, pathname: string) {
    const match = /^\/(schedules|schedule-groups)(?:\/([^/]+))?$/.exec(pathname)
    if (!match) return undefined
    const kind = match[1] === "schedules" ? "Schedule" : "ScheduleGroup",
      name = match[2]
    const prefix =
      method === "POST"
        ? "Create"
        : method === "PUT"
          ? "Update"
          : method === "DELETE"
            ? "Delete"
            : "Get"
    return {
      operation: !name ? `List${kind}s` : `${prefix}${kind}`,
      params: name ? { Name: decodeURIComponent(name) } : {},
    }
  }
}
