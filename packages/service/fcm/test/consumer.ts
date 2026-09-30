export type SendResult =
  | { ok: true; name: string }
  | {
      ok: false
      status: number
      errorStatus: string | undefined
      errorCode: string | undefined
    }

/**
 * The send our app would make: one HTTP v1 `messages:send`, reading `name` or the
 * Google RPC envelope (`error.status`, and `FcmError.errorCode` when present).
 */
export const sendToFcm = async (
  fetchImpl: (request: Request) => Promise<Response>,
  baseUrl: string,
  projectId: string,
  message: unknown,
  options: {
    bearer?: string
    validateOnly?: boolean
    headers?: Record<string, string>
  } = {},
): Promise<SendResult> => {
  const response = await fetchImpl(
    new Request(`${baseUrl}/v1/projects/${encodeURIComponent(projectId)}/messages:send`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${options.bearer ?? "fixture-token"}`,
        "content-type": "application/json",
        ...options.headers,
      },
      body: JSON.stringify({
        message,
        ...(options.validateOnly ? { validate_only: true } : {}),
      }),
    }),
  )
  const body = (await response.json()) as {
    name?: string
    error?: { status?: string; details?: { errorCode?: string }[] }
  }
  if (response.ok && typeof body.name === "string") return { ok: true, name: body.name }
  const detail = body.error?.details?.find((entry) => typeof entry.errorCode === "string")
  return {
    ok: false,
    status: response.status,
    errorStatus: body.error?.status,
    errorCode: detail?.errorCode,
  }
}
