import { CredentialError, loadCredentials } from "@emulates/credentials"
import { RecaptchaAPI } from "../src/index.js"

let secret: string
try {
  const credentials = await loadCredentials(
    { provider: "recaptcha", fields: { secret: "RECAPTCHA_SECRET_KEY" } },
    { env: process.env },
  )
  secret = credentials.values.secret as string
} catch (error) {
  if (error instanceof CredentialError) {
    console.error("recaptcha: missing RECAPTCHA_SECRET_KEY")
    process.exit(2)
  }
  throw error
}
// Safe rejection probe only: no browser challenge or customer token is submitted.
const live = await fetch("https://www.google.com/recaptcha/api/siteverify", {
  method: "POST",
  body: new URLSearchParams({ secret }),
})
const mock = await new RecaptchaAPI().fetch(
  new Request("http://recaptcha.test/recaptcha/api/siteverify", {
    method: "POST",
    body: new URLSearchParams({ secret: "mock_secret" }),
  }),
)
const liveBody = (await live.json()) as { success: boolean; "error-codes"?: string[] }
const mockBody = (await mock.json()) as { success: boolean; "error-codes"?: string[] }
if (
  live.status !== mock.status ||
  liveBody.success !== false ||
  !liveBody["error-codes"]?.includes("missing-input-response") ||
  !mockBody["error-codes"]?.includes("missing-input-response")
) {
  console.error(
    `recaptcha: missing-response rejection differs (live status ${live.status}); no credentials or bodies logged`,
  )
  process.exit(1)
}
console.log(
  "recaptcha: live missing-response rejection matches; successful browser challenges are not covered",
)
