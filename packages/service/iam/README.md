# @crvouga/mockingbird-service-iam

Stateful local mock of Amazon Identity and Access Management. ESM; Node 22+ or Bun 1.2+.

```ts
import { createServer } from "@crvouga/mockingbird-service-iam/server"
const mock = await createServer()
// AWS SDK: endpoint: mock.url, region: "us-east-1", fixture credentials.
// Await mock.close() after the test.
```

State lives in SQLite collections and participates in the shared runtime's namespace isolation,
reset, timeline, clock, journal, metrics and fault controls. No AWS account is needed.

Implemented AWS operations: `CreateUser`, `GetUser`, `ListUsers`, `DeleteUser`, `UpdateUser`, `CreateRole`, `GetRole`, `ListRoles`, `DeleteRole`, `UpdateAssumeRolePolicy`, `CreatePolicy`, `GetPolicy`, `ListPolicies`, `DeletePolicy`, `AttachRolePolicy`, `DetachRolePolicy`, `ListAttachedRolePolicies`, `AttachUserPolicy`, `DetachUserPolicy`, `ListAttachedUserPolicies`, `PutRolePolicy`, `GetRolePolicy`, `DeleteRolePolicy`, `ListRolePolicies`, `PutUserPolicy`, `GetUserPolicy`, `DeleteUserPolicy`, `ListUserPolicies`, `CreateAccessKey`, `ListAccessKeys`, `UpdateAccessKey`, `DeleteAccessKey`, `CreateGroup`, `GetGroup`, `ListGroups`, `DeleteGroup`, `AddUserToGroup`, `RemoveUserFromGroup`, `ListGroupsForUser`, `TagUser`, `UntagUser`, `ListUserTags`, `TagRole`, `UntagRole`, `ListRoleTags`, `GetAccountSummary`.

Operations outside this list fail explicitly. This package emulates API state, not AWS infrastructure,
production quotas, billing, IAM enforcement, or provider consoles. Service-specific omissions and
oracle evidence are recorded in [the AWS coverage ledger](../../../docs/AWS_COVERAGE.md).

Run `bun run parity` with LocalStack on `http://127.0.0.1:4566`; an unavailable oracle fails the run.
Current evidence uses legacy Community 4.14.0; the current free Hobby plan is separately identified
by [LocalStack's plan table](https://docs.localstack.cloud/aws/licensing/).
