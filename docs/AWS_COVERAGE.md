# AWS implementation and oracle coverage

The LocalStack expansion is work in progress. No new LocalStack or live AWS oracle run was performed during integration. Implemented services have local transport and state tests; scaffold packages explicitly reject vendor operations. `bun run parity` fails when no scenario exists or the local oracle is unavailable.

| Service | Status |
| --- | --- |
| acm | Operations implemented; vendor parity unverified |
| apigateway | Transport scaffold; no vendor operations implemented |
| cloudcontrol | Transport scaffold; no vendor operations implemented |
| cloudformation | Transport scaffold; no vendor operations implemented |
| cloudwatch | Operations implemented; vendor parity unverified |
| cloudwatch-logs | Operations implemented; vendor parity unverified |
| config | Transport scaffold; no vendor operations implemented |
| dynamodb-streams | Transport scaffold; no vendor operations implemented |
| ec2 | Transport scaffold; no vendor operations implemented |
| elasticsearch | Transport scaffold; no vendor operations implemented |
| eventbridge | Operations implemented; vendor parity unverified |
| firehose | Operations implemented; vendor parity unverified |
| iam | Operations implemented; vendor parity unverified |
| kinesis | Operations implemented; vendor parity unverified |
| kms | Operations implemented; vendor parity unverified |
| lambda | Transport scaffold; no vendor operations implemented |
| opensearch | Transport scaffold; no vendor operations implemented |
| redshift | Transport scaffold; no vendor operations implemented |
| resource-groups | Operations implemented; vendor parity unverified |
| resource-groups-tagging-api | Operations implemented; vendor parity unverified |
| route53 | Transport scaffold; no vendor operations implemented |
| route53resolver | Transport scaffold; no vendor operations implemented |
| s3-control | Transport scaffold; no vendor operations implemented |
| scheduler | Operations implemented; vendor parity unverified |
| ses | Operations implemented; vendor parity unverified |
| sns | Operations implemented; vendor parity unverified |
| ssm | Operations implemented; vendor parity unverified |
| sts | Operations implemented; vendor parity unverified |
| support | Transport scaffold; no vendor operations implemented |
| swf | Transport scaffold; no vendor operations implemented |

EventBridge preserves its default seeded discovery runtime and exposes the broader operations separately through `createAwsRuntime`. Read-only envelope probes compare top-level SDK output types only. They do not establish write behavior, resource fidelity, quotas, IAM enforcement, or full vendor parity.
