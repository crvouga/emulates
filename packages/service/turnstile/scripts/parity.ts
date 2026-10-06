import { CredentialError, loadCredentials } from "@emulators/credentials"
import { TurnstileAPI } from "../src/index.js"

let secret: string
try {
  const credentials = await loadCredentials(
    { provider: "turnstile", fields: { secret: "TURNSTILE_TEST_SECRET" } },
    { env: process.env },
  )
  secret = credentials.values.secret as string
} catch (error) {
  if (error instanceof CredentialError) {
    console.error("turnstile: missing TURNSTILE_TEST_SECRET (use a documented public dummy key)")
    process.exit(2)
  }
  throw error
}
// Only Cloudflare's published dummy keys are allowed. Never transmit a production credential.
const type = /^([123])x0{31}AA$/.exec(secret)?.[1]
if (!type) {
  console.error("turnstile: TURNSTILE_TEST_SECRET must be a documented public dummy key")
  process.exit(2)
}
const token = "XXXX.DUMMY.TOKEN.XXXX"
const mock = new TurnstileAPI({
  sites: [{ siteKey: "dummy", secret }],
  tokens:
    type === "2"
      ? []
      : [
          {
            token,
            siteKey: "dummy",
            issuedAt: Date.now(),
            hostname: "example.test",
            action: "",
            cdata: "",
            used: type === "3",
          },
        ],
})
for (const form of [false, true]) {
  await mock.reset()
  const data = { secret, response: token }
  const init = {
    method: "POST",
    headers: { "content-type": form ? "application/x-www-form-urlencoded" : "application/json" },
    body: form ? new URLSearchParams(data) : JSON.stringify(data),
  }
  const real = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", init)
  const expected = await mock.fetch(
    new Request("http://turnstile.test/turnstile/v0/siteverify", init),
  )
  const actualBody = (await real.json()) as { success: boolean; "error-codes": string[] }
  const expectedBody = (await expected.json()) as typeof actualBody
  if (
    real.status !== expected.status ||
    actualBody.success !== expectedBody.success ||
    JSON.stringify(actualBody["error-codes"]) !== JSON.stringify(expectedBody["error-codes"])
  ) {
    console.error(
      `turnstile: public dummy validation differs (HTTP ${real.status}); credentials withheld`,
    )
    process.exit(1)
  }
}
console.log("turnstile: public dummy success/error envelopes match for JSON and form")
