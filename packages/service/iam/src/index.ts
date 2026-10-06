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
} from "@emulates/service"
import { document, operationIds, supportedOperationIds } from "./generated/openapi.js"

export type { Runtime, RuntimeOptions } from "./runtime.js"
export { createRuntime } from "./runtime.js"
export { document, operationIds, supportedOperationIds }
export type APIOptions = AwsProtocolOptions
export class IamAPI extends AwsProtocolAPI {
  constructor(options: APIOptions = {}) {
    super("iam", options)
  }
  dispatch({ operation, input }: AwsOperation): unknown {
    if (
      ![
        "CreateUser",
        "GetUser",
        "ListUsers",
        "DeleteUser",
        "UpdateUser",
        "CreateRole",
        "GetRole",
        "ListRoles",
        "DeleteRole",
        "UpdateAssumeRolePolicy",
        "CreatePolicy",
        "GetPolicy",
        "ListPolicies",
        "DeletePolicy",
        "AttachRolePolicy",
        "DetachRolePolicy",
        "ListAttachedRolePolicies",
        "AttachUserPolicy",
        "DetachUserPolicy",
        "ListAttachedUserPolicies",
        "PutRolePolicy",
        "GetRolePolicy",
        "DeleteRolePolicy",
        "ListRolePolicies",
        "PutUserPolicy",
        "GetUserPolicy",
        "DeleteUserPolicy",
        "ListUserPolicies",
        "CreateAccessKey",
        "ListAccessKeys",
        "UpdateAccessKey",
        "DeleteAccessKey",
        "CreateGroup",
        "GetGroup",
        "ListGroups",
        "DeleteGroup",
        "AddUserToGroup",
        "RemoveUserFromGroup",
        "ListGroupsForUser",
        "TagUser",
        "UntagUser",
        "ListUserTags",
        "TagRole",
        "UntagRole",
        "ListRoleTags",
        "GetAccountSummary",
      ].includes(operation)
    )
      return this.unsupported(operation)
    const users = this.collection("users"),
      roles = this.collection("roles"),
      groups = this.collection("groups"),
      policies = this.collection("policies")
    if (operation === "GetAccountSummary")
      return {
        SummaryMap: {
          Users: users.list().length,
          Roles: roles.list().length,
          Groups: groups.list().length,
          Policies: policies.list().length,
        },
      }
    for (const [kind, store] of [
      ["User", users],
      ["Role", roles],
      ["Group", groups],
    ] as const) {
      const nameKey = `${kind}Name`,
        idKey = `${kind}Id`,
        prefix = kind === "User" ? "AIDA" : kind === "Role" ? "AROA" : "AGPA"
      if (operation === `Create${kind}`) {
        const name = awsRequired(input, nameKey)
        if (store.has(name))
          throw new AwsError("EntityAlreadyExists", `${kind} already exists`, 409)
        const path = String(input.Path ?? "/")
        const item: AwsInput = {
          [nameKey]: name,
          [idKey]: this.ids.next(prefix, 17),
          Arn: `arn:aws:iam::${this.accountId}:${kind.toLowerCase()}${path}${name}`,
          Path: path,
          CreateDate: new Date(this.now()).toISOString(),
          Tags: input.Tags ?? [],
          AttachedPolicies: [],
          InlinePolicies: {},
          Members: [],
        }
        if (kind === "Role") {
          const document = awsRequired(input, "AssumeRolePolicyDocument")
          JSON.parse(document)
          Object.assign(item, {
            AssumeRolePolicyDocument: encodeURIComponent(document),
            MaxSessionDuration: Number(input.MaxSessionDuration ?? 3600),
            Description: input.Description ?? "",
          })
        }
        store.insert(name, item)
        return { [kind]: this.publicEntity(item) }
      }
      if (operation === `List${kind}s`)
        return {
          [`${kind}s`]: store
            .list({
              order: "oldest",
              where: (item) => String(item.Path).startsWith(String(input.PathPrefix ?? "/")),
            })
            .map(({ value }) => this.publicEntity(value)),
          IsTruncated: false,
        }
      if (operation === `Get${kind}`) {
        const name = String(input[nameKey] ?? (kind === "User" ? "fixture" : "")),
          item = this.get(kind.toLowerCase() + "s", name, "NoSuchEntity")
        if (kind === "Group")
          return {
            Group: this.publicEntity(item),
            Users: awsList(item.Members)
              .map(String)
              .map((member) => this.publicEntity(this.get("users", member, "NoSuchEntity"))),
            IsTruncated: false,
          }
        return { [kind]: this.publicEntity(item) }
      }
      if (operation === `Delete${kind}`) {
        const name = awsRequired(input, nameKey),
          item = this.get(kind.toLowerCase() + "s", name, "NoSuchEntity")
        if (
          awsList(item.AttachedPolicies).length ||
          Object.keys(awsRecord(item.InlinePolicies)).length ||
          awsList(item.Members).length
        )
          throw new AwsError("DeleteConflict", "Entity has attached resources", 409)
        store.delete(name)
        return {}
      }
    }
    if (operation === "CreatePolicy") {
      const name = awsRequired(input, "PolicyName"),
        path = String(input.Path ?? "/"),
        arn = `arn:aws:iam::${this.accountId}:policy${path}${name}`
      if (policies.has(arn)) throw new AwsError("EntityAlreadyExists", "Policy exists", 409)
      const document = awsRequired(input, "PolicyDocument")
      JSON.parse(document)
      const item = {
        PolicyName: name,
        PolicyId: this.ids.next("ANPA", 17),
        Arn: arn,
        Path: path,
        DefaultVersionId: "v1",
        AttachmentCount: 0,
        PermissionsBoundaryUsageCount: 0,
        IsAttachable: true,
        CreateDate: new Date(this.now()).toISOString(),
        UpdateDate: new Date(this.now()).toISOString(),
        Description: input.Description ?? "",
        Document: document,
      }
      policies.insert(arn, item)
      return { Policy: this.publicEntity(item) }
    }
    if (operation === "GetPolicy")
      return {
        Policy: this.publicEntity(
          this.get("policies", awsRequired(input, "PolicyArn"), "NoSuchEntity"),
        ),
      }
    if (operation === "ListPolicies")
      return {
        Policies: policies.list({ order: "oldest" }).map(({ value }) => this.publicEntity(value)),
        IsTruncated: false,
      }
    if (operation === "DeletePolicy") {
      const arn = awsRequired(input, "PolicyArn"),
        policy = this.get("policies", arn, "NoSuchEntity")
      if (Number(policy.AttachmentCount) > 0)
        throw new AwsError("DeleteConflict", "Policy is attached", 409)
      policies.delete(arn)
      return {}
    }
    if (operation === "UpdateUser") {
      const name = awsRequired(input, "UserName"),
        user = this.get("users", name, "NoSuchEntity"),
        next = String(input.NewUserName ?? name)
      users.delete(name)
      users.insert(next, { ...user, UserName: next, Path: input.NewPath ?? user.Path })
      return {}
    }
    if (operation === "UpdateAssumeRolePolicy") {
      const name = awsRequired(input, "RoleName"),
        role = this.get("roles", name, "NoSuchEntity"),
        document = awsRequired(input, "PolicyDocument")
      JSON.parse(document)
      roles.insert(name, { ...role, AssumeRolePolicyDocument: encodeURIComponent(document) })
      return {}
    }
    for (const kind of ["Role", "User"] as const) {
      const store = this.collection(kind.toLowerCase() + "s"),
        nameKey = `${kind}Name`
      if (
        [
          `Attach${kind}Policy`,
          `Detach${kind}Policy`,
          `ListAttached${kind}Policies`,
          `Put${kind}Policy`,
          `Get${kind}Policy`,
          `Delete${kind}Policy`,
          `List${kind}Policies`,
          `Tag${kind}`,
          `Untag${kind}`,
          `List${kind}Tags`,
        ].includes(operation)
      ) {
        const name = awsRequired(input, nameKey),
          item = this.get(kind.toLowerCase() + "s", name, "NoSuchEntity")
        if (operation === `ListAttached${kind}Policies`)
          return {
            AttachedPolicies: awsList(item.AttachedPolicies)
              .map(String)
              .map((arn) => ({ PolicyArn: arn, PolicyName: policies.get(arn)?.PolicyName })),
            IsTruncated: false,
          }
        if (operation === `Attach${kind}Policy` || operation === `Detach${kind}Policy`) {
          const arn = awsRequired(input, "PolicyArn"),
            policy = this.get("policies", arn, "NoSuchEntity"),
            attached = awsList(item.AttachedPolicies).map(String),
            add = operation === `Attach${kind}Policy`
          if (add && !attached.includes(arn)) {
            attached.push(arn)
            policies.insert(arn, { ...policy, AttachmentCount: Number(policy.AttachmentCount) + 1 })
          }
          if (!add && attached.includes(arn))
            policies.insert(arn, {
              ...policy,
              AttachmentCount: Math.max(0, Number(policy.AttachmentCount) - 1),
            })
          store.insert(name, {
            ...item,
            AttachedPolicies: add ? attached : attached.filter((value) => value !== arn),
          })
          return {}
        }
        const inline = awsRecord(item.InlinePolicies)
        if (operation === `List${kind}Policies`)
          return { PolicyNames: Object.keys(inline), IsTruncated: false }
        if (operation === `Put${kind}Policy`) {
          const policyName = awsRequired(input, "PolicyName"),
            document = awsRequired(input, "PolicyDocument")
          JSON.parse(document)
          store.insert(name, { ...item, InlinePolicies: { ...inline, [policyName]: document } })
          return {}
        }
        if (operation === `Get${kind}Policy`) {
          const policyName = awsRequired(input, "PolicyName")
          if (!inline[policyName]) throw new AwsError("NoSuchEntity", "Policy does not exist", 404)
          return {
            [nameKey]: name,
            PolicyName: policyName,
            PolicyDocument: encodeURIComponent(String(inline[policyName])),
          }
        }
        if (operation === `Delete${kind}Policy`) {
          const policyName = awsRequired(input, "PolicyName")
          delete inline[policyName]
          store.insert(name, { ...item, InlinePolicies: inline })
          return {}
        }
        if (operation === `List${kind}Tags`) return { Tags: item.Tags ?? [], IsTruncated: false }
        const incoming = awsList(input.Tags).map(awsRecord),
          removed =
            operation === `Untag${kind}` ? awsList(input.TagKeys) : incoming.map((tag) => tag.Key)
        store.insert(name, {
          ...item,
          Tags: [
            ...awsList(item.Tags)
              .map(awsRecord)
              .filter((tag) => !removed.includes(tag.Key)),
            ...incoming,
          ],
        })
        return {}
      }
    }
    if (
      ["CreateAccessKey", "ListAccessKeys", "UpdateAccessKey", "DeleteAccessKey"].includes(
        operation,
      )
    ) {
      const name = awsRequired(input, "UserName")
      this.get("users", name, "NoSuchEntity")
      const keys = this.collection("access_keys")
      if (operation === "CreateAccessKey") {
        const id = this.ids.next("AKIA", 16),
          key = {
            UserName: name,
            AccessKeyId: id,
            Status: "Active",
            SecretAccessKey: this.ids.next("", 40),
            CreateDate: new Date(this.now()).toISOString(),
          }
        keys.insert(id, key)
        return { AccessKey: key }
      }
      if (operation === "ListAccessKeys")
        return {
          AccessKeyMetadata: keys
            .list({ where: (item) => item.UserName === name })
            .map(({ value }) => {
              const { SecretAccessKey: _secret, ...rest } = value
              return rest
            }),
          IsTruncated: false,
        }
      const id = awsRequired(input, "AccessKeyId"),
        key = this.get("access_keys", id, "NoSuchEntity")
      if (operation === "DeleteAccessKey") keys.delete(id)
      else keys.insert(id, { ...key, Status: input.Status })
      return {}
    }
    if (operation === "AddUserToGroup" || operation === "RemoveUserFromGroup") {
      const name = awsRequired(input, "GroupName"),
        user = awsRequired(input, "UserName"),
        group = this.get("groups", name, "NoSuchEntity")
      this.get("users", user, "NoSuchEntity")
      groups.insert(name, {
        ...group,
        Members:
          operation === "AddUserToGroup"
            ? [...new Set([...awsList(group.Members), user])]
            : awsList(group.Members).filter((value) => value !== user),
      })
      return {}
    }
    if (operation === "ListGroupsForUser")
      return {
        Groups: groups
          .list({ where: (item) => awsList(item.Members).includes(input.UserName) })
          .map(({ value }) => this.publicEntity(value)),
        IsTruncated: false,
      }
    return this.unsupported(operation)
  }
  private publicEntity(item: AwsInput) {
    const {
      AttachedPolicies: _attached,
      InlinePolicies: _inline,
      Members: _members,
      Document: _document,
      ...rest
    } = item
    return rest
  }
}
