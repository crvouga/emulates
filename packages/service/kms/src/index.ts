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
export class KmsAPI extends AwsProtocolAPI {
  constructor(options: APIOptions = {}) {
    super("kms", options)
  }
  private key(id: unknown) {
    const value = String(id ?? ""),
      alias = this.collection("aliases").get(value)
    const keyId = String(alias?.TargetKeyId ?? value.split("/").at(-1) ?? value)
    const key = this.get("keys", keyId, "NotFoundException")
    if (key.KeyState !== "Enabled") throw new AwsError("DisabledException", "Key is not enabled")
    return key
  }
  private metadata(key: AwsInput) {
    const {
      Material: _material,
      Policy: _policy,
      Tags: _tags,
      Rotation: _rotation,
      ...metadata
    } = key
    return metadata
  }
  private bytes(value: unknown) {
    return Uint8Array.from(atob(String(value)), (char) => char.charCodeAt(0))
  }
  private base64(value: Uint8Array) {
    let binary = ""
    for (const byte of value) binary += String.fromCharCode(byte)
    return btoa(binary)
  }
  private async encrypt(key: AwsInput, bytes: Uint8Array, context: unknown) {
    const material = this.bytes(key.Material),
      iv = crypto.getRandomValues(new Uint8Array(12))
    const imported = await crypto.subtle.importKey(
      "raw",
      material as BufferSource,
      "AES-GCM",
      false,
      ["encrypt"],
    )
    const aad = new TextEncoder().encode(
      JSON.stringify(Object.entries(awsRecord(context)).sort(([a], [b]) => a.localeCompare(b))),
    )
    const cipher = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: iv as BufferSource, additionalData: aad as BufferSource },
      imported,
      bytes as BufferSource,
    )
    return this.base64(
      new TextEncoder().encode(
        JSON.stringify({
          keyId: key.KeyId,
          iv: this.base64(iv),
          data: this.base64(new Uint8Array(cipher)),
        }),
      ),
    )
  }
  private async decrypt(input: AwsInput) {
    let envelope: AwsInput
    try {
      envelope = awsRecord(JSON.parse(new TextDecoder().decode(this.bytes(input.CiphertextBlob))))
    } catch {
      throw new AwsError("InvalidCiphertextException", "Invalid ciphertext")
    }
    const key = this.key(envelope.keyId)
    if (input.KeyId && this.key(input.KeyId).KeyId !== key.KeyId)
      throw new AwsError("IncorrectKeyException", "Ciphertext was encrypted with a different key")
    const imported = await crypto.subtle.importKey(
      "raw",
      this.bytes(key.Material) as BufferSource,
      "AES-GCM",
      false,
      ["decrypt"],
    )
    const aad = new TextEncoder().encode(
      JSON.stringify(
        Object.entries(awsRecord(input.EncryptionContext)).sort(([a], [b]) => a.localeCompare(b)),
      ),
    )
    try {
      return {
        key,
        plaintext: new Uint8Array(
          await crypto.subtle.decrypt(
            {
              name: "AES-GCM",
              iv: this.bytes(envelope.iv) as BufferSource,
              additionalData: aad as BufferSource,
            },
            imported,
            this.bytes(envelope.data) as BufferSource,
          ),
        ),
      }
    } catch {
      throw new AwsError(
        "InvalidCiphertextException",
        "Ciphertext or encryption context is invalid",
      )
    }
  }
  async dispatch({ operation, input }: AwsOperation): Promise<unknown> {
    if (
      ![
        "CreateKey",
        "DescribeKey",
        "ListKeys",
        "EnableKey",
        "DisableKey",
        "ScheduleKeyDeletion",
        "CancelKeyDeletion",
        "CreateAlias",
        "UpdateAlias",
        "DeleteAlias",
        "ListAliases",
        "Encrypt",
        "Decrypt",
        "ReEncrypt",
        "GenerateDataKey",
        "GenerateDataKeyWithoutPlaintext",
        "GetKeyPolicy",
        "PutKeyPolicy",
        "ListKeyPolicies",
        "EnableKeyRotation",
        "DisableKeyRotation",
        "GetKeyRotationStatus",
        "TagResource",
        "UntagResource",
        "ListResourceTags",
      ].includes(operation)
    )
      return this.unsupported(operation)
    const keys = this.collection("keys"),
      aliases = this.collection("aliases")
    if (operation === "CreateKey") {
      const raw = awsMd5(this.ids.next("key-", 32)),
        id = `${raw.slice(0, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}-${raw.slice(16, 20)}-${raw.slice(20)}`
      const key = {
        KeyId: id,
        Arn: this.arn("key/", id, "kms"),
        AWSAccountId: this.accountId,
        CreationDate: this.now() / 1000,
        Enabled: true,
        KeyState: "Enabled",
        KeyUsage: input.KeyUsage ?? "ENCRYPT_DECRYPT",
        KeySpec: input.KeySpec ?? "SYMMETRIC_DEFAULT",
        CustomerMasterKeySpec: input.KeySpec ?? "SYMMETRIC_DEFAULT",
        Description: input.Description ?? "",
        Origin: "AWS_KMS",
        KeyManager: "CUSTOMER",
        MultiRegion: input.MultiRegion ?? false,
        EncryptionAlgorithms: ["SYMMETRIC_DEFAULT"],
        Material: this.base64(crypto.getRandomValues(new Uint8Array(32))),
        Policy:
          input.Policy ??
          JSON.stringify({
            Version: "2012-10-17",
            Statement: [
              {
                Effect: "Allow",
                Principal: { AWS: `arn:aws:iam::${this.accountId}:root` },
                Action: "kms:*",
                Resource: "*",
              },
            ],
          }),
        Tags: input.Tags ?? [],
        Rotation: false,
      }
      keys.insert(id, key)
      return { KeyMetadata: this.metadata(key) }
    }
    if (operation === "ListKeys")
      return {
        Keys: keys
          .list({ order: "oldest" })
          .map(({ value }) => ({ KeyId: value.KeyId, KeyArn: value.Arn })),
        Truncated: false,
      }
    if (operation === "ListAliases")
      return {
        Aliases: aliases
          .list({
            order: "oldest",
            where: (item) => !input.KeyId || item.TargetKeyId === input.KeyId,
          })
          .map(({ value }) => value),
        Truncated: false,
      }
    if (["CreateAlias", "UpdateAlias", "DeleteAlias"].includes(operation)) {
      const name = awsRequired(input, "AliasName")
      if (!name.startsWith("alias/"))
        throw new AwsError("ValidationException", "AliasName must start with alias/")
      if (operation === "DeleteAlias") {
        this.get("aliases", name, "NotFoundException")
        aliases.delete(name)
        return {}
      }
      if (operation === "CreateAlias" && aliases.has(name))
        throw new AwsError("AlreadyExistsException", "Alias exists")
      const key = this.key(input.TargetKeyId)
      aliases.insert(name, {
        AliasName: name,
        AliasArn: this.arn("", name, "kms"),
        TargetKeyId: key.KeyId,
        CreationDate: this.now() / 1000,
        LastUpdatedDate: this.now() / 1000,
      })
      return {}
    }
    if (operation === "Decrypt") {
      const { key, plaintext } = await this.decrypt(input)
      return {
        KeyId: key.Arn,
        Plaintext: this.base64(plaintext),
        EncryptionAlgorithm: "SYMMETRIC_DEFAULT",
      }
    }
    if (operation === "ReEncrypt") {
      const { key: source, plaintext } = await this.decrypt({
        CiphertextBlob: input.CiphertextBlob,
        KeyId: input.SourceKeyId,
        EncryptionContext: input.SourceEncryptionContext,
      })
      const destination = this.key(input.DestinationKeyId)
      return {
        SourceKeyId: source.Arn,
        KeyId: destination.Arn,
        CiphertextBlob: await this.encrypt(
          destination,
          plaintext,
          input.DestinationEncryptionContext,
        ),
        SourceEncryptionAlgorithm: "SYMMETRIC_DEFAULT",
        DestinationEncryptionAlgorithm: "SYMMETRIC_DEFAULT",
      }
    }
    const id =
        String(input.KeyId ?? "")
          .split("/")
          .at(-1) ?? "",
      alias = aliases.get(String(input.KeyId)),
      key = this.get("keys", String(alias?.TargetKeyId ?? id), "NotFoundException"),
      keyId = String(key.KeyId)
    if (operation === "DescribeKey") return { KeyMetadata: this.metadata(key) }
    if (operation === "EnableKey" || operation === "DisableKey") {
      keys.insert(keyId, {
        ...key,
        Enabled: operation === "EnableKey",
        KeyState: operation === "EnableKey" ? "Enabled" : "Disabled",
      })
      return {}
    }
    if (operation === "ScheduleKeyDeletion") {
      const days = Number(input.PendingWindowInDays ?? 30)
      if (days < 7 || days > 30)
        throw new AwsError("ValidationException", "Invalid deletion window")
      keys.insert(keyId, {
        ...key,
        Enabled: false,
        KeyState: "PendingDeletion",
        DeletionDate: this.now() / 1000 + days * 86400,
      })
      return {
        KeyId: key.Arn,
        DeletionDate: this.now() / 1000 + days * 86400,
        KeyState: "PendingDeletion",
        PendingWindowInDays: days,
      }
    }
    if (operation === "CancelKeyDeletion") {
      keys.insert(keyId, { ...key, KeyState: "Disabled", Enabled: false })
      return { KeyId: key.Arn }
    }
    if (operation === "GetKeyPolicy")
      return { Policy: key.Policy, PolicyName: input.PolicyName ?? "default" }
    if (operation === "PutKeyPolicy") {
      const policy = awsRequired(input, "Policy")
      JSON.parse(policy)
      keys.insert(keyId, { ...key, Policy: policy })
      return {}
    }
    if (operation === "ListKeyPolicies") return { PolicyNames: ["default"], Truncated: false }
    if (operation === "GetKeyRotationStatus")
      return { KeyRotationEnabled: key.Rotation ?? false, KeyId: key.Arn }
    if (operation === "EnableKeyRotation" || operation === "DisableKeyRotation") {
      keys.insert(keyId, { ...key, Rotation: operation === "EnableKeyRotation" })
      return {}
    }
    if (operation === "ListResourceTags") return { Tags: key.Tags ?? [], Truncated: false }
    if (operation === "TagResource" || operation === "UntagResource") {
      const incoming = awsList(input.Tags).map(awsRecord),
        removed =
          operation === "UntagResource" ? awsList(input.TagKeys) : incoming.map((tag) => tag.TagKey)
      keys.insert(keyId, {
        ...key,
        Tags: [
          ...awsList(key.Tags)
            .map(awsRecord)
            .filter((tag) => !removed.includes(tag.TagKey)),
          ...incoming,
        ],
      })
      return {}
    }
    const enabled = this.key(input.KeyId)
    if (operation === "Encrypt")
      return {
        KeyId: enabled.Arn,
        CiphertextBlob: await this.encrypt(
          enabled,
          this.bytes(input.Plaintext),
          input.EncryptionContext,
        ),
        EncryptionAlgorithm: "SYMMETRIC_DEFAULT",
      }
    if (operation === "GenerateDataKey" || operation === "GenerateDataKeyWithoutPlaintext") {
      const size =
        input.KeySpec === "AES_128"
          ? 16
          : input.KeySpec === "AES_256"
            ? 32
            : Number(input.NumberOfBytes)
      if (!Number.isInteger(size) || size < 1 || size > 1024)
        throw new AwsError("ValidationException", "Invalid key size")
      const bytes = crypto.getRandomValues(new Uint8Array(size))
      return {
        KeyId: enabled.Arn,
        CiphertextBlob: await this.encrypt(enabled, bytes, input.EncryptionContext),
        ...(operation === "GenerateDataKey" ? { Plaintext: this.base64(bytes) } : {}),
      }
    }
    return this.unsupported(operation)
  }
}
