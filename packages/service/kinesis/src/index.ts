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
} from "@emulates/service"
import { document, operationIds, supportedOperationIds } from "./generated/openapi.js"

export type { Runtime, RuntimeOptions } from "./runtime.js"
export { createRuntime } from "./runtime.js"
export { document, operationIds, supportedOperationIds }
export type APIOptions = AwsProtocolOptions
export class KinesisAPI extends AwsProtocolAPI {
  constructor(options: APIOptions = {}) {
    super("kinesis", options)
  }
  dispatch({ operation, input }: AwsOperation): unknown {
    if (
      ![
        "CreateStream",
        "DeleteStream",
        "ListStreams",
        "DescribeStream",
        "DescribeStreamSummary",
        "PutRecord",
        "PutRecords",
        "GetShardIterator",
        "GetRecords",
        "ListShards",
        "UpdateShardCount",
        "AddTagsToStream",
        "RemoveTagsFromStream",
        "ListTagsForStream",
      ].includes(operation)
    )
      return this.unsupported(operation)
    const streams = this.collection("streams"),
      records = this.collection("records"),
      iterators = this.collection("iterators")
    if (operation === "CreateStream") {
      const name = awsRequired(input, "StreamName")
      if (streams.has(name)) throw new AwsError("ResourceInUseException", "Stream already exists")
      const count = Number(input.ShardCount ?? 1)
      if (!Number.isInteger(count) || count < 1 || count > 10000)
        throw new AwsError("InvalidArgumentException", "Invalid ShardCount")
      streams.insert(name, {
        StreamName: name,
        StreamARN: this.arn("stream/", name, "kinesis"),
        StreamStatus: "ACTIVE",
        StreamCreationTimestamp: this.now() / 1000,
        RetentionPeriodHours: 24,
        ShardCount: count,
        Tags: {},
        Sequence: 0,
      })
      return {}
    }
    if (operation === "ListStreams") {
      const names = streams
        .list({ order: "oldest" })
        .map(({ id }) => id)
        .filter(
          (name) =>
            !input.ExclusiveStartStreamName || name > String(input.ExclusiveStartStreamName),
        )
      const page = awsPage(names, input, "NextToken", "Limit")
      return {
        StreamNames: page.items,
        HasMoreStreams: Boolean(page.token),
        ...(page.token ? { NextToken: page.token } : {}),
      }
    }
    if (operation === "GetRecords") {
      const token = this.get(
        "iterators",
        awsRequired(input, "ShardIterator"),
        "InvalidArgumentException",
      )
      if (Number(token.Expires) < this.now())
        throw new AwsError("ExpiredIteratorException", "Iterator expired")
      const found = records
        .list({
          order: "oldest",
          where: (record) =>
            record.StreamName === token.StreamName &&
            Number(record.SequenceNumber) > Number(token.Offset),
        })
        .map(({ value }) => value)
        .slice(0, Number(input.Limit ?? 10000))
      const next = this.ids.next("iterator-", 48)
      iterators.insert(next, {
        ...token,
        Offset: found.at(-1)?.SequenceNumber ?? token.Offset,
        Expires: this.now() + 300000,
      })
      return {
        Records: found.map(
          ({ Data, PartitionKey, SequenceNumber, ApproximateArrivalTimestamp }) => ({
            Data,
            PartitionKey,
            SequenceNumber,
            ApproximateArrivalTimestamp,
          }),
        ),
        NextShardIterator: next,
        MillisBehindLatest: 0,
      }
    }
    const name = String(
        input.StreamName ??
          String(input.StreamARN ?? "")
            .split("/")
            .at(-1) ??
          "",
      ),
      stream = this.get("streams", name)
    const shards = Array.from({ length: Number(stream.ShardCount) }, (_, index) => ({
      ShardId: `shardId-${String(index).padStart(12, "0")}`,
      HashKeyRange: {
        StartingHashKey: String(((1n << 128n) * BigInt(index)) / BigInt(Number(stream.ShardCount))),
        EndingHashKey: String(
          ((1n << 128n) * BigInt(index + 1)) / BigInt(Number(stream.ShardCount)) - 1n,
        ),
      },
      SequenceNumberRange: { StartingSequenceNumber: "1" },
    }))
    if (operation === "DeleteStream") {
      streams.delete(name)
      for (const row of records.list({ where: (item) => item.StreamName === name }))
        records.delete(row.id)
      return {}
    }
    if (operation === "DescribeStream")
      return {
        StreamDescription: {
          ...stream,
          Shards: shards,
          HasMoreShards: false,
          EnhancedMonitoring: [{ ShardLevelMetrics: [] }],
        },
      }
    if (operation === "DescribeStreamSummary")
      return {
        StreamDescriptionSummary: {
          ...stream,
          OpenShardCount: stream.ShardCount,
          EnhancedMonitoring: [{ ShardLevelMetrics: [] }],
        },
      }
    if (operation === "ListShards") return { Shards: shards }
    if (operation === "GetShardIterator") {
      const type = awsRequired(input, "ShardIteratorType")
      const offset =
        type === "LATEST"
          ? Number(stream.Sequence)
          : type === "AFTER_SEQUENCE_NUMBER"
            ? Number(input.StartingSequenceNumber)
            : type === "AT_SEQUENCE_NUMBER"
              ? Number(input.StartingSequenceNumber) - 1
              : 0
      const id = this.ids.next("iterator-", 48)
      iterators.insert(id, { StreamName: name, Offset: offset, Expires: this.now() + 300000 })
      return { ShardIterator: id }
    }
    const put = (item: AwsInput) => {
      const data = awsRequired(item, "Data"),
        key = awsRequired(item, "PartitionKey")
      atob(data)
      const prior = this.get("streams", name),
        sequence = Number(prior.Sequence) + 1
      streams.insert(name, { ...prior, Sequence: sequence })
      const record = {
        Data: data,
        PartitionKey: key,
        StreamName: name,
        SequenceNumber: String(sequence),
        ApproximateArrivalTimestamp: this.now() / 1000,
      }
      records.insert(`${name}:${sequence}`, record)
      return { SequenceNumber: String(sequence), ShardId: shards[0]?.ShardId }
    }
    if (operation === "PutRecord") return put(input)
    if (operation === "PutRecords") {
      const result = awsList(input.Records)
        .map(awsRecord)
        .map((item) => {
          try {
            return put(item)
          } catch (error) {
            return { ErrorCode: "InvalidArgumentException", ErrorMessage: String(error) }
          }
        })
      return {
        Records: result,
        FailedRecordCount: result.filter((item) => "ErrorCode" in item).length,
      }
    }
    if (operation === "UpdateShardCount") {
      streams.insert(name, { ...stream, ShardCount: Number(input.TargetShardCount) })
      return {
        StreamName: name,
        CurrentShardCount: stream.ShardCount,
        TargetShardCount: input.TargetShardCount,
      }
    }
    if (operation === "ListTagsForStream")
      return {
        Tags: Object.entries(awsRecord(stream.Tags)).map(([Key, Value]) => ({ Key, Value })),
        HasMoreTags: false,
      }
    if (operation === "AddTagsToStream" || operation === "RemoveTagsFromStream") {
      const tags = { ...awsRecord(stream.Tags), ...awsRecord(input.Tags) }
      for (const key of awsList(input.TagKeys).map(String)) delete tags[key]
      streams.insert(name, { ...stream, Tags: tags })
      return {}
    }
    return this.unsupported(operation)
  }
}
