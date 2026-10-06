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
  const before = await call("ListGroups", {})
  expect(Array.isArray(before["GroupIdentifiers"])).toBe(true)
  await call("CreateGroup", { Name: "fixture" })
  expect((await call("ListGroups", {}))["GroupIdentifiers"]).toHaveLength(
    before["GroupIdentifiers"].length + 1,
  )
  expect((await call("ListGroups", {}, "isolated"))["GroupIdentifiers"]).toEqual(
    before["GroupIdentifiers"],
  )
  await runtime.reset()
  expect((await call("ListGroups", {}))["GroupIdentifiers"]).toEqual(before["GroupIdentifiers"])
})
