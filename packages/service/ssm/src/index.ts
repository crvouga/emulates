import { AwsProtocolAPI, AwsError, awsRecord, awsList, awsRequired, awsPage, awsMd5, awsXml, awsParseXml, type AwsInput, type AwsOperation, type AwsProtocolOptions } from "@crvouga/mockingbird-service"
import { document, operationIds, supportedOperationIds } from "./generated/openapi.js"
export { document, operationIds, supportedOperationIds }
export { createRuntime } from "./runtime.js"
export type { RuntimeOptions, Runtime } from "./runtime.js"
export type APIOptions = AwsProtocolOptions
export class SsmAPI extends AwsProtocolAPI {
  constructor(options: APIOptions = {}) { super("ssm", options) }
  dispatch({ operation, input }: AwsOperation): unknown {
    const parameters = this.collection("parameters"), history = this.collection("history")
    if (operation === "PutParameter") {
      const name = awsRequired(input, "Name"), value = awsRequired(input, "Value")
      const prior = parameters.get(name)
      if (prior && input.Overwrite !== true) throw new AwsError("ParameterAlreadyExists", "The parameter already exists")
      const type = String(input.Type ?? prior?.Type ?? "String")
      if (!["String", "StringList", "SecureString"].includes(type)) throw new AwsError("ValidationException", "Invalid parameter type")
      const version = Number(prior?.Version ?? 0) + 1
      const parameter = { Name: name, Value: value, Type: type, Version: version, LastModifiedDate: this.now() / 1000, ARN: this.arn("parameter", name.startsWith("/") ? name : `/${name}`, "ssm"), DataType: input.DataType ?? "text", Description: input.Description ?? "", KeyId: input.KeyId ?? "alias/aws/ssm", Tags: prior?.Tags ?? input.Tags ?? [], Tier: input.Tier ?? "Standard", Labels: [] }
      parameters.insert(name, parameter); history.insert(`${name}:${version}`, parameter)
      return { Version: version, Tier: parameter.Tier }
    }
    const visible = (parameter: AwsInput) => ({ Name: parameter.Name, Type: parameter.Type, Value: parameter.Type === "SecureString" && input.WithDecryption !== true ? `AQICAH${btoa(String(parameter.Value))}` : parameter.Value, Version: parameter.Version, LastModifiedDate: parameter.LastModifiedDate, ARN: parameter.ARN, DataType: parameter.DataType })
    const resolve = (name: string) => {
      const index = name.lastIndexOf(":")
      if (index < 0) return parameters.get(name)
      const key = name.slice(0, index), selector = name.slice(index + 1)
      const parameter = /^\d+$/.test(selector) ? history.get(`${key}:${selector}`) : history.list({ where: item => item.Name === key && awsList(item.Labels).includes(selector) })[0]?.value
      return parameter ? { ...parameter, Selector: `:${selector}` } : undefined
    }
    if (operation === "GetParameter") { const name = awsRequired(input, "Name"), parameter = resolve(name); if (!parameter) throw new AwsError("ParameterNotFound", `Parameter ${name} not found`); return { Parameter: { ...visible(parameter), ...(parameter.Selector ? { Selector: parameter.Selector } : {}) } } }
    if (operation === "GetParameters") { const found: AwsInput[] = [], invalid: string[] = []; for (const name of awsList(input.Names).map(String).sort()) { const parameter = resolve(name); if (parameter) found.push(visible(parameter)); else invalid.push(name) }; return { Parameters: found, InvalidParameters: invalid } }
    if (operation === "GetParametersByPath") {
      const path = awsRequired(input, "Path").replace(/\/$/, "") + "/"
      const values = parameters.list({ order: "oldest", where: item => String(item.Name).startsWith(path) && (input.Recursive === true || !String(item.Name).slice(path.length).includes("/")) }).map(({ value }) => visible(value))
      const page = awsPage(values, input); return { Parameters: page.items, ...(page.token ? { NextToken: page.token } : {}) }
    }
    if (operation === "DescribeParameters") { const page = awsPage(parameters.list({ order: "oldest" }).map(({ value }) => { const { Value: _value, ARN: _arn, ...metadata } = value; return metadata }), input); return { Parameters: page.items, ...(page.token ? { NextToken: page.token } : {}) } }
    if (operation === "GetParameterHistory") { const name = awsRequired(input, "Name"); if (!parameters.has(name)) throw new AwsError("ParameterNotFound", "Parameter not found"); const page = awsPage(history.list({ order: "oldest", where: item => item.Name === name }).map(({ value }) => ({ ...visible(value), Labels: value.Labels, Description: value.Description, KeyId: value.KeyId })), input); return { Parameters: page.items, ...(page.token ? { NextToken: page.token } : {}) } }
    if (operation === "DeleteParameter" || operation === "DeleteParameters") { const names = operation === "DeleteParameter" ? [awsRequired(input, "Name")] : awsList(input.Names).map(String); const deleted = [], invalid = []; for (const name of names) { if (!parameters.has(name)) { if (operation === "DeleteParameter") throw new AwsError("ParameterNotFound", "Parameter not found"); invalid.push(name); continue }; parameters.delete(name); for (const row of history.list({ where: item => item.Name === name })) history.delete(row.id); deleted.push(name) }; return operation === "DeleteParameter" ? {} : { DeletedParameters: deleted, InvalidParameters: invalid } }
    if (["AddTagsToResource", "RemoveTagsFromResource", "ListTagsForResource"].includes(operation)) { const id = awsRequired(input, "ResourceId"), item = this.get("parameters", id, "InvalidResourceId"); const tags = awsList(item.Tags).map(awsRecord); if (operation === "ListTagsForResource") return { TagList: tags }; const incoming = awsList(input.Tags).map(awsRecord); const removed = operation === "RemoveTagsFromResource" ? awsList(input.TagKeys) : incoming.map(tag => tag.Key); parameters.insert(id, { ...item, Tags: [...tags.filter(tag => !removed.includes(tag.Key)), ...incoming] }); return {} }
    if (["LabelParameterVersion", "UnlabelParameterVersion"].includes(operation)) { const name = awsRequired(input, "Name"), version = Number(input.ParameterVersion ?? this.get("parameters", name).Version), id = `${name}:${version}`, item = this.get("history", id, "ParameterVersionNotFound"); const labels = awsList(input.Labels).map(String); if (operation === "LabelParameterVersion") { for (const row of history.list({ where: item => item.Name === name })) history.insert(row.id, { ...row.value, Labels: awsList(row.value.Labels).filter(label => !labels.includes(String(label))) }); history.insert(id, { ...item, Labels: [...new Set([...awsList(item.Labels), ...labels])] }); return { InvalidLabels: [], ParameterVersion: version } }; history.insert(id, { ...item, Labels: awsList(item.Labels).filter(label => !labels.includes(String(label))) }); return { RemovedLabels: labels, InvalidLabels: [] } }
    return this.unsupported(operation)
  }

}
