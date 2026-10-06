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
export class ResourceGroupsTaggingApiAPI extends AwsProtocolAPI {
  constructor(options: APIOptions = {}) {
    super("resource-groups-tagging-api", options)
  }
  dispatch({ operation, input }: AwsOperation): unknown {
    if (
      !["TagResources", "UntagResources", "GetResources", "GetTagKeys", "GetTagValues"].includes(
        operation,
      )
    )
      return this.unsupported(operation)
    const resources = this.collection("resources")
    if (operation === "TagResources" || operation === "UntagResources") {
      for (const arn of awsList(input.ResourceARNList).map(String)) {
        const prior = resources.get(arn),
          tags = { ...awsRecord(prior?.Tags), ...awsRecord(input.Tags) }
        for (const key of awsList(input.TagKeys).map(String)) delete tags[key]
        resources.insert(arn, { ResourceARN: arn, Tags: tags })
      }
      return { FailedResourcesMap: {} }
    }
    if (operation === "GetResources") {
      const filters = awsList(input.TagFilters).map(awsRecord),
        page = awsPage(
          resources
            .list({
              order: "oldest",
              where: (item) =>
                (!input.ResourceARNList ||
                  awsList(input.ResourceARNList).includes(item.ResourceARN)) &&
                filters.every((filter) => {
                  const tags = awsRecord(item.Tags)
                  return (
                    String(filter.Key) in tags &&
                    (!awsList(filter.Values).length ||
                      awsList(filter.Values).includes(tags[String(filter.Key)]))
                  )
                }),
            })
            .map(({ value }) => ({
              ResourceARN: value.ResourceARN,
              Tags: Object.entries(awsRecord(value.Tags)).map(([Key, Value]) => ({ Key, Value })),
            })),
          input,
          "PaginationToken",
          "ResourcesPerPage",
        )
      return { ResourceTagMappingList: page.items, PaginationToken: page.token ?? "" }
    }
    if (operation === "GetTagKeys")
      return {
        TagKeys: [
          ...new Set(resources.list().flatMap(({ value }) => Object.keys(awsRecord(value.Tags)))),
        ],
        PaginationToken: "",
      }
    if (operation === "GetTagValues")
      return {
        TagValues: [
          ...new Set(
            resources.list().flatMap(({ value }) => {
              const tag = awsRecord(value.Tags)[String(input.Key)]
              return tag === undefined ? [] : [tag]
            }),
          ),
        ],
        PaginationToken: "",
      }
    return this.unsupported(operation)
  }
}
