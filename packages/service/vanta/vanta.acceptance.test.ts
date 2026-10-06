import { expect, test } from "bun:test"
import { createClock } from "@emulators/service"
import { createRuntime, VANTA_PRESETS } from "./src/index.js"
import { createServer } from "./src/server.js"
import { client } from "./test/consumer.js"

const setup = () => {
  const clock = createClock(() => Date.UTC(2026, 0, 1)),
    runtime = createRuntime({ clock })
  const fetchImpl = ((input: RequestInfo | URL, init?: RequestInit) =>
    runtime.fetch(new Request(input, init))) as typeof fetch
  return { clock, runtime, fetchImpl, consumer: client(fetchImpl, "http://vanta.test") }
}
test("read-scoped lists paginate without duplicates and reject writes", async () => {
  const { runtime, fetchImpl, consumer } = setup()
  runtime
    .instance()
    .people.insert("second", { id: "second", name: { first: "Synthetic", last: "Two" } })
  const token = await (await consumer.token()).json(),
    reader = client(fetchImpl, "http://vanta.test", token.access_token)
  const first = await (await reader.list("people", 1)).json(),
    second = await (await reader.list("people", 1, first.results.pageInfo.endCursor)).json()
  expect(first.results.pageInfo.hasNextPage).toBe(true)
  expect(second.results.pageInfo.hasNextPage).toBe(false)
  expect([first.results.data[0].id, second.results.data[0].id]).toEqual(["mock-person", "second"])
  expect((await reader.upload("mock-document")).status).toBe(403)
  expect((await reader.offboard([{ id: "mock-person", acknowledgerId: "second" }])).status).toBe(
    403,
  )
  expect(runtime.instance().uploads.count()).toBe(0)
  for (const kind of ["tests", "controls", "documents"])
    expect((await reader.list(kind)).status).toBe(200)
})
test("reauthentication recovers expired reads and revokes the preceding token", async () => {
  const { runtime, clock, fetchImpl, consumer } = setup()
  const first = await (await consumer.token()).json(),
    reader = client(fetchImpl, "http://vanta.test", first.access_token)
  expect((await reader.list()).status).toBe(200)
  clock.advance(3600000)
  expect(await (await reader.list()).text()).toBe("Unauthorized")
  const next = await (await consumer.token()).json(),
    fresh = client(fetchImpl, "http://vanta.test", next.access_token)
  expect((await fresh.list()).status).toBe(200)
  expect((await reader.list()).status).toBe(401)
  runtime.applyPreset("unauthorized_once", "default", { count: 1 })
  expect((await fresh.list()).status).toBe(401)
  expect((await fresh.list()).status).toBe(200)
  expect(runtime.instance().people.count()).toBe(1)
})
test("multipart upload and 204 submit persist observable document state", async () => {
  const { runtime, consumer } = setup()
  const response = await consumer.upload("mock-document")
  expect(response.status).toBe(201)
  expect(await response.json()).toMatchObject({
    fileName: "synthetic.txt",
    mimeType: "text/plain;charset=utf-8",
    uploadedBy: { type: "APPLICATION" },
  })
  expect((await (await consumer.get("documents", "mock-document")).json()).uploadStatus).toBe(
    "Needs document",
  )
  const submitted = await consumer.submit("mock-document")
  expect(submitted.status).toBe(204)
  expect(await submitted.text()).toBe("")
  expect((await (await consumer.get("documents", "mock-document")).json()).uploadStatus).toBe("OK")
  expect(runtime.instance().uploads.list()[0]?.value.submitted).toBe(true)
})
test("unknown resources and failed submissions do not mutate resources", async () => {
  const { runtime, consumer } = setup()
  expect((await consumer.upload("missing")).status).toBe(404)
  expect((await consumer.submit("missing")).status).toBe(404)
  expect((await consumer.submit("mock-document")).status).toBe(400)
  expect(
    await (await consumer.offboard([{ id: "missing", acknowledgerId: "mock-person" }])).json(),
  ).toEqual({ results: [{ id: "missing", status: "ERROR", message: "Invalid Input" }] })
  runtime.applyPreset("upload_failed", "default", { count: 1 })
  expect((await consumer.upload("mock-document")).status).toBe(500)
  expect(runtime.instance().uploads.count()).toBe(0)
  await consumer.upload("mock-document")
  runtime.applyPreset("submit_failed", "default", { count: 1 })
  expect((await consumer.submit("mock-document")).status).toBe(500)
  expect(runtime.instance().uploads.list()[0]?.value.submitted).toBe(false)
  expect(runtime.instance().documents.get("mock-document")?.uploadStatus).toBe("Needs document")
  expect(runtime.instance().offboardings.count()).toBe(0)
})
test("offboarding checks eligibility per person and returns ordered bulk outcomes", async () => {
  const { runtime, consumer } = setup()
  const updates = [
    { id: "mock-person", acknowledgerId: "mock-person" },
    { id: "missing", acknowledgerId: "mock-person" },
  ]
  expect((await (await consumer.offboard(updates)).json()).results[0].status).toBe("ERROR")
  runtime.instance().eligibility.insert("mock-person", {
    monitoredAccountsInactive: true,
    customTasksComplete: true,
  })
  expect(
    (await (await consumer.offboard(updates)).json()).results.map(
      (value: { status: string }) => value.status,
    ),
  ).toEqual(["SUCCESS", "ERROR"])
  expect((await (await consumer.get("people", "mock-person")).json()).tasksSummary.status).toBe(
    "OFFBOARDING_COMPLETE",
  )
  expect(runtime.instance().offboardings.get("mock-person")?.acknowledgerId).toBe("mock-person")
})
test("namespaces, reset and metadata journals never leak evidence bytes", async () => {
  const { runtime, fetchImpl, consumer } = setup()
  const other = client(fetchImpl, "http://vanta.test/__admin/ns/other")
  await other.upload("mock-document", "never-log-this-synthetic-content")
  expect(runtime.instance().uploads.count()).toBe(0)
  expect(runtime.instance("other").uploads.count()).toBe(1)
  await consumer.upload("mock-document")
  await runtime.reset("other")
  expect(runtime.instance().uploads.count()).toBe(1)
  expect(runtime.instance("other").uploads.count()).toBe(0)
  const journal = await (await fetchImpl("http://vanta.test/__admin/requests")).text(),
    state = JSON.stringify(runtime.state())
  expect(journal).not.toContain("never-log-this-synthetic-content")
  expect(journal).not.toContain("mock_vanta_token")
  expect(state).not.toContain("Synthetic evidence bytes")
})
test("served HTTP preserves observed non-JSON 401 and all failure presets", async () => {
  const server = await createServer()
  try {
    const response = await fetch(`${server.url}/v1/people`)
    expect(response.status).toBe(401)
    expect(response.headers.get("content-type")).toBe("application/json")
    expect(await response.text()).toBe("Unauthorized")
    const consumer = client(fetch, server.url)
    server.runtime.applyPreset("rate_limited", "default", { count: 1 })
    expect((await consumer.list()).status).toBe(429)
    server.runtime.applyPreset("server_error", "default", { count: 1 })
    expect((await consumer.list()).status).toBe(503)
    server.runtime.applyPreset("connection_drop", "default", { count: 1 })
    // A POST avoids the HTTP client's transparent retry of a stale keep-alive GET.
    await expect(consumer.token()).rejects.toBeInstanceOf(TypeError)
    expect(Object.keys(VANTA_PRESETS)).toHaveLength(6)
  } finally {
    await server.close()
  }
})
