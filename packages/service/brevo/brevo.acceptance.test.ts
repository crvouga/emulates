import { expect, test } from "bun:test"
import { createClock } from "@emulators/service"
import { createRuntime } from "./src/index.js"
import { createServer } from "./src/server.js"
import { client } from "./test/consumer.js"

const origin = "http://brevo.test"
const setup = () => {
  const runtime = createRuntime({ clock: createClock(() => Date.UTC(2026, 0, 1)) })
  const fetchImpl = ((input: RequestInfo | URL, init?: RequestInit) =>
    runtime.fetch(new Request(input, init))) as typeof fetch
  return { runtime, fetchImpl, consumer: client(fetchImpl, origin) }
}
test("create, external-id email update, and deletion refer to the same contact", async () => {
  const { consumer } = setup()
  const created = await consumer.create("old+test@example.test", "external/id", [2, 3])
  expect(created.status).toBe(201)
  const { id } = (await created.json()) as { id: number }
  expect(typeof id).toBe("number")
  expect(await (await consumer.get(id)).json()).toMatchObject({
    id,
    email: "old+test@example.test",
    ext_id: "external/id",
    listIds: [2, 3],
  })
  const updated = await consumer.updateEmail("external/id", "new+test@example.test")
  expect(updated.status).toBe(204)
  expect(await updated.text()).toBe("")
  expect((await consumer.get("old+test@example.test")).status).toBe(404)
  expect(await (await consumer.get(id)).json()).toMatchObject({
    id,
    email: "new+test@example.test",
    ext_id: "external/id",
  })
  expect((await consumer.remove("new+test@example.test")).status).toBe(204)
  expect((await consumer.get(id)).status).toBe(404)
})
test("duplicate create and conflicting update do not silently change contacts", async () => {
  const { consumer } = setup()
  await consumer.create("one@example.test", "one", [2])
  const duplicate = await consumer.create("one@example.test", "different", [99])
  expect(duplicate.status).toBe(400)
  expect(await duplicate.json()).toMatchObject({ code: "duplicate_parameter" })
  expect(await (await consumer.get(1)).json()).toMatchObject({ ext_id: "one", listIds: [2] })
  await consumer.create("two@example.test", "two")
  expect((await consumer.updateEmail("one", "two@example.test")).status).toBe(400)
  expect(await (await consumer.get(1)).json()).toMatchObject({ email: "one@example.test" })
  expect((await consumer.updateEmail("one", "not-an-email")).status).toBe(400)
})
test("auth, validation, quota and transport failures preserve vendor responses", async () => {
  const { runtime, fetchImpl, consumer } = setup()
  expect((await client(fetchImpl, origin, "wrong").create("a@example.test", "a")).status).toBe(401)
  expect(runtime.instance().contacts.count()).toBe(0)
  expect((await consumer.create("broken", "a")).status).toBe(400)
  runtime.applyPreset("rate_limited", "default", { count: 1 })
  const limited = await consumer.create("a@example.test", "a")
  expect(limited.status).toBe(429)
  expect(limited.headers.get("retry-after")).toBe("1")
  runtime.applyPreset("connection_drop", "default", { count: 1 })
  await expect(consumer.create("a@example.test", "a")).rejects.toBeInstanceOf(TypeError)
  expect(runtime.instance().contacts.count()).toBe(0)
  expect((await consumer.create("a@example.test", "a")).status).toBe(201)
})
test("namespaces, reset, shared admin state and journal redaction", async () => {
  const { runtime, fetchImpl, consumer } = setup()
  const namespaced = ((input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    request.headers.set("x-emulators-namespace", "isolated")
    return runtime.fetch(request)
  }) as typeof fetch
  await consumer.create("same@example.test", "same")
  const other = client(namespaced, origin)
  await other.create("same@example.test", "same")
  await runtime.reset("isolated")
  expect((await other.get(1)).status).toBe(404)
  expect((await consumer.get(1)).status).toBe(200)
  const state = await fetchImpl(`${origin}/__admin/state/contacts`)
  expect(state.status).toBe(200)
  const journal = await (await fetchImpl(`${origin}/__admin/requests`)).text()
  expect(journal).not.toContain("mock_brevo_key")
  expect(journal).not.toContain("same@example.test")
})
test("served HTTP preserves bodyless 204 responses", async () => {
  const server = await createServer()
  try {
    const consumer = client(fetch, server.url)
    expect((await consumer.create("http@example.test", "http")).status).toBe(201)
    const deleted = await consumer.remove("http@example.test")
    expect(deleted.status).toBe(204)
    expect(await deleted.text()).toBe("")
  } finally {
    await server.close()
  }
})
