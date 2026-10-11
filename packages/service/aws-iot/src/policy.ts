/**
 * AWS IoT Core policy evaluation for the four MQTT policy actions.
 *
 * - Actions and resources: https://docs.aws.amazon.com/iot/latest/developerguide/iot-action-resources.html
 * - Wildcards (`*`, `?`; MQTT's `+` and `#` are plain characters):
 *   https://docs.aws.amazon.com/iot/latest/developerguide/pub-sub-policy.html
 * - Default deny, explicit deny wins: https://docs.aws.amazon.com/iot/latest/developerguide/iot-policies.html
 * - `${iot:ClientId}`: https://docs.aws.amazon.com/iot/latest/developerguide/basic-policy-variables.html
 */

export type PolicyStatement = {
  Effect: "Allow" | "Deny"
  Action: string | string[]
  Resource: string | string[]
  Sid?: string
}

export type PolicyDocument = {
  Version?: string
  Statement: PolicyStatement | PolicyStatement[]
}

export type IotAction = "iot:Connect" | "iot:Publish" | "iot:Subscribe" | "iot:Receive"

/** What a policy is evaluated for: the account's ARN prefix and the connecting client. */
export type PolicyContext = { region: string; accountId: string; clientId: string }

/** Thrown for a policy document the emulator cannot evaluate faithfully. */
export class PolicyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "PolicyError"
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const strings = (value: unknown, field: string): string[] => {
  const list = typeof value === "string" ? [value] : value
  if (!Array.isArray(list) || list.length === 0 || list.some((each) => typeof each !== "string")) {
    throw new PolicyError(`policy statement ${field} must be a string or a list of strings`)
  }
  return list as string[]
}

const parseStatement = (value: unknown): PolicyStatement => {
  if (!isRecord(value)) throw new PolicyError("policy statement must be an object")
  if (value.Effect !== "Allow" && value.Effect !== "Deny") {
    throw new PolicyError('policy statement Effect must be "Allow" or "Deny"')
  }
  // Evaluating a statement while ignoring part of it would grant or deny the wrong things.
  for (const element of ["Condition", "NotAction", "NotResource", "Principal", "NotPrincipal"]) {
    if (value[element] !== undefined) {
      throw new PolicyError(`policy statement element ${element} is not modelled`)
    }
  }
  return {
    Effect: value.Effect,
    Action: strings(value.Action, "Action"),
    Resource: strings(value.Resource, "Resource"),
    ...(typeof value.Sid === "string" ? { Sid: value.Sid } : {}),
  }
}

/**
 * Check a policy document, given as an object or as the JSON string a custom authorizer's
 * Lambda function returns. Throws {@link PolicyError} when it is malformed or uses an element
 * the emulator does not evaluate.
 */
export const parsePolicyDocument = (value: unknown): PolicyDocument => {
  let document = value
  if (typeof document === "string") {
    try {
      document = JSON.parse(document)
    } catch {
      throw new PolicyError("policy document is not valid JSON")
    }
  }
  if (!isRecord(document)) throw new PolicyError("policy document must be an object")
  const statements = Array.isArray(document.Statement) ? document.Statement : [document.Statement]
  return {
    ...(typeof document.Version === "string" ? { Version: document.Version } : {}),
    Statement: statements.map(parseStatement),
  }
}

/** `*` matches any run of characters, across topic levels; `?` matches exactly one. */
const wildcard = (pattern: string, value: string, caseInsensitive = false): boolean => {
  const source = pattern
    .split("")
    .map((char) =>
      char === "*" ? ".*" : char === "?" ? "." : char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    )
    .join("")
  return new RegExp(`^${source}$`, caseInsensitive ? "is" : "s").test(value)
}

// biome-ignore lint/suspicious/noTemplateCurlyInString: AWS's policy variable syntax
const CLIENT_ID_VARIABLE = "${iot:ClientId}"

/** The ARN a policy names for an action's target (`client/…`, `topic/…`, `topicfilter/…`). */
export const resourceArn = (action: IotAction, target: string, context: PolicyContext): string => {
  const kind =
    action === "iot:Connect" ? "client" : action === "iot:Subscribe" ? "topicfilter" : "topic"
  return `arn:aws:iot:${context.region}:${context.accountId}:${kind}/${target}`
}

/**
 * Whether `documents` allow `action` on `target` (a client identifier, a topic name, or for
 * `iot:Subscribe` a topic filter exactly as the client wrote it). Nothing is allowed unless a
 * statement allows it, and a matching `Deny` overrides every `Allow`.
 */
export const isAllowed = (
  documents: readonly PolicyDocument[],
  action: IotAction,
  target: string,
  context: PolicyContext,
): boolean => {
  const arn = resourceArn(action, target, context)
  let allowed = false
  for (const document of documents) {
    const statements = Array.isArray(document.Statement) ? document.Statement : [document.Statement]
    for (const statement of statements) {
      const actions = typeof statement.Action === "string" ? [statement.Action] : statement.Action
      const resources =
        typeof statement.Resource === "string" ? [statement.Resource] : statement.Resource
      if (!actions.some((pattern) => wildcard(pattern, action, true))) continue
      const matches = resources.some((pattern) =>
        wildcard(pattern.replaceAll(CLIENT_ID_VARIABLE, context.clientId), arn),
      )
      if (!matches) continue
      if (statement.Effect === "Deny") return false
      allowed = true
    }
  }
  return allowed
}
