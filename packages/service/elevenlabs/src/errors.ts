import { jsonRes } from "@crvouga/mockingbird-service"

/** The body of every error except a 422: the vendor's `detail` object. */
export type ErrorDetail = {
  /** The error family, which fixes the HTTP status: `authentication_error` is 401. */
  type: string
  code: string
  message: string
  /** The legacy identifier the vendor still sends beside `code`. */
  status: string
  request_id: string
  /** The request parameter at fault, when there is one. */
  param?: string
}

/** The vendor's error envelope, with the `x-trace-id` header that repeats `request_id`. */
export const vendorError = (httpStatus: number, detail: ErrorDetail): Response =>
  jsonRes(httpStatus, { detail }, { "x-trace-id": detail.request_id })
