import { strict as assert } from "node:assert"
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateBucketCommand,
  CreateMultipartUploadCommand,
  DeleteBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  GetObjectTaggingCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  ListObjectVersionsCommand,
  PutBucketVersioningCommand,
  PutObjectCommand,
  PutObjectTaggingCommand,
  S3Client,
  UploadPartCommand,
} from "@aws-sdk/client-s3"
import {
  CreateQueueCommand,
  DeleteMessageBatchCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  ListQueueTagsCommand,
  ReceiveMessageCommand,
  SendMessageBatchCommand,
  SendMessageCommand,
  SetQueueAttributesCommand,
  SQSClient,
  TagQueueCommand,
} from "@aws-sdk/client-sqs"

const config = (endpoint: string) => ({
  endpoint,
  region: "us-east-1",
  maxAttempts: 1,
  credentials: { accessKeyId: "fixture", secretAccessKey: "fixture" },
})
const errorName = async (action: () => Promise<unknown>) => {
  try {
    await action()
    return "NO_ERROR"
  } catch (error) {
    return error instanceof Error ? error.name : String(error)
  }
}

export async function s3Scenario(endpoint: string) {
  const client = new S3Client({ ...config(endpoint), forcePathStyle: true })
  const bucket = `mockingbird-parity-${crypto.randomUUID()}`
  const keys: string[] = []
  try {
    await client.send(new CreateBucketCommand({ Bucket: bucket }))
    const put = await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: "a&/x//",
        Body: "hello",
        Metadata: { fixture: "yes" },
      }),
    )
    keys.push("a&/x//")
    const got = await client.send(new GetObjectCommand({ Bucket: bucket, Key: "a&/x//" }))
    const body = await got.Body?.transformToString()
    const condition = await errorName(() =>
      client.send(new GetObjectCommand({ Bucket: bucket, Key: "a&/x//", IfNoneMatch: put.ETag })),
    )
    const putCondition = await errorName(() =>
      client.send(
        new PutObjectCommand({ Bucket: bucket, Key: "a&/x//", Body: "bad", IfNoneMatch: "*" }),
      ),
    )
    await client.send(
      new PutObjectTaggingCommand({
        Bucket: bucket,
        Key: "a&/x//",
        Tagging: { TagSet: [{ Key: "kind", Value: "fixture" }] },
      }),
    )
    const tags = (await client.send(new GetObjectTaggingCommand({ Bucket: bucket, Key: "a&/x//" })))
      .TagSet
    for (const key of ["a/1", "a/2", "b/1", "z"]) {
      await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: key }))
      keys.push(key)
    }
    const first = await client.send(
      new ListObjectsV2Command({ Bucket: bucket, Delimiter: "/", MaxKeys: 1 }),
    )
    const second = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Delimiter: "/",
        MaxKeys: 1,
        ContinuationToken: first.NextContinuationToken,
      }),
    )
    const zero = await client.send(new ListObjectsV2Command({ Bucket: bucket, MaxKeys: 0 }))
    const upload = await client.send(
      new CreateMultipartUploadCommand({
        Bucket: bucket,
        Key: "multipart",
        Metadata: { fixture: "multipart" },
      }),
    )
    let multipart:
      | {
          invalidPart: string
          etag: string | undefined
          length: number | undefined
          metadata: Record<string, string> | undefined
        }
      | undefined
    try {
      const part = await client.send(
        new UploadPartCommand({
          Bucket: bucket,
          Key: "multipart",
          UploadId: upload.UploadId,
          PartNumber: 1,
          Body: "part",
        }),
      )
      const invalidPart = await errorName(() =>
        client.send(
          new CompleteMultipartUploadCommand({
            Bucket: bucket,
            Key: "multipart",
            UploadId: upload.UploadId,
            MultipartUpload: { Parts: [{ PartNumber: 1, ETag: '"invalid"' }] },
          }),
        ),
      )
      const completed = await client.send(
        new CompleteMultipartUploadCommand({
          Bucket: bucket,
          Key: "multipart",
          UploadId: upload.UploadId,
          MultipartUpload: { Parts: [{ PartNumber: 1, ETag: part.ETag }] },
        }),
      )
      keys.push("multipart")
      const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: "multipart" }))
      multipart = {
        invalidPart,
        etag: completed.ETag,
        length: head.ContentLength,
        metadata: head.Metadata,
      }
    } finally {
      await client
        .send(
          new AbortMultipartUploadCommand({
            Bucket: bucket,
            Key: "multipart",
            UploadId: upload.UploadId,
          }),
        )
        .catch(() => undefined)
    }
    await client.send(
      new PutBucketVersioningCommand({
        Bucket: bucket,
        VersioningConfiguration: { Status: "Enabled" },
      }),
    )
    const version = await client.send(
      new PutObjectCommand({ Bucket: bucket, Key: "versioned", Body: "old" }),
    )
    await client.send(new PutObjectCommand({ Bucket: bucket, Key: "versioned", Body: "new" }))
    const deleted = await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: "versioned" }))
    const missing = await errorName(() =>
      client.send(new GetObjectCommand({ Bucket: bucket, Key: "versioned" })),
    )
    const old = await client.send(
      new GetObjectCommand({ Bucket: bucket, Key: "versioned", VersionId: version.VersionId }),
    )
    const oldBody = await old.Body?.transformToString()
    const listed = await client.send(
      new ListObjectVersionsCommand({ Bucket: bucket, Prefix: "versioned" }),
    )
    const result = {
      body,
      etag: put.ETag,
      metadata: got.Metadata,
      condition,
      putCondition,
      tags,
      first: {
        contents: first.Contents?.map((item) => item.Key) ?? [],
        prefixes: first.CommonPrefixes?.map((item) => item.Prefix) ?? [],
        truncated: first.IsTruncated,
      },
      second: {
        contents: second.Contents?.map((item) => item.Key) ?? [],
        prefixes: second.CommonPrefixes?.map((item) => item.Prefix) ?? [],
        truncated: second.IsTruncated,
      },
      zero: { count: zero.KeyCount, truncated: zero.IsTruncated },
      multipart,
      versioning: {
        deleteMarker: deleted.DeleteMarker,
        missing,
        oldBody,
        versions: listed.Versions?.length,
        markers: listed.DeleteMarkers?.length,
      },
    }
    return result
  } finally {
    const versions = await client
      .send(new ListObjectVersionsCommand({ Bucket: bucket }))
      .catch(() => undefined)
    for (const item of [...(versions?.Versions ?? []), ...(versions?.DeleteMarkers ?? [])])
      await client
        .send(new DeleteObjectCommand({ Bucket: bucket, Key: item.Key, VersionId: item.VersionId }))
        .catch(() => undefined)
    for (const key of keys)
      await client
        .send(new DeleteObjectCommand({ Bucket: bucket, Key: key }))
        .catch(() => undefined)
    const remaining = await client
      .send(new ListObjectVersionsCommand({ Bucket: bucket }))
      .catch(() => undefined)
    for (const item of [...(remaining?.Versions ?? []), ...(remaining?.DeleteMarkers ?? [])])
      await client
        .send(new DeleteObjectCommand({ Bucket: bucket, Key: item.Key, VersionId: item.VersionId }))
        .catch(() => undefined)
    await client.send(new DeleteBucketCommand({ Bucket: bucket })).catch(() => undefined)
    client.destroy()
  }
}

