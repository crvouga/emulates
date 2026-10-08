export const nativeOperationIds = [
  "repos/get",
  "git/get-ref",
  "git/list-matching-refs",
  "git/create-ref",
  "git/update-ref",
  "pulls/list",
  "pulls/create",
  "pulls/get",
  "pulls/update",
] as const
export type NativeOperationId = (typeof nativeOperationIds)[number]
