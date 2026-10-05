import { AwsProtocolAPI, AwsError, awsRecord, awsList, awsRequired, awsPage, awsMd5, awsXml, awsParseXml, type AwsInput, type AwsOperation, type AwsProtocolOptions } from "@crvouga/mockingbird-service"
import { document, operationIds, supportedOperationIds } from "./generated/openapi.js"
export { document, operationIds, supportedOperationIds }
export { createRuntime } from "./runtime.js"
export type { RuntimeOptions, Runtime } from "./runtime.js"
export type APIOptions = AwsProtocolOptions
export class EventbridgeAPI extends AwsProtocolAPI {
  constructor(options: APIOptions = {}) { super("eventbridge", options) }
  private bus(name: unknown) {
    const id = String(name ?? "default"), buses = this.collection("buses")
    if (id === "default" && !buses.has(id)) buses.insert(id, { Name: id, Arn: this.arn("event-bus/", id, "events") })
    return this.get("buses", id)
  }
  dispatch({ operation, input }: AwsOperation): unknown {
    const buses = this.collection("buses"), rules = this.collection("rules"), targets = this.collection("targets")
    this.bus("default")
    if (operation === "CreateEventBus") { const name = awsRequired(input, "Name"); if (buses.has(name)) throw new AwsError("ResourceAlreadyExistsException", "Event bus exists"); const arn = this.arn("event-bus/", name, "events"); buses.insert(name, { Name: name, Arn: arn, Description: input.Description, Tags: input.Tags ?? [] }); return { EventBusArn: arn } }
    if (operation === "ListEventBuses") return { EventBuses: buses.list({ order: "oldest" }).map(({ value }) => value) }
    if (operation === "DescribeEventBus") return this.bus(input.Name)
    if (operation === "DeleteEventBus") { const name = awsRequired(input, "Name"); if (name === "default") throw new AwsError("ValidationException", "Cannot delete default bus"); this.bus(name); buses.delete(name); return {} }
    const busName = String(input.EventBusName ?? "default")
    if (operation === "PutEvents") { const entries = awsList(input.Entries).map(awsRecord).map(item => { if (!item.Source || !item.DetailType || !item.Detail) return { ErrorCode: "InvalidArgument", ErrorMessage: "Source, DetailType and Detail are required" }; let detail: unknown; try { detail = JSON.parse(String(item.Detail)) } catch { return { ErrorCode: "MalformedDetail", ErrorMessage: "Detail is not valid JSON" } }; const eventId = this.ids.next("event-", 32); this.collection("events").insert(eventId, { ...item, EventId: eventId, Detail: detail, Time: item.Time ?? this.now() / 1000 }); return { EventId: eventId } }); return { Entries: entries, FailedEntryCount: entries.filter(item => "ErrorCode" in item).length } }
    if (operation === "ListTagsForResource" || operation === "TagResource" || operation === "UntagResource") { const arn = awsRequired(input, "ResourceARN"), row = [...buses.list().map(row => ({ ...row, kind: "buses" })), ...rules.list().map(row => ({ ...row, kind: "rules" }))].find(row => row.value.Arn === arn); if (!row) throw new AwsError("ResourceNotFoundException", "Resource not found"); if (operation === "ListTagsForResource") return { Tags: row.value.Tags ?? [] }; const incoming = awsList(input.Tags).map(awsRecord), removed = operation === "UntagResource" ? awsList(input.TagKeys) : incoming.map(tag => tag.Key); this.collection(row.kind).insert(row.id, { ...row.value, Tags: [...awsList(row.value.Tags).map(awsRecord).filter(tag => !removed.includes(tag.Key)), ...incoming] }); return {} }
    this.bus(busName)
    if (operation === "PutRule") { const name = awsRequired(input, "Name"), id = `${busName}:${name}`, arn = this.arn("rule/", busName === "default" ? name : `${busName}/${name}`, "events"); if (input.EventPattern) JSON.parse(String(input.EventPattern)); rules.insert(id, { ...rules.get(id), ...input, Name: name, Arn: arn, EventBusName: busName, State: input.State ?? "ENABLED" }); return { RuleArn: arn } }
    if (operation === "ListRules") return { Rules: rules.list({ order: "oldest", where: item => item.EventBusName === busName && String(item.Name).startsWith(String(input.NamePrefix ?? "")) }).map(({ value }) => value) }
    const name = String(input.Name ?? input.Rule ?? ""), id = `${busName}:${name}`, rule = this.get("rules", id)
    if (operation === "DescribeRule") return rule
    if (operation === "DeleteRule") { const attached = targets.list({ where: item => item.RuleId === id }); if (attached.length && input.Force !== true) throw new AwsError("ConcurrentModificationException", "Rule has targets"); rules.delete(id); for (const row of attached) targets.delete(row.id); return {} }
    if (operation === "EnableRule" || operation === "DisableRule") { rules.insert(id, { ...rule, State: operation === "EnableRule" ? "ENABLED" : "DISABLED" }); return {} }
    if (operation === "PutTargets") { for (const target of awsList(input.Targets).map(awsRecord)) targets.insert(`${id}:${awsRequired(target, "Id")}`, { ...target, RuleId: id }); return { FailedEntryCount: 0, FailedEntries: [] } }
    if (operation === "ListTargetsByRule") return { Targets: targets.list({ order: "oldest", where: item => item.RuleId === id }).map(({ value }) => { const { RuleId: _rule, ...rest } = value; return rest }) }
    if (operation === "RemoveTargets") { for (const target of awsList(input.Ids).map(String)) targets.delete(`${id}:${target}`); return { FailedEntryCount: 0, FailedEntries: [] } }
    return this.unsupported(operation)
  }

}
