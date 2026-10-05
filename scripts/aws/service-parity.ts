/** Bounded, read-only LocalStack envelope probes. Never targets a real AWS endpoint. */
import { strict as assert } from "node:assert"

const probes: Record<string, [string, string, string, Record<string, unknown>]> = {
  acm: ["acm", "ACMClient", "ListCertificatesCommand", {}],
  cloudwatch: ["cloudwatch", "CloudWatchClient", "ListMetricsCommand", {}],
  "cloudwatch-logs": ["cloudwatch-logs", "CloudWatchLogsClient", "DescribeLogGroupsCommand", {}],
  eventbridge: ["eventbridge", "EventBridgeClient", "ListEventBusesCommand", {}],
  firehose: ["firehose", "FirehoseClient", "ListDeliveryStreamsCommand", {}],
  iam: ["iam", "IAMClient", "ListUsersCommand", {}],
  kinesis: ["kinesis", "KinesisClient", "ListStreamsCommand", {}],
  kms: ["kms", "KMSClient", "ListKeysCommand", {}],
  "resource-groups": ["resource-groups", "ResourceGroupsClient", "ListGroupsCommand", {}],
  "resource-groups-tagging-api": [
    "resource-groups-tagging-api",
    "ResourceGroupsTaggingAPIClient",
    "GetResourcesCommand",
    {},
  ],
  scheduler: ["scheduler", "SchedulerClient", "ListSchedulesCommand", {}],
  ses: ["ses", "SESClient", "ListIdentitiesCommand", {}],
  sns: ["sns", "SNSClient", "ListTopicsCommand", {}],
  ssm: ["ssm", "SSMClient", "DescribeParametersCommand", {}],
  sts: ["sts", "STSClient", "GetCallerIdentityCommand", {}],
}

export async function serviceParity(service: string, mockEndpoint: string) {
  const probe = probes[service]
  if (!probe)
    throw new Error(
      `${service}: no implemented LocalStack oracle scenario; parity is not established`,
    )
  const oracleEndpoint = process.env.LOCALSTACK_ENDPOINT ?? "http://127.0.0.1:4566"
  for (const endpoint of [oracleEndpoint, mockEndpoint]) {
    const url = new URL(endpoint)
    if (
      !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
      !["http:", "https:"].includes(url.protocol)
    )
      throw new Error("LocalStack parity only accepts loopback endpoints")
  }
  const [module, clientName, commandName, input] = probe
  const sdk = await import(`@aws-sdk/client-${module}`)
  const read = async (endpoint: string): Promise<Record<string, unknown>> => {
    const client = new sdk[clientName]({
      endpoint,
      region: "us-east-1",
      maxAttempts: 1,
      credentials: { accessKeyId: "fixture", secretAccessKey: "fixture" },
    })
    try {
      return await client.send(new sdk[commandName](input))
    } finally {
      client.destroy()
    }
  }
  const oracle = await read(oracleEndpoint)
  const mock = await read(mockEndpoint)
  const shape = (result: Record<string, unknown>) =>
    Object.fromEntries(
      Object.entries(result)
        .filter(([key, value]) => key !== "$metadata" && value !== undefined)
        .map(([key, value]) => [key, Array.isArray(value) ? "array" : typeof value])
        .sort(([a], [b]) => String(a).localeCompare(String(b))),
    )
  assert.deepEqual(shape(mock), shape(oracle), `${service}: SDK response envelope differs`)
  console.log(
    `${service}: ${commandName} top-level SDK envelope matches; resource contents and write parity are not claimed`,
  )
}
