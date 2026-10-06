import type { createRuntime as createAcm } from "@emulators/acm"
import type { createRuntime as createAha } from "@emulators/aha"
import type { createRuntime as createAirtable } from "@emulators/airtable"
import type { createRuntime as createApigateway } from "@emulators/apigateway"
import type { createRuntime as createAppStoreConnect } from "@emulators/app-store-connect"
import type { createRuntime as createAwsSecrets } from "@emulators/aws-secrets"
import type { createRuntime as createAwsSpeech } from "@emulators/aws-speech"
import type { createRuntime as createBedrock } from "@emulators/bedrock"
import type { createRuntime as createBrevo } from "@emulators/brevo"
import type { createRuntime as createCaretalk } from "@emulators/caretalk"
import type { createRuntime as createCheckr } from "@emulators/checkr"
import type { createRuntime as createCloudcontrol } from "@emulators/cloudcontrol"
import type { createRuntime as createCloudformation } from "@emulators/cloudformation"
import type { createRuntime as createCloudwatch } from "@emulators/cloudwatch"
import type { createRuntime as createCloudwatchLogs } from "@emulators/cloudwatch-logs"
import type { createRuntime as createCognito } from "@emulators/cognito"
import type { createRuntime as createConfig } from "@emulators/config"
import type { createRuntime as createCustomerio } from "@emulators/customerio"
import type { createRuntime as createDaily } from "@emulators/daily"
import type { createRuntime as createDocker } from "@emulators/docker"
import type { createRuntime as createDynamodb } from "@emulators/dynamodb"
import type { createRuntime as createDynamodbStreams } from "@emulators/dynamodb-streams"
import type { createRuntime as createEasypost } from "@emulators/easypost"
import type { createRuntime as createEc2 } from "@emulators/ec2"
import type { createRuntime as createECS } from "@emulators/ecs"
import type { createRuntime as createEdamam } from "@emulators/edamam"
import type { createRuntime as createElasticsearch } from "@emulators/elasticsearch"
import type { createRuntime as createEventBridge } from "@emulators/eventbridge"
import type { createRuntime as createFcm } from "@emulators/fcm"
import type { createRuntime as createFirehose } from "@emulators/firehose"
import type { createRuntime as createFirstpromoter } from "@emulators/firstpromoter"
import type { createRuntime as createFlex } from "@emulators/flex"
import type { createRuntime as createFormbricks } from "@emulators/formbricks"
import type { createRuntime as createFullscript } from "@emulators/fullscript"
import type { createRuntime as createGenebygene } from "@emulators/genebygene"
import type { createRuntime as createGithub } from "@emulators/github"
import type { createRuntime as createGoogleAds } from "@emulators/google-ads"
import type { createRuntime as createGoogleCalendar } from "@emulators/google-calendar"
import type { createRuntime as createGoogleMaps } from "@emulators/google-maps"
import type { createRuntime as createHealthie } from "@emulators/healthie"
import type { createRuntime as createHermes } from "@emulators/hermes"
import type { createRuntime as createIam } from "@emulators/iam"
import type { createRuntime as createInfisical } from "@emulators/infisical"
import type { createRuntime as createIntercom } from "@emulators/intercom"
import type { createRuntime as createJunction } from "@emulators/junction"
import type { createRuntime as createKillBill } from "@emulators/kill-bill"
import type { createRuntime as createKinesis } from "@emulators/kinesis"
import type { createRuntime as createKlaviyo } from "@emulators/klaviyo"
import type { createRuntime as createKms } from "@emulators/kms"
import type { createRuntime as createLambda } from "@emulators/lambda"
import type { createRuntime as createLivekit } from "@emulators/livekit"
import type { createRuntime as createLlamacloud } from "@emulators/llamacloud"
import type { createRuntime as createMailosaur } from "@emulators/mailosaur"
import type { createRuntime as createMediaconvert } from "@emulators/mediaconvert"
import type { createRuntime as createMedplum } from "@emulators/medplum"
import type { createRuntime as createMeta } from "@emulators/meta"
import type { createRuntime as createNotion } from "@emulators/notion"
import type { createRuntime as createOauth } from "@emulators/oauth"
import type { createRuntime as createOdx } from "@emulators/odx"
import type { createRuntime as createOpenAI } from "@emulators/openai"
import type { createRuntime as createOpensearch } from "@emulators/opensearch"
import type { createRuntime as createOtel } from "@emulators/otel"
import type { createRuntime as createOura } from "@emulators/oura"
import type { createRuntime as createPaddle } from "@emulators/paddle"
import type { createRuntime as createPayloadCms } from "@emulators/payload-cms"
import type { createRuntime as createPersona } from "@emulators/persona"
import type { createRuntime as createPharmetika } from "@emulators/pharmetika"
import type { createRuntime as createPlane } from "@emulators/plane"
import type { createRuntime as createPosthog } from "@emulators/posthog"
import type { createRuntime as createPrism } from "@emulators/prism"
import type { createRuntime as createRecaptcha } from "@emulators/recaptcha"
import type { createRuntime as createRedshift } from "@emulators/redshift"
import type { createRuntime as createResend } from "@emulators/resend"
import type { createRuntime as createResourceGroups } from "@emulators/resource-groups"
import type { createRuntime as createResourceGroupsTaggingApi } from "@emulators/resource-groups-tagging-api"
import type { createRuntime as createRoute53 } from "@emulators/route53"
import type { createRuntime as createRoute53resolver } from "@emulators/route53resolver"
import type { createRuntime as createRxvortex } from "@emulators/rxvortex"
import type { createRuntime as createS3 } from "@emulators/s3"
import type { createRuntime as createS3Control } from "@emulators/s3-control"
import type { createRuntime as createScheduler } from "@emulators/scheduler"
import type { createRuntime as createSentry } from "@emulators/sentry"
import type { MockCreateOptions, MockSurface } from "@emulators/service"
import type { createRuntime as createSes } from "@emulators/ses"
import type { createRuntime as createSlack } from "@emulators/slack"
import type { createRuntime as createSns } from "@emulators/sns"
import type { createRuntime as createSqs } from "@emulators/sqs"
import type { createRuntime as createSsm } from "@emulators/ssm"
import type { createRuntime as createStepFunctions } from "@emulators/step-functions"
import type { createRuntime as createStripe } from "@emulators/stripe"
import type { createRuntime as createSts } from "@emulators/sts"
import type { createRuntime as createSupport } from "@emulators/support"
import type { createRuntime as createSwf } from "@emulators/swf"
import type { createRuntime as createTavily } from "@emulators/tavily"
import type { createRuntime as createTextract } from "@emulators/textract"
import type { createRuntime as createTurnstile } from "@emulators/turnstile"
import type { createRuntime as createTwilio } from "@emulators/twilio"
import type { createRuntime as createUnsplash } from "@emulators/unsplash"
import type { createRuntime as createVanta } from "@emulators/vanta"
import type { createRuntime as createVercelBlob } from "@emulators/vercel-blob"
import type { createRuntime as createVibe } from "@emulators/vibe"
import type { createRuntime as createVpi } from "@emulators/vpi"
import type { createRuntime as createWholescripts } from "@emulators/wholescripts"
import type { createRuntime as createWhoop } from "@emulators/whoop"
import type { createRuntime as createWorkos } from "@emulators/workos"

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
  Assert<typeof createTavily>,
  Assert<typeof createAwsSecrets>,
  Assert<typeof createAwsSpeech>,
  Assert<typeof createBedrock>,
  Assert<typeof createBrevo>,
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
  Assert<typeof createNotion>,
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
  Assert<typeof createRecaptcha>,
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
  Assert<typeof createTurnstile>,
  Assert<typeof createVercelBlob>,
  Assert<typeof createVpi>,
  Assert<typeof createVanta>,
  Assert<typeof createWholescripts>,
  Assert<typeof createAppStoreConnect>,
  Assert<typeof createAirtable>,
  Assert<typeof createCheckr>,
  Assert<typeof createWhoop>,
  Assert<typeof createWorkos>,
  Assert<typeof createECS>,
  Assert<typeof createEventBridge>,
  Assert<typeof createVibe>,
  Assert<typeof createUnsplash>,
  Assert<typeof createMeta>,
  Assert<typeof createKinesis>,
  Assert<typeof createSsm>,
  Assert<typeof createKms>,
  Assert<typeof createCloudwatch>,
  Assert<typeof createDocker>,
  Assert<typeof createS3Control>,
  Assert<typeof createCloudwatchLogs>,
  Assert<typeof createSns>,
  Assert<typeof createConfig>,
  Assert<typeof createOpensearch>,
  Assert<typeof createResourceGroupsTaggingApi>,
  Assert<typeof createScheduler>,
  Assert<typeof createRoute53resolver>,
  Assert<typeof createCloudcontrol>,
  Assert<typeof createRedshift>,
  Assert<typeof createIam>,
  Assert<typeof createGithub>,
  Assert<typeof createSupport>,
  Assert<typeof createLambda>,
  Assert<typeof createDynamodbStreams>,
  Assert<typeof createHermes>,
  Assert<typeof createFirehose>,
  Assert<typeof createSes>,
  Assert<typeof createCloudformation>,
  Assert<typeof createSwf>,
  Assert<typeof createElasticsearch>,
  Assert<typeof createApigateway>,
  Assert<typeof createSts>,
  Assert<typeof createAcm>,
  Assert<typeof createEc2>,
  Assert<typeof createResourceGroups>,
  Assert<typeof createRoute53>,
]
