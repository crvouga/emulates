# Migrating from Mockingbird

Mockingbird has been renamed to Emulators. Packages have moved from their previous names to the corresponding `@emulators/*` packages; the old npm packages remain available but are deprecated.

## Existing checkouts of this repo

Run `bun run rebrand:bootstrap` once in each clone. It points `origin` at `crvouga/emulators`, renames
`MOCKINGBIRD_*` keys in `.env.local` to `EMULATORS_*` (values are never printed), moves the gitignored
`.mockingbird/` state directory to `.emulators/`, and reinstalls so workspace links use the new
package names. It is safe to re-run.

## Install the new package

The code is the same; only names changed. Swap the dependency and the import specifier:

```bash
npm uninstall @crvouga/mockingbird-service-postgres
npm install -D @emulators/postgres
```

```ts
// before
import { createRuntime } from "@crvouga/mockingbird-service-stripe"
// after
import { createRuntime } from "@emulators/stripe"
```

Each `@emulators/<id>` package continues its former package's version line, so the first `@emulators` release is newer than the last `@crvouga/mockingbird-service-*` one. Old versions stay installable; they are never unpublished.

## Other renamed names

| Before | After |
| --- | --- |
| `mockingbird-<id>` CLI (e.g. `npx mockingbird-stripe serve`) | `emulators-<id>` (`npx emulators-stripe serve`) |
| `mockingbird.json` fleet config | `emulators.json` |
| `x-mockingbird-*` HTTP headers and OpenAPI extensions | `x-emulators-*` |
| `MOCKINGBIRD_*` environment variables | `EMULATORS_*` |
| `.mockingbird/` local state directory | `.emulators/` |
| https://github.com/crvouga/mockingbird | https://github.com/crvouga/emulators (GitHub redirects the old URL) |
| https://mockingbird.chrisvouga.dev | https://emulators.chrisvouga.dev |

## Package mapping

