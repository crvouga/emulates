# @crvouga/mockingbird-service-ec2

Stateful local mock of Amazon Elastic Compute Cloud. ESM; Node 22+ or Bun 1.2+.

```ts
import { createServer } from "@crvouga/mockingbird-service-ec2/server"
const mock = await createServer()
// AWS SDK: endpoint: mock.url, region: "us-east-1", fixture credentials.
// Await mock.close() after the test.
```

State lives in SQLite collections and participates in the shared runtime's namespace isolation,
reset, timeline, clock, journal, metrics and fault controls. No AWS account is needed.

Implemented AWS operations: `RunInstances`, `DescribeInstances`, `StartInstances`, `StopInstances`, `RebootInstances`, `TerminateInstances`, `CreateVpc`, `DescribeVpcs`, `DeleteVpc`, `CreateSubnet`, `DescribeSubnets`, `DeleteSubnet`, `CreateSecurityGroup`, `DescribeSecurityGroups`, `DeleteSecurityGroup`, `AuthorizeSecurityGroupIngress`, `RevokeSecurityGroupIngress`, `CreateTags`, `DeleteTags`, `DescribeTags`, `CreateKeyPair`, `DescribeKeyPairs`, `DeleteKeyPair`, `CreateVolume`, `DescribeVolumes`, `DeleteVolume`, `AttachVolume`, `DetachVolume`, `CreateSnapshot`, `DescribeSnapshots`, `DeleteSnapshot`, `CreateInternetGateway`, `DescribeInternetGateways`, `AttachInternetGateway`, `DetachInternetGateway`, `DeleteInternetGateway`, `CreateRouteTable`, `DescribeRouteTables`, `DeleteRouteTable`, `CreateRoute`, `AssociateRouteTable`.

Operations outside this list fail explicitly. This package emulates API state, not AWS infrastructure,
production quotas, billing, IAM enforcement, or provider consoles. Service-specific omissions and
oracle evidence are recorded in [the AWS coverage ledger](../../../docs/AWS_COVERAGE.md).

Run `bun run parity` with LocalStack on `http://127.0.0.1:4566`; an unavailable oracle fails the run.
Current evidence uses legacy Community 4.14.0; the current free Hobby plan is separately identified
by [LocalStack's plan table](https://docs.localstack.cloud/aws/licensing/).
