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
export class CloudwatchAPI extends AwsProtocolAPI {
  constructor(options: APIOptions = {}) {
    super("cloudwatch", options)
  }
  dispatch({ operation, input }: AwsOperation): unknown {
    if (
      ![
        "PutMetricData",
        "ListMetrics",
        "GetMetricStatistics",
        "GetMetricData",
        "PutMetricAlarm",
        "DescribeAlarms",
        "DeleteAlarms",
        "EnableAlarmActions",
        "DisableAlarmActions",
        "SetAlarmState",
        "PutDashboard",
        "GetDashboard",
        "ListDashboards",
        "DeleteDashboards",
      ].includes(operation)
    )
      return this.unsupported(operation)
    const metrics = this.collection("metrics"),
      alarms = this.collection("alarms"),
      dashboards = this.collection("dashboards")
    const dimensions = (value: unknown) =>
      awsList(value)
        .map(awsRecord)
        .sort((a, b) => String(a.Name).localeCompare(String(b.Name)))
    const identity = (item: AwsInput) =>
      JSON.stringify([item.Namespace, item.MetricName, dimensions(item.Dimensions)])
    if (operation === "PutMetricData") {
      const namespace = awsRequired(input, "Namespace")
      for (const datum of awsList(input.MetricData).map(awsRecord)) {
        const metric: AwsInput = {
          ...datum,
          Namespace: namespace,
          Dimensions: dimensions(datum.Dimensions),
          Timestamp: datum.Timestamp
            ? new Date(String(datum.Timestamp)).toISOString()
            : new Date(this.now()).toISOString(),
        }
        awsRequired(metric, "MetricName")
        const id = identity(metric),
          prior = metrics.get(id)
        metrics.insert(id, {
          Namespace: namespace,
          MetricName: metric.MetricName,
          Dimensions: metric.Dimensions,
          Data: [...awsList(prior?.Data), metric],
        })
      }
      return {}
    }
    if (operation === "ListMetrics") {
      const values = metrics
        .list({
          order: "oldest",
          where: (item) =>
            (!input.Namespace || item.Namespace === input.Namespace) &&
            (!input.MetricName || item.MetricName === input.MetricName),
        })
        .map(({ value }) => ({
          Namespace: value.Namespace,
          MetricName: value.MetricName,
          Dimensions: value.Dimensions,
        }))
      const page = awsPage(values, input)
      return { Metrics: page.items, ...(page.token ? { NextToken: page.token } : {}) }
    }
    const stats = (query: AwsInput) => {
      const metric = metrics.get(identity(query))
      const start = Date.parse(String(query.StartTime)),
        end = Date.parse(String(query.EndTime)),
        period = Number(query.Period ?? 60) * 1000
      const buckets = new Map<number, number[]>()
      for (const item of awsList(metric?.Data).map(awsRecord)) {
        const time = Date.parse(String(item.Timestamp))
        if (time < start || time >= end) continue
        const key = Math.floor(time / period) * period,
          values = buckets.get(key) ?? []
        values.push(Number(item.Value ?? 0))
        buckets.set(key, values)
      }
      return [...buckets].map(([time, values]) => ({
        Timestamp: new Date(time).toISOString(),
        SampleCount: values.length,
        Sum: values.reduce((a, b) => a + b, 0),
        Minimum: Math.min(...values),
        Maximum: Math.max(...values),
        Average: values.reduce((a, b) => a + b, 0) / values.length,
        Unit: query.Unit ?? "None",
      }))
    }
    if (operation === "GetMetricStatistics") {
      const requested = awsList(input.Statistics).map(String)
      return {
        Label: input.MetricName,
        Datapoints: stats(input).map((item) =>
          Object.fromEntries(
            Object.entries(item).filter(
              ([key]) => requested.includes(key) || ["Timestamp", "Unit"].includes(key),
            ),
          ),
        ),
      }
    }
    if (operation === "GetMetricData")
      return {
        MetricDataResults: awsList(input.MetricDataQueries)
          .map(awsRecord)
          .map((query) => {
            const metricStat = awsRecord(query.MetricStat),
              metric = awsRecord(metricStat.Metric),
              points = stats({
                ...metric,
                ...metricStat,
                StartTime: input.StartTime,
                EndTime: input.EndTime,
              })
            return {
              Id: query.Id,
              Label: metric.MetricName,
              Timestamps: points.map((item) => item.Timestamp),
              Values: points.map((item) => item[metricStat.Stat as keyof typeof item] ?? 0),
              StatusCode: "Complete",
            }
          }),
        Messages: [],
      }
    if (operation === "PutMetricAlarm") {
      const name = awsRequired(input, "AlarmName")
      alarms.insert(name, {
        ...input,
        AlarmArn: this.arn("alarm:", name, "cloudwatch"),
        StateValue: "INSUFFICIENT_DATA",
        StateReason: "Unchecked: Initial alarm creation",
        ActionsEnabled: input.ActionsEnabled !== "false" && input.ActionsEnabled !== false,
        AlarmConfigurationUpdatedTimestamp: new Date(this.now()).toISOString(),
      })
      return {}
    }
    if (operation === "DescribeAlarms")
      return {
        MetricAlarms: alarms
          .list({
            order: "oldest",
            where: (item) =>
              !input.AlarmNames || awsList(input.AlarmNames).includes(item.AlarmName),
          })
          .map(({ value }) => value),
        CompositeAlarms: [],
      }
    if (operation === "DeleteAlarms") {
      for (const name of awsList(input.AlarmNames).map(String)) alarms.delete(name)
      return {}
    }
    if (["EnableAlarmActions", "DisableAlarmActions"].includes(operation)) {
      for (const name of awsList(input.AlarmNames).map(String)) {
        const alarm = this.get("alarms", name)
        alarms.insert(name, { ...alarm, ActionsEnabled: operation === "EnableAlarmActions" })
      }
      return {}
    }
    if (operation === "SetAlarmState") {
      const name = awsRequired(input, "AlarmName"),
        alarm = this.get("alarms", name)
      alarms.insert(name, {
        ...alarm,
        StateValue: input.StateValue,
        StateReason: input.StateReason,
        StateUpdatedTimestamp: new Date(this.now()).toISOString(),
      })
      return {}
    }
    if (operation === "PutDashboard") {
      const name = awsRequired(input, "DashboardName"),
        body = awsRequired(input, "DashboardBody")
      JSON.parse(body)
      dashboards.insert(name, {
        DashboardName: name,
        DashboardArn: `arn:aws:cloudwatch::${this.accountId}:dashboard/${name}`,
        DashboardBody: body,
        LastModified: new Date(this.now()).toISOString(),
        Size: body.length,
      })
      return { DashboardValidationMessages: [] }
    }
    if (operation === "GetDashboard")
      return this.get("dashboards", awsRequired(input, "DashboardName"), "DashboardNotFoundError")
    if (operation === "ListDashboards")
      return {
        DashboardEntries: dashboards
          .list({
            order: "oldest",
            where: (item) =>
              String(item.DashboardName).startsWith(String(input.DashboardNamePrefix ?? "")),
          })
          .map(({ value }) => value),
      }
    if (operation === "DeleteDashboards") {
      for (const name of awsList(input.DashboardNames).map(String)) dashboards.delete(name)
      return {}
    }
    return this.unsupported(operation)
  }
}