export async function sqsScenario(endpoint: string) {
  const client = new SQSClient(config(endpoint))
  const name = `mockingbird-parity-${crypto.randomUUID()}`
  let QueueUrl: string | undefined
  let fifoUrl: string | undefined
  try {
    QueueUrl = (await client.send(new CreateQueueCommand({ QueueName: name }))).QueueUrl
    const different = await errorName(() =>
      client.send(
        new CreateQueueCommand({ QueueName: name, Attributes: { VisibilityTimeout: "40" } }),
      ),
    )
    await client.send(
      new SetQueueAttributesCommand({ QueueUrl, Attributes: { VisibilityTimeout: "60" } }),
    )
    await client.send(new TagQueueCommand({ QueueUrl, Tags: { fixture: "yes" } }))
    const tags = (await client.send(new ListQueueTagsCommand({ QueueUrl }))).Tags
    const sent = await client.send(
      new SendMessageCommand({
        QueueUrl,
        MessageBody: "hello",
        MessageAttributes: {
          kind: { DataType: "String", StringValue: "fixture" },
          count: { DataType: "Number", StringValue: "3" },
        },
      }),
    )
    const received = (
      await client.send(
        new ReceiveMessageCommand({
          QueueUrl,
          MessageAttributeNames: ["kind"],
          MessageSystemAttributeNames: ["ApproximateReceiveCount"],
        }),
      )
    ).Messages?.[0]
    const batch = await client.send(
      new DeleteMessageBatchCommand({
        QueueUrl,
        Entries: [
          { Id: "ok", ReceiptHandle: received?.ReceiptHandle },
          { Id: "bad", ReceiptHandle: "invalid" },
        ],
      }),
    )
    const duplicateIds = await errorName(() =>
      client.send(
        new SendMessageBatchCommand({
          QueueUrl,
          Entries: [
            { Id: "same", MessageBody: "a" },
            { Id: "same", MessageBody: "b" },
          ],
        }),
      ),
    )
    const emptyBody = await errorName(() =>
      client.send(new SendMessageCommand({ QueueUrl, MessageBody: "" })),
    )
    const attributes = (
      await client.send(
        new GetQueueAttributesCommand({
          QueueUrl,
          AttributeNames: [
            "VisibilityTimeout",
            "ApproximateNumberOfMessages",
            "ApproximateNumberOfMessagesNotVisible",
          ],
        }),
      )
    ).Attributes
    fifoUrl = (
      await client.send(
        new CreateQueueCommand({
          QueueName: `${name}.fifo`,
          Attributes: { FifoQueue: "true", ContentBasedDeduplication: "true" },
        }),
      )
    ).QueueUrl
    const first = await client.send(
      new SendMessageCommand({ QueueUrl: fifoUrl, MessageBody: "first", MessageGroupId: "one" }),
    )
    const duplicate = await client.send(
      new SendMessageCommand({ QueueUrl: fifoUrl, MessageBody: "first", MessageGroupId: "one" }),
    )
    await client.send(
      new SendMessageCommand({ QueueUrl: fifoUrl, MessageBody: "second", MessageGroupId: "one" }),
    )
    const messages = (
      await client.send(new ReceiveMessageCommand({ QueueUrl: fifoUrl, MaxNumberOfMessages: 10 }))
    ).Messages?.map((item) => item.Body)
    return {
      different,
      tags,
      body: received?.Body,
      bodyMd5: sent.MD5OfMessageBody,
      attributesMd5: sent.MD5OfMessageAttributes,
      selectedAttributes: received?.MessageAttributes,
      receivedAttributesMd5: received?.MD5OfMessageAttributes,
      systemAttributes: received?.Attributes,
      batch: {
        successful: batch.Successful?.map((item) => item.Id),
        failed: batch.Failed?.map((item) => ({
          id: item.Id,
          code: item.Code,
          senderFault: item.SenderFault,
        })),
      },
      duplicateIds,
      emptyBody,
      attributes,
      fifo: { deduplicated: first.MessageId === duplicate.MessageId, messages },
    }
  } finally {
    if (QueueUrl) await client.send(new DeleteQueueCommand({ QueueUrl })).catch(() => undefined)
    if (fifoUrl)
      await client.send(new DeleteQueueCommand({ QueueUrl: fifoUrl })).catch(() => undefined)
    client.destroy()
  }
}

export async function criticalParity(
  service: "s3" | "sqs",
  mockUrl: string,
  oracleUrl = process.env.MOCKINGBIRD_AWS_ORACLE_URL ?? "http://127.0.0.1:4566",
) {
  const host = new URL(oracleUrl).hostname
  if (
    !["127.0.0.1", "localhost", "[::1]"].includes(host) &&
    !host.endsWith(".localhost.localstack.cloud")
  )
    throw new Error("AWS parity requires a local emulator endpoint")
  const health = (await fetch(`${oracleUrl}/_localstack/health`).then((response) => {
    if (!response.ok) throw new Error("LocalStack health failed")
    return response.json()
  })) as { version?: string; edition?: string }
  const scenario = service === "s3" ? s3Scenario : sqsScenario
  const oracle = await scenario(oracleUrl)
  const mock = await scenario(mockUrl)
  assert.deepEqual(mock, oracle)
  console.log(
    `${service}: LocalStack ${health.version} (${health.edition}) differential scenario passed`,
  )
}
