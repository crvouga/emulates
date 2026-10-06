import {
  AwsError,
  type AwsInput,
  type AwsOperation,
  AwsProtocolAPI,
  type AwsProtocolOptions,
  awsList,
  awsMd5,
  awsPage,
  awsParseXml,
  awsRecord,
  awsRequired,
  awsXml,
} from "@emulators/service"
import { document, operationIds, supportedOperationIds } from "./generated/openapi.js"

export type { Runtime, RuntimeOptions } from "./runtime.js"
export { createRuntime } from "./runtime.js"
export { document, operationIds, supportedOperationIds }
export type APIOptions = AwsProtocolOptions
export class StsAPI extends AwsProtocolAPI {
  constructor(options: APIOptions = {}) {
    super("sts", options)
  }
  dispatch({ operation, input, request }: AwsOperation): unknown {
    if (
      !["GetCallerIdentity", "AssumeRole", "GetSessionToken", "GetFederationToken"].includes(
        operation,
      )
    )
      return this.unsupported(operation)
    const access =
      /Credential=([^/]+)/.exec(request.headers.get("authorization") ?? "")?.[1] ?? "fixture"
    const arn = `arn:aws:iam::${this.accountId}:root`
    if (operation === "GetCallerIdentity")
      return { UserId: this.accountId, Account: this.accountId, Arn: arn }
    if (["AssumeRole", "GetSessionToken", "GetFederationToken"].includes(operation)) {
      const duration = Number(input.DurationSeconds ?? 3600)
      if (duration < 900 || duration > (operation === "AssumeRole" ? 43200 : 129600))
        throw new AwsError("ValidationError", "Invalid DurationSeconds")
      if (operation === "AssumeRole") {
        awsRequired(input, "RoleArn")
        awsRequired(input, "RoleSessionName")
      }
      const credentials = {
        AccessKeyId: this.ids.next("ASIA", 16),
        SecretAccessKey: this.ids.next("", 40),
        SessionToken: this.ids.next("session-", 80),
        Expiration: new Date(this.now() + duration * 1000).toISOString(),
      }
      if (operation === "GetSessionToken") return { Credentials: credentials }
      if (operation === "GetFederationToken")
        return {
          Credentials: credentials,
          FederatedUser: {
            FederatedUserId: `${this.accountId}:${awsRequired(input, "Name")}`,
            Arn: `arn:aws:sts::${this.accountId}:federated-user/${input.Name}`,
          },
          PackedPolicySize: 0,
        }
      const role = String(input.RoleArn).split("/").at(-1)
      return {
        Credentials: credentials,
        AssumedRoleUser: {
          AssumedRoleId: `${access}:${input.RoleSessionName}`,
          Arn: `arn:aws:sts::${this.accountId}:assumed-role/${role}/${input.RoleSessionName}`,
        },
        PackedPolicySize: 0,
      }
    }
    return this.unsupported(operation)
  }
}
