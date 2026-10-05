import type { MockCreateOptions, MockSurface } from "@crvouga/mockingbird-service"
import type { createRuntime as createAha } from "@crvouga/mockingbird-service-aha"
import type { createRuntime as createAwsSecrets } from "@crvouga/mockingbird-service-aws-secrets"
import type { createRuntime as createAwsSpeech } from "@crvouga/mockingbird-service-aws-speech"
import type { createRuntime as createBedrock } from "@crvouga/mockingbird-service-bedrock"
import type { createRuntime as createCaretalk } from "@crvouga/mockingbird-service-caretalk"
import type { createRuntime as createCognito } from "@crvouga/mockingbird-service-cognito"
import type { createRuntime as createCustomerio } from "@crvouga/mockingbird-service-customerio"
import type { createRuntime as createDaily } from "@crvouga/mockingbird-service-daily"
import type { createRuntime as createDynamodb } from "@crvouga/mockingbird-service-dynamodb"
import type { createRuntime as createEasypost } from "@crvouga/mockingbird-service-easypost"
import type { createRuntime as createEdamam } from "@crvouga/mockingbird-service-edamam"
import type { createRuntime as createFcm } from "@crvouga/mockingbird-service-fcm"
import type { createRuntime as createFirstpromoter } from "@crvouga/mockingbird-service-firstpromoter"
import type { createRuntime as createFlex } from "@crvouga/mockingbird-service-flex"
import type { createRuntime as createFormbricks } from "@crvouga/mockingbird-service-formbricks"
import type { createRuntime as createFullscript } from "@crvouga/mockingbird-service-fullscript"
import type { createRuntime as createGenebygene } from "@crvouga/mockingbird-service-genebygene"
import type { createRuntime as createGoogleAds } from "@crvouga/mockingbird-service-google-ads"
import type { createRuntime as createGoogleCalendar } from "@crvouga/mockingbird-service-google-calendar"
import type { createRuntime as createGoogleMaps } from "@crvouga/mockingbird-service-google-maps"
import type { createRuntime as createHealthie } from "@crvouga/mockingbird-service-healthie"
import type { createRuntime as createInfisical } from "@crvouga/mockingbird-service-infisical"
import type { createRuntime as createIntercom } from "@crvouga/mockingbird-service-intercom"
import type { createRuntime as createJunction } from "@crvouga/mockingbird-service-junction"
import type { createRuntime as createKillBill } from "@crvouga/mockingbird-service-kill-bill"
import type { createRuntime as createKlaviyo } from "@crvouga/mockingbird-service-klaviyo"
import type { createRuntime as createLivekit } from "@crvouga/mockingbird-service-livekit"
import type { createRuntime as createLlamacloud } from "@crvouga/mockingbird-service-llamacloud"
import type { createRuntime as createMailosaur } from "@crvouga/mockingbird-service-mailosaur"
import type { createRuntime as createMediaconvert } from "@crvouga/mockingbird-service-mediaconvert"
import type { createRuntime as createMedplum } from "@crvouga/mockingbird-service-medplum"
import type { createRuntime as createOauth } from "@crvouga/mockingbird-service-oauth"
import type { createRuntime as createOdx } from "@crvouga/mockingbird-service-odx"
import type { createRuntime as createOpenAI } from "@crvouga/mockingbird-service-openai"
import type { createRuntime as createOtel } from "@crvouga/mockingbird-service-otel"
import type { createRuntime as createOura } from "@crvouga/mockingbird-service-oura"
import type { createRuntime as createPaddle } from "@crvouga/mockingbird-service-paddle"
import type { createRuntime as createPayloadCms } from "@crvouga/mockingbird-service-payload-cms"
import type { createRuntime as createPersona } from "@crvouga/mockingbird-service-persona"
import type { createRuntime as createPharmetika } from "@crvouga/mockingbird-service-pharmetika"
import type { createRuntime as createPlane } from "@crvouga/mockingbird-service-plane"
import type { createRuntime as createPosthog } from "@crvouga/mockingbird-service-posthog"
import type { createRuntime as createPrism } from "@crvouga/mockingbird-service-prism"
import type { createRuntime as createResend } from "@crvouga/mockingbird-service-resend"
import type { createRuntime as createRxvortex } from "@crvouga/mockingbird-service-rxvortex"
import type { createRuntime as createS3 } from "@crvouga/mockingbird-service-s3"
import type { createRuntime as createSentry } from "@crvouga/mockingbird-service-sentry"
import type { createRuntime as createSlack } from "@crvouga/mockingbird-service-slack"
import type { createRuntime as createSqs } from "@crvouga/mockingbird-service-sqs"
import type { createRuntime as createStepFunctions } from "@crvouga/mockingbird-service-step-functions"
import type { createRuntime as createStripe } from "@crvouga/mockingbird-service-stripe"
import type { createRuntime as createTextract } from "@crvouga/mockingbird-service-textract"
import type { createRuntime as createTwilio } from "@crvouga/mockingbird-service-twilio"
import type { createRuntime as createVercelBlob } from "@crvouga/mockingbird-service-vercel-blob"
import type { createRuntime as createVpi } from "@crvouga/mockingbird-service-vpi"
import type { createRuntime as createWholescripts } from "@crvouga/mockingbird-service-wholescripts"

