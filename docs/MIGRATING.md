# Migrating from Mockingbird

Mockingbird has been renamed to Emulates. Packages have moved from their previous names to the corresponding `@emulates/*` packages; the old npm packages remain available but are deprecated.

## Existing checkouts of this repo

Run `bun run rebrand:bootstrap` once in each clone. It points `origin` at `crvouga/emulators`, renames
`MOCKINGBIRD_*` keys in `.env.local` to `EMULATES_*` (values are never printed), moves the gitignored
`.mockingbird/` state directory to `.emulates/`, and reinstalls so workspace links use the new
package names. It is safe to re-run.

## Install the new package

The code is the same; only names changed. Swap the dependency and the import specifier:

```bash
npm uninstall @crvouga/mockingbird-service-postgres
npm install -D @emulates/postgres
```

```ts
// before
import { createRuntime } from "@crvouga/mockingbird-service-stripe"
// after
import { createRuntime } from "@emulates/stripe"
```

Each `@emulates/<id>` package continues its former package's version line, so the first `@emulates` release is newer than the last `@crvouga/mockingbird-service-*` one. Old versions stay installable; they are never unpublished.

## Other renamed names

| Before | After |
| --- | --- |
| `mockingbird-<id>` CLI (e.g. `npx mockingbird-stripe serve`) | `emulates-<id>` (`npx emulates-stripe serve`) |
| `mockingbird.json` fleet config | `emulates.json` |
| `x-mockingbird-*` HTTP headers and OpenAPI extensions | `x-emulates-*` |
| `MOCKINGBIRD_*` environment variables | `EMULATES_*` |
| `.mockingbird/` local state directory | `.emulates/` |
| https://github.com/crvouga/mockingbird | https://github.com/crvouga/emulators (GitHub redirects the old URL) |
| https://mockingbird.chrisvouga.dev | https://emulates.chrisvouga.dev |

## Package mapping

