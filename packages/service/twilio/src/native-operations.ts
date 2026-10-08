export const nativeOperationIds = [
  "FetchPhoneNumber",
  "CreateVerification",
  "FetchVerification",
  "UpdateVerification",
  "CreateVerificationCheck",
  "ListMessages",
  "CreateMessage",
  "FetchMessage",
  "FetchRecordingMedia",
  "FetchRecording",
  "DeleteRecording",
] as const
export type NativeOperationId = (typeof nativeOperationIds)[number]
