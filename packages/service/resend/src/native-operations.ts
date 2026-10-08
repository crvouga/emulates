export const nativeOperationIds = [
  "ListEmails",
  "SendEmail",
  "GetEmail",
  "ListReceivedEmails",
  "GetReceivedEmail",
  "ListReceivedEmailAttachments",
  "DownloadReceivedAttachment",
] as const
export type NativeOperationId = (typeof nativeOperationIds)[number]