| Previous package | New package |
| --- | --- |
| `@crvouga/mockingbird-service-acm` | `@emulates/acm` |
| `@crvouga/mockingbird-service-aha` | `@emulates/aha` |
| `@crvouga/mockingbird-service-airtable` | `@emulates/airtable` |
| `@crvouga/mockingbird-service-apigateway` | `@emulates/apigateway` |
| `@crvouga/mockingbird-service-app-store-connect` | `@emulates/app-store-connect` |
| `@crvouga/mockingbird-service-aws-secrets` | `@emulates/aws-secrets` |
| `@crvouga/mockingbird-service-aws-speech` | `@emulates/aws-speech` |
| `@crvouga/mockingbird-service-bedrock` | `@emulates/bedrock` |
| `@crvouga/mockingbird-service-brevo` | `@emulates/brevo` |
| `@crvouga/mockingbird-service-caretalk` | `@emulates/caretalk` |
| `@crvouga/mockingbird-service-checkr` | `@emulates/checkr` |
| `@crvouga/mockingbird-service-cloudcontrol` | `@emulates/cloudcontrol` |
| `@crvouga/mockingbird-service-cloudformation` | `@emulates/cloudformation` |
| `@crvouga/mockingbird-service-cloudwatch` | `@emulates/cloudwatch` |
| `@crvouga/mockingbird-service-cloudwatch-logs` | `@emulates/cloudwatch-logs` |
| `@crvouga/mockingbird-service-cognito` | `@emulates/cognito` |
| `@crvouga/mockingbird-service-config` | `@emulates/config` |
| `@crvouga/mockingbird-service-customerio` | `@emulates/customerio` |
| `@crvouga/mockingbird-service-daily` | `@emulates/daily` |
| `@crvouga/mockingbird-service-docker` | `@emulates/docker` |
| `@crvouga/mockingbird-service-dynamodb` | `@emulates/dynamodb` |
| `@crvouga/mockingbird-service-dynamodb-streams` | `@emulates/dynamodb-streams` |
| `@crvouga/mockingbird-service-easypost` | `@emulates/easypost` |
| `@crvouga/mockingbird-service-ec2` | `@emulates/ec2` |
| `@crvouga/mockingbird-service-ecs` | `@emulates/ecs` |
| `@crvouga/mockingbird-service-edamam` | `@emulates/edamam` |
| `@crvouga/mockingbird-service-elasticsearch` | `@emulates/elasticsearch` |
| `@crvouga/mockingbird-service-eventbridge` | `@emulates/eventbridge` |
| `@crvouga/mockingbird-service-fcm` | `@emulates/fcm` |
| `@crvouga/mockingbird-service-firehose` | `@emulates/firehose` |
| `@crvouga/mockingbird-service-firstpromoter` | `@emulates/firstpromoter` |
| `@crvouga/mockingbird-service-flex` | `@emulates/flex` |
| `@crvouga/mockingbird-service-formbricks` | `@emulates/formbricks` |
| `@crvouga/mockingbird-service-fullscript` | `@emulates/fullscript` |
| `@crvouga/mockingbird-service-genebygene` | `@emulates/genebygene` |
| `@crvouga/mockingbird-service-github` | `@emulates/github` |
| `@crvouga/mockingbird-service-google-ads` | `@emulates/google-ads` |
| `@crvouga/mockingbird-service-google-calendar` | `@emulates/google-calendar` |
| `@crvouga/mockingbird-service-google-maps` | `@emulates/google-maps` |
| `@crvouga/mockingbird-service-healthie` | `@emulates/healthie` |
| `@crvouga/mockingbird-service-hermes` | `@emulates/hermes` |
| `@crvouga/mockingbird-service-iam` | `@emulates/iam` |
| `@crvouga/mockingbird-service-infisical` | `@emulates/infisical` |
| `@crvouga/mockingbird-service-intercom` | `@emulates/intercom` |
| `@crvouga/mockingbird-service-junction` | `@emulates/junction` |
| `@crvouga/mockingbird-service-kill-bill` | `@emulates/kill-bill` |
| `@crvouga/mockingbird-service-kinesis` | `@emulates/kinesis` |
| `@crvouga/mockingbird-service-klaviyo` | `@emulates/klaviyo` |
| `@crvouga/mockingbird-service-kms` | `@emulates/kms` |
| `@crvouga/mockingbird-service-lambda` | `@emulates/lambda` |
| `@crvouga/mockingbird-service-livekit` | `@emulates/livekit` |
| `@crvouga/mockingbird-service-llamacloud` | `@emulates/llamacloud` |
| `@crvouga/mockingbird-service-mailosaur` | `@emulates/mailosaur` |
| `@crvouga/mockingbird-service-mediaconvert` | `@emulates/mediaconvert` |
| `@crvouga/mockingbird-service-medplum` | `@emulates/medplum` |
| `@crvouga/mockingbird-service-meta` | `@emulates/meta` |
| `@crvouga/mockingbird-service-notion` | `@emulates/notion` |
| `@crvouga/mockingbird-service-oauth` | `@emulates/oauth` |
| `@crvouga/mockingbird-service-odx` | `@emulates/odx` |
| `@crvouga/mockingbird-service-openai` | `@emulates/openai` |
| `@crvouga/mockingbird-service-opensearch` | `@emulates/opensearch` |
| `@crvouga/mockingbird-service-otel` | `@emulates/otel` |
| `@crvouga/mockingbird-service-oura` | `@emulates/oura` |
| `@crvouga/mockingbird-service-paddle` | `@emulates/paddle` |
| `@crvouga/mockingbird-service-payload-cms` | `@emulates/payload-cms` |
| `@crvouga/mockingbird-service-persona` | `@emulates/persona` |
| `@crvouga/mockingbird-service-pharmetika` | `@emulates/pharmetika` |
| `@crvouga/mockingbird-service-plane` | `@emulates/plane` |
| `@crvouga/mockingbird-service-postgres` | `@emulates/postgres` |
| `@crvouga/mockingbird-service-posthog` | `@emulates/posthog` |
| `@crvouga/mockingbird-service-prism` | `@emulates/prism` |
| `@crvouga/mockingbird-service-recaptcha` | `@emulates/recaptcha` |
| `@crvouga/mockingbird-service-redis` | `@emulates/redis` |
| `@crvouga/mockingbird-service-redshift` | `@emulates/redshift` |
| `@crvouga/mockingbird-service-resend` | `@emulates/resend` |
| `@crvouga/mockingbird-service-resource-groups` | `@emulates/resource-groups` |
| `@crvouga/mockingbird-service-resource-groups-tagging-api` | `@emulates/resource-groups-tagging-api` |
| `@crvouga/mockingbird-service-route53` | `@emulates/route53` |
| `@crvouga/mockingbird-service-route53resolver` | `@emulates/route53resolver` |
| `@crvouga/mockingbird-service-rxvortex` | `@emulates/rxvortex` |
| `@crvouga/mockingbird-service-s3` | `@emulates/s3` |
| `@crvouga/mockingbird-service-s3-control` | `@emulates/s3-control` |
| `@crvouga/mockingbird-service-scheduler` | `@emulates/scheduler` |
| `@crvouga/mockingbird-service-sentry` | `@emulates/sentry` |
| `@crvouga/mockingbird-service-ses` | `@emulates/ses` |
| `@crvouga/mockingbird-service-slack` | `@emulates/slack` |
| `@crvouga/mockingbird-service-sns` | `@emulates/sns` |
| `@crvouga/mockingbird-service-sqlite` | `@emulates/sqlite` |
| `@crvouga/mockingbird-service-sqs` | `@emulates/sqs` |
| `@crvouga/mockingbird-service-ssm` | `@emulates/ssm` |
| `@crvouga/mockingbird-service-step-functions` | `@emulates/step-functions` |
| `@crvouga/mockingbird-service-stripe` | `@emulates/stripe` |
| `@crvouga/mockingbird-service-sts` | `@emulates/sts` |
| `@crvouga/mockingbird-service-support` | `@emulates/support` |
| `@crvouga/mockingbird-service-swf` | `@emulates/swf` |
| `@crvouga/mockingbird-service-tavily` | `@emulates/tavily` |
| `@crvouga/mockingbird-service-textract` | `@emulates/textract` |
| `@crvouga/mockingbird-service-turnstile` | `@emulates/turnstile` |
| `@crvouga/mockingbird-service-twilio` | `@emulates/twilio` |
| `@crvouga/mockingbird-service-unsplash` | `@emulates/unsplash` |
| `@crvouga/mockingbird-service-vanta` | `@emulates/vanta` |
| `@crvouga/mockingbird-service-vercel-blob` | `@emulates/vercel-blob` |
| `@crvouga/mockingbird-service-vibe` | `@emulates/vibe` |
| `@crvouga/mockingbird-service-vpi` | `@emulates/vpi` |
| `@crvouga/mockingbird-service-wholescripts` | `@emulates/wholescripts` |
| `@crvouga/mockingbird-service-whoop` | `@emulates/whoop` |
| `@crvouga/mockingbird-service-workos` | `@emulates/workos` |

These packages were never public on their own and have no successor; their code is bundled into every `@emulates/*` service: `@crvouga/mockingbird`, `@crvouga/mockingbird-adapter-bun`, `@crvouga/mockingbird-adapter-node`, `@crvouga/mockingbird-canonicalize`, `@crvouga/mockingbird-commands`, `@crvouga/mockingbird-core`, `@crvouga/mockingbird-http-codec`, `@crvouga/mockingbird-model`, `@crvouga/mockingbird-openapi`, `@crvouga/mockingbird-openapi-arbitrary`, `@crvouga/mockingbird-openapi-metadata`, `@crvouga/mockingbird-openbao`, `@crvouga/mockingbird-parity`, `@crvouga/mockingbird-service`, `@crvouga/mockingbird-sqlite`.

The archived `@crvouga/postgres-mem` and `@crvouga/sqlite-mem` point to `@emulates/postgres` and `@emulates/sqlite`.
