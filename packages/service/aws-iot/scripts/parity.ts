/**
 * Live parity: the same random walk over IoTDataPlane `Publish` against a real AWS IoT Core
 * data endpoint and a fresh emulator, canonicalized and diffed. Use a sandbox account whose
 * identity is allowed `iot:Publish`. Credentials come from the environment (`.env.local`
 * locally, repo secrets in the Parity workflow):
 *
 *   AWS_IOT_ENDPOINT            e.g. https://example-ats.iot.us-east-1.amazonaws.com
 *   AWS_IOT_REGION              e.g. us-east-1
 *   AWS_IOT_ACCESS_KEY_ID
 *   AWS_IOT_SECRET_ACCESS_KEY
 *
 * A publish reaches whoever subscribes to the topic, so nothing runs without
 * `--include-unsafe`. The MQTT surface is not covered here: `aws-iot.sdk.test.ts` drives it
 * with the consumer's client library.
 */
import { CredentialError, createRedactor, loadCredentials } from "@crvouga/mockingbird-credentials"
import { parity } from "@crvouga/mockingbird-parity"
import { AwsClient } from "aws4fetch"
import { AwsIotAPI, document, SIGNING_NAME } from "../src/index.js"

let credentials: Awaited<ReturnType<typeof loadCredentials>>
try {
  credentials = await loadCredentials(
    {
      provider: "aws-iot",
      fields: {
        AWS_IOT_ENDPOINT: "AWS_IOT_ENDPOINT",
        AWS_IOT_REGION: "AWS_IOT_REGION",
        AWS_IOT_ACCESS_KEY_ID: "AWS_IOT_ACCESS_KEY_ID",
        AWS_IOT_SECRET_ACCESS_KEY: "AWS_IOT_SECRET_ACCESS_KEY",
      },
    },
    { env: process.env },
  )
} catch (error) {
  if (error instanceof CredentialError) {
    console.error(`aws-iot parity: no sandbox credentials. ${error.message}`)
    process.exit(2)
  }
  throw error
}

const {
  AWS_IOT_ENDPOINT = "",
  AWS_IOT_REGION: region = "",
  AWS_IOT_ACCESS_KEY_ID: accessKeyId = "",
  AWS_IOT_SECRET_ACCESS_KEY: secretAccessKey = "",
} = credentials.values
const baseUrl = AWS_IOT_ENDPOINT.replace(/\/$/, "")
const signer = new AwsClient({ accessKeyId, secretAccessKey, region, service: SIGNING_NAME })
// With no credentials configured the emulator accepts any signed request, so one signer serves both.
const signed = (send: (request: Request) => Promise<Response>) => async (request: Request) =>
  send(await signer.sign(request))

const mock = new AwsIotAPI({ settings: { region } })

try {
  await parity({
    provider: "aws-iot",
    spec: document,
    env: process.env,
    includeUnsafe: process.argv.includes("--include-unsafe"),
    real: {
      baseUrl,
      allowedHosts: [new URL(baseUrl).host],
      fetch: signed((request) => fetch(request)),
      minIntervalMs: 100,
    },
    mock: { create: () => ({ fetch: signed((request) => mock.fetch(request)) }) },
    cleanup: async () => {
      await mock.reset()
    },
    redact: createRedactor(credentials.secrets),
  })
} catch (error) {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