| Previous package | New package |
| --- | --- |
| `@crvouga/mockingbird-service-acm` | `@emulators/acm` |
| `@crvouga/mockingbird-service-aha` | `@emulators/aha` |
| `@crvouga/mockingbird-service-airtable` | `@emulators/airtable` |
| `@crvouga/mockingbird-service-apigateway` | `@emulators/apigateway` |
| `@crvouga/mockingbird-service-app-store-connect` | `@emulators/app-store-connect` |
| `@crvouga/mockingbird-service-aws-secrets` | `@emulators/aws-secrets` |
| `@crvouga/mockingbird-service-aws-speech` | `@emulators/aws-speech` |
| `@crvouga/mockingbird-service-bedrock` | `@emulators/bedrock` |
| `@crvouga/mockingbird-service-brevo` | `@emulators/brevo` |
| `@crvouga/mockingbird-service-caretalk` | `@emulators/caretalk` |
| `@crvouga/mockingbird-service-checkr` | `@emulators/checkr` |
| `@crvouga/mockingbird-service-cloudcontrol` | `@emulators/cloudcontrol` |
| `@crvouga/mockingbird-service-cloudformation` | `@emulators/cloudformation` |
| `@crvouga/mockingbird-service-cloudwatch` | `@emulators/cloudwatch` |
| `@crvouga/mockingbird-service-cloudwatch-logs` | `@emulators/cloudwatch-logs` |
| `@crvouga/mockingbird-service-cognito` | `@emulators/cognito` |
| `@crvouga/mockingbird-service-config` | `@emulators/config` |
| `@crvouga/mockingbird-service-customerio` | `@emulators/customerio` |
| `@crvouga/mockingbird-service-daily` | `@emulators/daily` |
| `@crvouga/mockingbird-service-docker` | `@emulators/docker` |
| `@crvouga/mockingbird-service-dynamodb` | `@emulators/dynamodb` |
| `@crvouga/mockingbird-service-dynamodb-streams` | `@emulators/dynamodb-streams` |
| `@crvouga/mockingbird-service-easypost` | `@emulators/easypost` |
| `@crvouga/mockingbird-service-ec2` | `@emulators/ec2` |
| `@crvouga/mockingbird-service-ecs` | `@emulators/ecs` |
| `@crvouga/mockingbird-service-edamam` | `@emulators/edamam` |
| `@crvouga/mockingbird-service-elasticsearch` | `@emulators/elasticsearch` |
| `@crvouga/mockingbird-service-eventbridge` | `@emulators/eventbridge` |
| `@crvouga/mockingbird-service-fcm` | `@emulators/fcm` |
| `@crvouga/mockingbird-service-firehose` | `@emulators/firehose` |
| `@crvouga/mockingbird-service-firstpromoter` | `@emulators/firstpromoter` |
| `@crvouga/mockingbird-service-flex` | `@emulators/flex` |
| `@crvouga/mockingbird-service-formbricks` | `@emulators/formbricks` |
| `@crvouga/mockingbird-service-fullscript` | `@emulators/fullscript` |
| `@crvouga/mockingbird-service-genebygene` | `@emulators/genebygene` |
| `@crvouga/mockingbird-service-github` | `@emulators/github` |
| `@crvouga/mockingbird-service-google-ads` | `@emulators/google-ads` |
| `@crvouga/mockingbird-service-google-calendar` | `@emulators/google-calendar` |
| `@crvouga/mockingbird-service-google-maps` | `@emulators/google-maps` |
| `@crvouga/mockingbird-service-healthie` | `@emulators/healthie` |
| `@crvouga/mockingbird-service-hermes` | `@emulators/hermes` |
| `@crvouga/mockingbird-service-iam` | `@emulators/iam` |
| `@crvouga/mockingbird-service-infisical` | `@emulators/infisical` |
| `@crvouga/mockingbird-service-intercom` | `@emulators/intercom` |
| `@crvouga/mockingbird-service-junction` | `@emulators/junction` |
| `@crvouga/mockingbird-service-kill-bill` | `@emulators/kill-bill` |
| `@crvouga/mockingbird-service-kinesis` | `@emulators/kinesis` |
| `@crvouga/mockingbird-service-klaviyo` | `@emulators/klaviyo` |
| `@crvouga/mockingbird-service-kms` | `@emulators/kms` |
| `@crvouga/mockingbird-service-lambda` | `@emulators/lambda` |
| `@crvouga/mockingbird-service-livekit` | `@emulators/livekit` |
| `@crvouga/mockingbird-service-llamacloud` | `@emulators/llamacloud` |
| `@crvouga/mockingbird-service-mailosaur` | `@emulators/mailosaur` |
| `@crvouga/mockingbird-service-mediaconvert` | `@emulators/mediaconvert` |
| `@crvouga/mockingbird-service-medplum` | `@emulators/medplum` |
| `@crvouga/mockingbird-service-meta` | `@emulators/meta` |
| `@crvouga/mockingbird-service-notion` | `@emulators/notion` |
| `@crvouga/mockingbird-service-oauth` | `@emulators/oauth` |
| `@crvouga/mockingbird-service-odx` | `@emulators/odx` |
| `@crvouga/mockingbird-service-openai` | `@emulators/openai` |
| `@crvouga/mockingbird-service-opensearch` | `@emulators/opensearch` |
| `@crvouga/mockingbird-service-otel` | `@emulators/otel` |
| `@crvouga/mockingbird-service-oura` | `@emulators/oura` |
| `@crvouga/mockingbird-service-paddle` | `@emulators/paddle` |
| `@crvouga/mockingbird-service-payload-cms` | `@emulators/payload-cms` |
| `@crvouga/mockingbird-service-persona` | `@emulators/persona` |
| `@crvouga/mockingbird-service-pharmetika` | `@emulators/pharmetika` |
| `@crvouga/mockingbird-service-plane` | `@emulators/plane` |
| `@crvouga/mockingbird-service-postgres` | `@emulators/postgres` |
| `@crvouga/mockingbird-service-posthog` | `@emulators/posthog` |
| `@crvouga/mockingbird-service-prism` | `@emulators/prism` |
| `@crvouga/mockingbird-service-recaptcha` | `@emulators/recaptcha` |
| `@crvouga/mockingbird-service-redis` | `@emulators/redis` |
| `@crvouga/mockingbird-service-redshift` | `@emulators/redshift` |
| `@crvouga/mockingbird-service-resend` | `@emulators/resend` |
| `@crvouga/mockingbird-service-resource-groups` | `@emulators/resource-groups` |
| `@crvouga/mockingbird-service-resource-groups-tagging-api` | `@emulators/resource-groups-tagging-api` |
| `@crvouga/mockingbird-service-route53` | `@emulators/route53` |
| `@crvouga/mockingbird-service-route53resolver` | `@emulators/route53resolver` |
| `@crvouga/mockingbird-service-rxvortex` | `@emulators/rxvortex` |
| `@crvouga/mockingbird-service-s3` | `@emulators/s3` |
| `@crvouga/mockingbird-service-s3-control` | `@emulators/s3-control` |
| `@crvouga/mockingbird-service-scheduler` | `@emulators/scheduler` |
| `@crvouga/mockingbird-service-sentry` | `@emulators/sentry` |
| `@crvouga/mockingbird-service-ses` | `@emulators/ses` |
| `@crvouga/mockingbird-service-slack` | `@emulators/slack` |
| `@crvouga/mockingbird-service-sns` | `@emulators/sns` |
| `@crvouga/mockingbird-service-sqlite` | `@emulators/sqlite` |
| `@crvouga/mockingbird-service-sqs` | `@emulators/sqs` |
| `@crvouga/mockingbird-service-ssm` | `@emulators/ssm` |
| `@crvouga/mockingbird-service-step-functions` | `@emulators/step-functions` |
| `@crvouga/mockingbird-service-stripe` | `@emulators/stripe` |
| `@crvouga/mockingbird-service-sts` | `@emulators/sts` |
| `@crvouga/mockingbird-service-support` | `@emulators/support` |
| `@crvouga/mockingbird-service-swf` | `@emulators/swf` |
| `@crvouga/mockingbird-service-tavily` | `@emulators/tavily` |
| `@crvouga/mockingbird-service-textract` | `@emulators/textract` |
| `@crvouga/mockingbird-service-turnstile` | `@emulators/turnstile` |
| `@crvouga/mockingbird-service-twilio` | `@emulators/twilio` |
| `@crvouga/mockingbird-service-unsplash` | `@emulators/unsplash` |
| `@crvouga/mockingbird-service-vanta` | `@emulators/vanta` |
| `@crvouga/mockingbird-service-vercel-blob` | `@emulators/vercel-blob` |
| `@crvouga/mockingbird-service-vibe` | `@emulators/vibe` |
| `@crvouga/mockingbird-service-vpi` | `@emulators/vpi` |
| `@crvouga/mockingbird-service-wholescripts` | `@emulators/wholescripts` |
| `@crvouga/mockingbird-service-whoop` | `@emulators/whoop` |
| `@crvouga/mockingbird-service-workos` | `@emulators/workos` |

These packages were never public on their own and have no successor; their code is bundled into every `@emulators/*` service: `@crvouga/mockingbird`, `@crvouga/mockingbird-adapter-bun`, `@crvouga/mockingbird-adapter-node`, `@crvouga/mockingbird-canonicalize`, `@crvouga/mockingbird-commands`, `@crvouga/mockingbird-core`, `@crvouga/mockingbird-http-codec`, `@crvouga/mockingbird-model`, `@crvouga/mockingbird-openapi`, `@crvouga/mockingbird-openapi-arbitrary`, `@crvouga/mockingbird-openapi-metadata`, `@crvouga/mockingbird-openbao`, `@crvouga/mockingbird-parity`, `@crvouga/mockingbird-service`, `@crvouga/mockingbird-sqlite`.

The archived `@crvouga/postgres-mem` and `@crvouga/sqlite-mem` point to `@emulators/postgres` and `@emulators/sqlite`.
