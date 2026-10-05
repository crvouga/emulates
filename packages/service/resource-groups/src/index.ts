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
} from "@crvouga/mockingbird-service"
import { document, operationIds, supportedOperationIds } from "./generated/openapi.js"

export type { Runtime, RuntimeOptions } from "./runtime.js"
export { createRuntime } from "./runtime.js"
export { document, operationIds, supportedOperationIds }
export type APIOptions = AwsProtocolOptions
export class ResourceGroupsAPI extends AwsProtocolAPI {
  constructor(options: APIOptions = {}) {
    super("resource-groups", options)
  }
  dispatch({ operation, input }: AwsOperation): unknown {
    if (
      ![
        "CreateGroup",
        "GetGroup",
        "ListGroups",
        "UpdateGroup",
        "DeleteGroup",
        "GetGroupQuery",
        "UpdateGroupQuery",
        "GetTags",
        "Tag",
        "Untag",
        "ListGroupResources",
      ].includes(operation)
    )
      return this.unsupported(operation)
    const groups = this.collection("groups")
    if (operation === "CreateGroup") {
      const name = awsRequired(input, "Name")
      if (groups.has(name)) throw new AwsError("BadRequestException", "Group exists")
      const group = {
        Name: name,
        GroupArn: this.arn("group/", name, "resource-groups"),
        Description: input.Description ?? "",
        ResourceQuery: input.ResourceQuery ?? {},
        Tags: input.Tags ?? {},
      }
      groups.insert(name, group)
      return {
        Group: this.publicGroup(group),
        ResourceQuery: group.ResourceQuery,
        Tags: group.Tags,
      }
    }
    if (operation === "ListGroups")
      return {
        GroupIdentifiers: groups
          .list({ order: "oldest" })
          .map(({ value }) => ({ GroupName: value.Name, GroupArn: value.GroupArn })),
        Groups: groups.list({ order: "oldest" }).map(({ value }) => this.publicGroup(value)),
      }
    const name =
        String(input.GroupName ?? input.Group ?? input.Arn ?? "")
          .split("/")
          .at(-1) ?? "",
      group = this.get("groups", name, "NotFoundException")
    if (operation === "GetGroup") return { Group: this.publicGroup(group) }
    if (operation === "DeleteGroup") {
      groups.delete(name)
      return { Group: this.publicGroup(group) }
    }
    if (operation === "UpdateGroup") {
      const updated = { ...group, Description: input.Description ?? group.Description }
      groups.insert(name, updated)
      return { Group: this.publicGroup(updated) }
    }
    if (operation === "GetGroupQuery")
      return { GroupQuery: { GroupName: name, ResourceQuery: group.ResourceQuery } }
    if (operation === "UpdateGroupQuery") {
      groups.insert(name, { ...group, ResourceQuery: input.ResourceQuery })
      return { GroupQuery: { GroupName: name, ResourceQuery: input.ResourceQuery } }
    }
    if (operation === "GetTags") return { Arn: group.GroupArn, Tags: group.Tags ?? {} }
    if (operation === "Tag" || operation === "Untag") {
      const tags = { ...awsRecord(group.Tags), ...awsRecord(input.Tags) }
      for (const key of awsList(input.Keys).map(String)) delete tags[key]
      groups.insert(name, { ...group, Tags: tags })
      return operation === "Tag"
        ? { Arn: group.GroupArn, Tags: input.Tags }
        : { Arn: group.GroupArn, Keys: input.Keys }
    }
    if (operation === "ListGroupResources") return { ResourceIdentifiers: [], QueryErrors: [] }
    return this.unsupported(operation)
  }
  private publicGroup(group: AwsInput) {
    return { Name: group.Name, GroupArn: group.GroupArn, Description: group.Description }
  }
  override route(method: string, path: string) {
    if (path === "/groups" && method === "GET") return { operation: "ListGroups", params: {} }
    if (path === "/groups" && method === "POST") return { operation: "CreateGroup", params: {} }
    const group = /^\/groups\/([^/]+)(?:\/(query|resources))?$/.exec(path)
    if (group)
      return {
        operation:
          group[2] === "query"
            ? method === "GET"
              ? "GetGroupQuery"
              : "UpdateGroupQuery"
            : group[2] === "resources"
              ? "ListGroupResources"
              : method === "DELETE"
                ? "DeleteGroup"
                : method === "POST"
                  ? "UpdateGroup"
                  : "GetGroup",
        params: { GroupName: decodeURIComponent(group[1] ?? "") },
      }
    const tag = /^\/resources\/([^/]+)\/tags$/.exec(path)
    if (tag)
      return {
        operation: method === "GET" ? "GetTags" : method === "DELETE" ? "Untag" : "Tag",
        params: { Arn: decodeURIComponent(tag[1] ?? "") },
      }
    return undefined
  }
}