/**
 * Every HTTP mock is created the same way and returns the same surface.
 * Extra methods stay. A missing member, or a createRuntime that cannot be called
 * with `{ sqlite?, clock?, seed?, adminKey? }`, is a type error on that line.
 */
type Factory = (options?: MockCreateOptions) => MockSurface
type Assert<T extends Factory> = T

export type SurfaceProof = [
  Assert<typeof createOura>,
  Assert<typeof createAha>,
  Assert<typeof createAwsSecrets>,
  Assert<typeof createAwsSpeech>,
  Assert<typeof createBedrock>,
  Assert<typeof createCaretalk>,
  Assert<typeof createCognito>,
  Assert<typeof createCustomerio>,
  Assert<typeof createDaily>,
  Assert<typeof createDynamodb>,
  Assert<typeof createEasypost>,
  Assert<typeof createEdamam>,
  Assert<typeof createFcm>,
  Assert<typeof createFirstpromoter>,
  Assert<typeof createFlex>,
  Assert<typeof createFormbricks>,
  Assert<typeof createFullscript>,
  Assert<typeof createGenebygene>,
  Assert<typeof createGoogleCalendar>,
  Assert<typeof createGoogleMaps>,
  Assert<typeof createHealthie>,
  Assert<typeof createInfisical>,
  Assert<typeof createIntercom>,
  Assert<typeof createJunction>,
  Assert<typeof createKillBill>,
  Assert<typeof createKlaviyo>,
  Assert<typeof createLivekit>,
  Assert<typeof createLlamacloud>,
  Assert<typeof createMailosaur>,
  Assert<typeof createMediaconvert>,
  Assert<typeof createMedplum>,
  Assert<typeof createOauth>,
  Assert<typeof createGoogleAds>,
  Assert<typeof createOpenAI>,
  Assert<typeof createOdx>,
  Assert<typeof createOtel>,
  Assert<typeof createPaddle>,
  Assert<typeof createPayloadCms>,
  Assert<typeof createPersona>,
  Assert<typeof createPharmetika>,
  Assert<typeof createPlane>,
  Assert<typeof createPosthog>,
  Assert<typeof createPrism>,
  Assert<typeof createResend>,
  Assert<typeof createRxvortex>,
  Assert<typeof createSentry>,
  Assert<typeof createS3>,
  Assert<typeof createSlack>,
  Assert<typeof createSqs>,
  Assert<typeof createStepFunctions>,
  Assert<typeof createStripe>,
  Assert<typeof createTextract>,
  Assert<typeof createTwilio>,
  Assert<typeof createVercelBlob>,
  Assert<typeof createVpi>,
  Assert<typeof createWholescripts>,
]
