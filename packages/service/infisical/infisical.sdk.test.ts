import { expect, test } from "bun:test"
import { InfisicalSDK } from "@infisical/sdk"
import { createServer } from "./src/server.js"
import { InfisicalStore } from "./test/consumer.js"

test("@infisical/sdk 3.0.91 authenticates, lists, creates, updates, reads historical versions and denies a sibling path", async () => {
  const server = await createServer()
  try {
    const sdk = new InfisicalSDK({ siteUrl: `${server.url}/__admin/ns/sdk-suite` })
    await sdk
      .auth()
      .universalAuth.login({ clientId: "fixture-machine", clientSecret: "fixture-client-secret" })
    const scope = { projectId: "fixture-project", environment: "dev", secretPath: "/app" }
    const list = await sdk.secrets().listSecrets(scope)
    expect(list.secrets.map((s) => s.secretKey)).toEqual(["APP_VALUE"])
    const created = await sdk.secrets().createSecret("SDK_VALUE", {
      ...scope,
      secretValue: "fixture-sdk-value",
      secretComment: "fixture-sdk-comment",
      type: "shared",
    })
    expect(created.secret.version).toBe(1)
    const updated = await sdk
      .secrets()
      .updateSecret("SDK_VALUE", { ...scope, secretValue: "fixture-sdk-updated", type: "shared" })
    expect(updated.secret.version).toBe(2)
    expect(updated.secret.id).toBe(created.secret.id)
    expect(
      (await sdk.secrets().getSecret({ ...scope, secretName: "SDK_VALUE", version: 1 }))
        .secretValue,
    ).toBe("fixture-sdk-value")
    expect((await sdk.secrets().getSecret({ ...scope, secretName: "SDK_VALUE" })).secretValue).toBe(
      "fixture-sdk-updated",
    )
    await expect(sdk.secrets().listSecrets({ ...scope, secretPath: "/sibling" })).rejects.toThrow(
      "not allowed",
    )
    await sdk.auth().universalAuth.renew()
    expect((await sdk.secrets().getSecret({ ...scope, secretName: "SDK_VALUE" })).version).toBe(2)
    const admin = new InfisicalStore((r) => fetch(r), server.url, "sdk-suite")
    await admin.admin("POST", "/machines/fixture-machine/revoke")
    await expect(sdk.secrets().getSecret({ ...scope, secretName: "SDK_VALUE" })).rejects.toThrow(
      "Invalid access token",
    )
  } finally {
    await server.close()
  }
})
test("SDK legacy access-token authentication preserves raw paths and metadata-only reads", async () => {
  const server = await createServer()
  try {
    const sdk = new InfisicalSDK({ siteUrl: server.url })
    sdk.auth().accessToken("fixture-service-token")
    const result = await sdk.secrets().listSecrets({
      projectId: "fixture-project",
      environment: "dev",
      secretPath: "/",
      recursive: true,
      viewSecretValue: false,
    })
    expect(result.secrets).toHaveLength(3)
    expect(result.secrets.every((s) => s.secretValue === "")).toBe(true)
    expect(result.secrets.map((s) => s.secretPath).sort()).toEqual(["/", "/app", "/sibling"])
  } finally {
    await server.close()
  }
})
