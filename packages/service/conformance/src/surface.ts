import type { createRuntime as createAcm } from "@emulates/acm"
import type { createRuntime as createAha } from "@emulates/aha"
import type { createRuntime as createAirtable } from "@emulates/airtable"
import type { createRuntime as createApigateway } from "@emulates/apigateway"
import type { createRuntime as createAppStoreConnect } from "@emulates/app-store-connect"
import type { createRuntime as createAwsSecrets } from "@emulates/aws-secrets"
import type { createRuntime as createAwsSpeech } from "@emulates/aws-speech"
import type { createRuntime as createBedrock } from "@emulates/bedrock"
import type { createRuntime as createBrevo } from "@emulates/brevo"
import type { createRuntime as createCaretalk } from "@emulates/caretalk"
import type { createRuntime as createCheckr } from "@emulates/checkr"
import type { createRuntime as createCloudcontrol } from "@emulates/cloudcontrol"
import type { createRuntime as createCloudformation } from "@emulates/cloudformation"
import type { createRuntime as createCloudwatch } from "@emulates/cloudwatch"
import type { createRuntime as createCloudwatchLogs } from "@emulates/cloudwatch-logs"
import type { createRuntime as createCognito } from "@emulates/cognito"
import type { createRuntime as createConfig } from "@emulates/config"
import type { createRuntime as createCustomerio } from "@emulates/customerio"
import type { createRuntime as createDaily } from "@emulates/daily"
import type { createRuntime as createDocker } from "@emulates/docker"
import type { createRuntime as createDynamodb } from "@emulates/dynamodb"
import type { createRuntime as createDynamodbStreams } from "@emulates/dynamodb-streams"
import type { createRuntime as createEasypost } from "@emulates/easypost"
import type { createRuntime as createEc2 } from "@emulates/ec2"
import type { createRuntime as createECS } from "@emulates/ecs"
import type { createRuntime as createEdamam } from "@emulates/edamam"
import type { createRuntime as createElasticsearch } from "@emulates/elasticsearch"
import type { createRuntime as createEventBridge } from "@emulates/eventbridge"
import type { createRuntime as createFcm } from "@emulates/fcm"
import type { createRuntime as createFirehose } from "@emulates/firehose"
import type { createRuntime as createFirstpromoter } from "@emulates/firstpromoter"
import type { createRuntime as createFlex } from "@emulates/flex"
import type { createRuntime as createFormbricks } from "@emulates/formbricks"
import type { createRuntime as createFullscript } from "@emulates/fullscript"
import type { createRuntime as createGenebygene } from "@emulates/genebygene"
import type { createRuntime as createGithub } from "@emulates/github"
import type { createRuntime as createGoogleAds } from "@emulates/google-ads"
import type { createRuntime as createGoogleCalendar } from "@emulates/google-calendar"
import type { createRuntime as createGoogleMaps } from "@emulates/google-maps"
import type { createRuntime as createHealthie } from "@emulates/healthie"
import type { createRuntime as createHermes } from "@emulates/hermes"
import type { createRuntime as createIam } from "@emulates/iam"
import type { createRuntime as createInfisical } from "@emulates/infisical"
import type { createRuntime as createIntercom } from "@emulates/intercom"
import type { createRuntime as createJunction } from "@emulates/junction"
import type { createRuntime as createKillBill } from "@emulates/kill-bill"
import type { createRuntime as createKinesis } from "@emulates/kinesis"
import type { createRuntime as createKlaviyo } from "@emulates/klaviyo"
import type { createRuntime as createKms } from "@emulates/kms"
import type { createRuntime as createLambda } from "@emulates/lambda"
import type { createRuntime as createLivekit } from "@emulates/livekit"
import type { createRuntime as createLlamacloud } from "@emulates/llamacloud"
import type { createRuntime as createMailosaur } from "@emulates/mailosaur"
import type { createRuntime as createMediaconvert } from "@emulates/mediaconvert"
import type { createRuntime as createMedplum } from "@emulates/medplum"
import type { createRuntime as createMeta } from "@emulates/meta"
import type { createRuntime as createNotion } from "@emulates/notion"
import type { createRuntime as createOauth } from "@emulates/oauth"
import type { createRuntime as createOdx } from "@emulates/odx"
import type { createRuntime as createOpenAI } from "@emulates/openai"
import type { createRuntime as createOpensearch } from "@emulates/opensearch"
import type { createRuntime as createOtel } from "@emulates/otel"
import type { createRuntime as createOura } from "@emulates/oura"
import type { createRuntime as createPaddle } from "@emulates/paddle"
import type { createRuntime as createPayloadCms } from "@emulates/payload-cms"
import type { createRuntime as createPersona } from "@emulates/persona"
import type { createRuntime as createPharmetika } from "@emulates/pharmetika"
import type { createRuntime as createPlane } from "@emulates/plane"
import type { createRuntime as createPosthog } from "@emulates/posthog"
import type { createRuntime as createPrism } from "@emulates/prism"
import type { createRuntime as createRecaptcha } from "@emulates/recaptcha"
import type { createRuntime as createRedshift } from "@emulates/redshift"
import type { createRuntime as createResend } from "@emulates/resend"
import type { createRuntime as createResourceGroups } from "@emulates/resource-groups"
import type { createRuntime as createResourceGroupsTaggingApi } from "@emulates/resource-groups-tagging-api"
import type { createRuntime as createRoute53 } from "@emulates/route53"
import type { createRuntime as createRoute53resolver } from "@emulates/route53resolver"
import type { createRuntime as createRxvortex } from "@emulates/rxvortex"
import type { createRuntime as createS3 } from "@emulates/s3"
import type { createRuntime as createS3Control } from "@emulates/s3-control"
import type { createRuntime as createScheduler } from "@emulates/scheduler"
import type { createRuntime as createSentry } from "@emulates/sentry"
import type { MockCreateOptions, MockSurface } from "@emulates/service"
import type { createRuntime as createSes } from "@emulates/ses"
import type { createRuntime as createSlack } from "@emulates/slack"
import type { createRuntime as createSns } from "@emulates/sns"
import type { createRuntime as createSqs } from "@emulates/sqs"
import type { createRuntime as createSsm } from "@emulates/ssm"
import type { createRuntime as createStepFunctions } from "@emulates/step-functions"
import type { createRuntime as createStripe } from "@emulates/stripe"
import type { createRuntime as createSts } from "@emulates/sts"
import type { createRuntime as createSupport } from "@emulates/support"
import type { createRuntime as createSwf } from "@emulates/swf"
import type { createRuntime as createTavily } from "@emulates/tavily"
import type { createRuntime as createTextract } from "@emulates/textract"
import type { createRuntime as createTurnstile } from "@emulates/turnstile"
import type { createRuntime as createTwilio } from "@emulates/twilio"
import type { createRuntime as createUnsplash } from "@emulates/unsplash"
import type { createRuntime as createVanta } from "@emulates/vanta"
import type { createRuntime as createVercelBlob } from "@emulates/vercel-blob"
import type { createRuntime as createVibe } from "@emulates/vibe"
import type { createRuntime as createVpi } from "@emulates/vpi"
import type { createRuntime as createWholescripts } from "@emulates/wholescripts"
import type { createRuntime as createWhoop } from "@emulates/whoop"
import type { createRuntime as createWorkos } from "@emulates/workos"

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
