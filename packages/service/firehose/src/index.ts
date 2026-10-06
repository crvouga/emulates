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
export class FirehoseAPI extends AwsProtocolAPI {
  constructor(options: APIOptions = {}) {
    super("firehose", options)
  }
  dispatch({ operation, input }: AwsOperation): unknown {
    if (
      ![
        "CreateDeliveryStream",
        "DeleteDeliveryStream",
        "ListDeliveryStreams",
        "DescribeDeliveryStream",
        "PutRecord",
        "PutRecordBatch",
        "UpdateDestination",
        "TagDeliveryStream",
        "UntagDeliveryStream",
        "ListTagsForDeliveryStream",
      ].includes(operation)
    )
      return this.unsupported(operation)
    const streams = this.collection("streams")
    if (operation === "CreateDeliveryStream") {
      const name = awsRequired(input, "DeliveryStreamName")
      if (streams.has(name)) throw new AwsError("ResourceInUseException", "Delivery stream exists")
      const arn = this.arn("deliverystream/", name, "firehose")
      const destination = awsRecord(
        input.ExtendedS3DestinationConfiguration ??
          input.S3DestinationConfiguration ??
          input.HttpEndpointDestinationConfiguration,
      )
      streams.insert(name, {
        DeliveryStreamName: name,
        DeliveryStreamARN: arn,
        DeliveryStreamStatus: "ACTIVE",
        DeliveryStreamType: input.DeliveryStreamType ?? "DirectPut",
        VersionId: "1",
        CreateTimestamp: this.now() / 1000,
        Destinations: [
          { DestinationId: "destinationId-000000000001", S3DestinationDescription: destination },
        ],
        HasMoreDestinations: false,
        Tags: input.Tags ?? [],
      })
      return { DeliveryStreamARN: arn }
    }
    if (operation === "ListDeliveryStreams")
      return {
        DeliveryStreamNames: streams.list({ order: "oldest" }).map(({ id }) => id),
        HasMoreDeliveryStreams: false,
      }
    const name = awsRequired(input, "DeliveryStreamName"),
      stream = this.get("streams", name)
    if (operation === "DescribeDeliveryStream") {
      const { Tags: _tags, ...description } = stream
      return { DeliveryStreamDescription: description }
    }
    if (operation === "DeleteDeliveryStream") {
      streams.delete(name)
      return {}
    }
    const put = (record: AwsInput) => {
      const data = awsRequired(record, "Data")
      atob(data)
      const id = this.ids.next("record-", 32)
      this.collection("records").insert(id, {
        Data: data,
        DeliveryStreamName: name,
        Timestamp: this.now() / 1000,
      })
      return { RecordId: id }
    }
    if (operation === "PutRecord") return put(awsRecord(input.Record))
    if (operation === "PutRecordBatch") {
      const responses = awsList(input.Records).map(awsRecord).map(put)
      return { FailedPutCount: 0, RequestResponses: responses, Encrypted: false }
    }
    if (operation === "UpdateDestination") {
      streams.insert(name, {
        ...stream,
        VersionId: String(Number(stream.VersionId) + 1),
        Destinations: [
          {
            DestinationId: input.DestinationId,
            S3DestinationDescription:
              input.ExtendedS3DestinationUpdate ?? input.S3DestinationUpdate,
          },
        ],
      })
      return {}
    }
    if (operation === "ListTagsForDeliveryStream") return { Tags: stream.Tags, HasMoreTags: false }
    if (operation === "TagDeliveryStream" || operation === "UntagDeliveryStream") {
      const incoming = awsList(input.Tags).map(awsRecord),
        removed =
          operation === "UntagDeliveryStream"
            ? awsList(input.TagKeys)
            : incoming.map((item) => item.Key)
      streams.insert(name, {
        ...stream,
        Tags: [
          ...awsList(stream.Tags)
            .map(awsRecord)
            .filter((item) => !removed.includes(item.Key)),
          ...incoming,
        ],
      })
      return {}
    }
    return this.unsupported(operation)
  }
}
