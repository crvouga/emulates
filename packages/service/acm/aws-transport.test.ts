import { expect, test } from "bun:test"
import { createRuntime } from "./src/index.js"

test("AWS transport rejects unsupported operations and malformed JSON", async () => {
  const runtime = createRuntime()
  const call = (body: string) =>
    runtime.fetch(
      new Request("http://mock/", {
        method: "POST",
        headers: {
          "content-type": "application/x-amz-json-1.1",
          "x-amz-target": "Fixture.UnknownOperation",
        },
        body,
      }),
    )
  const unsupported = await call("{}")
  expect(unsupported.status).toBe(400)
  expect((await unsupported.json()).__type).toBe("UnknownOperationException")
  const malformed = await call("{")
  expect(malformed.status).toBe(400)
  expect((await malformed.json()).__type).toBe("SerializationException")
  expect((await runtime.fetch(new Request("http://mock/__admin/health"))).status).toBe(200)
})

test("AWS writes are observable, namespace isolated, and cleared by reset", async () => {
  const runtime = createRuntime()
  const call = async (operation: string, input: unknown, namespace = "default") => {
    const response = await runtime.fetch(
      new Request("http://mock/", {
        method: "POST",
        headers: {
          "content-type": "application/x-amz-json-1.1",
          "x-amz-target": `Fixture.${operation}`,
          "x-emulators-namespace": namespace,
        },
        body: JSON.stringify(input),
      }),
    )
    expect(response.status).toBe(200)
    return response.json()
  }
  const before = await call("ListCertificates", {})
  expect(Array.isArray(before["CertificateSummaryList"])).toBe(true)
  await call("RequestCertificate", { DomainName: "fixture.example.test" })
  expect((await call("ListCertificates", {}))["CertificateSummaryList"]).toHaveLength(
    before["CertificateSummaryList"].length + 1,
  )
  expect((await call("ListCertificates", {}, "isolated"))["CertificateSummaryList"]).toEqual(
    before["CertificateSummaryList"],
  )
  await runtime.reset()
  expect((await call("ListCertificates", {}))["CertificateSummaryList"]).toEqual(
    before["CertificateSummaryList"],
  )
})
