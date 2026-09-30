/**
 * Live parity against FCM is intentionally not walked.
 *
 * FCM has no sandbox. `messages:send` delivers to a real device, and firebase-admin's
 * `validate_only` still requires a live Google project. Credentials are loaded so
 * `secrets:doctor` can see the key names; the script never calls fcm.googleapis.com
 * and never prints a secret value.
 *
 *   FCM_PROJECT_ID
 *   FCM_ACCESS_TOKEN
 */
import { CredentialError, loadCredentials } from "@crvouga/mockingbird-credentials"

try {
  await loadCredentials(
    {
      provider: "fcm",
      fields: { FCM_PROJECT_ID: "FCM_PROJECT_ID", FCM_ACCESS_TOKEN: "FCM_ACCESS_TOKEN" },
    },
    { env: process.env },
  )
} catch (error) {
  if (error instanceof CredentialError) {
    console.error(`fcm parity: no sandbox credentials. ${error.message}`)
    process.exit(2)
  }
  throw error
}

console.error(
  "fcm parity: credentials are present, but live sends are not walked. A send would deliver to a real device, and FCM has no sandbox.",
)
