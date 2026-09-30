import { jsonRes } from "@crvouga/mockingbird-service"

/** `details[].@type` for an FCM error code. firebase-admin reads `errorCode` from the first one. */
export const FCM_ERROR_TYPE = "type.googleapis.com/google.firebase.fcm.v1.FcmError"

export const RETRY_INFO_TYPE = "type.googleapis.com/google.rpc.RetryInfo"

/** Google's JSON 401 body. Status `UNAUTHENTICATED` has no FcmError details. */
export const UNAUTHENTICATED_MESSAGE =
  "Request had invalid authentication credentials. Expected OAuth 2 access token, login cookie or other valid authentication credential. See https://developers.google.com/identity/sign-in/web/devconsole-project."

export type RpcErrorBody = {
  error: {
    code: number
    message: string
    status: string
    details?: Record<string, unknown>[]
  }
}

type ErrorSpec = {
  http: number
  status: string
  message: string
  /** FCM `errorCode` placed in `details`. Null omits the FcmError detail. */
  fcm: string | null
  retry: boolean
}

const SPECS: Record<string, ErrorSpec> = {
  INVALID_ARGUMENT: {
    http: 400,
    status: "INVALID_ARGUMENT",
    message: "Request contains an invalid argument.",
    fcm: "INVALID_ARGUMENT",
    retry: false,
  },
  UNREGISTERED: {
    http: 404,
    status: "NOT_FOUND",
    message: "Requested entity was not found.",
    fcm: "UNREGISTERED",
    retry: false,
  },
  SENDER_ID_MISMATCH: {
    http: 403,
    status: "PERMISSION_DENIED",
    message: "SenderId mismatch",
    fcm: "SENDER_ID_MISMATCH",
    retry: false,
  },
  QUOTA_EXCEEDED: {
    http: 429,
    status: "RESOURCE_EXHAUSTED",
    message: "Quota exceeded for this project.",
    fcm: "QUOTA_EXCEEDED",
    retry: true,
  },
  UNAVAILABLE: {
    http: 503,
    status: "UNAVAILABLE",
    message: "The service is currently unavailable.",
    fcm: "UNAVAILABLE",
    retry: true,
  },
  INTERNAL: {
    http: 500,
    status: "INTERNAL",
    message: "Internal error encountered.",
    fcm: "INTERNAL",
    retry: false,
  },
  DEADLINE_EXCEEDED: {
    http: 504,
    status: "DEADLINE_EXCEEDED",
    message: "Deadline exceeded.",
    fcm: "DEADLINE_EXCEEDED",
    retry: false,
  },
  UNAUTHENTICATED: {
    http: 401,
    status: "UNAUTHENTICATED",
    message: UNAUTHENTICATED_MESSAGE,
    fcm: null,
    retry: false,
  },
  PERMISSION_DENIED: {
    http: 403,
    status: "PERMISSION_DENIED",
    message: "The caller does not have permission",
    fcm: null,
    retry: false,
  },
}

export const errorSpec = (code: string): ErrorSpec =>
  SPECS[code] ?? {
    http: 400,
    status: "INVALID_ARGUMENT",
    message: "Request contains an invalid argument.",
    fcm: "INVALID_ARGUMENT",
    retry: false,
  }

export const rpcBody = (
  code: string,
  message?: string,
  httpStatus?: number,
): { status: number; body: RpcErrorBody; headers: Record<string, string> } => {
  const spec = errorSpec(code)
  const status = httpStatus ?? spec.http
  const details: Record<string, unknown>[] = []
  if (spec.fcm) details.push({ "@type": FCM_ERROR_TYPE, errorCode: spec.fcm })
  if (spec.retry) details.push({ "@type": RETRY_INFO_TYPE, retryDelay: "1s" })
  const headers: Record<string, string> = {}
  if (spec.retry) headers["retry-after"] = "1"
  return {
    status,
    headers,
    body: {
      error: {
        code: status,
        message: message ?? spec.message,
        status: spec.status,
        ...(details.length > 0 ? { details } : {}),
      },
    },
  }
}

export const rpcResponse = (code: string, message?: string, httpStatus?: number): Response => {
  const built = rpcBody(code, message, httpStatus)
  return jsonRes(built.status, built.body, built.headers)
}
