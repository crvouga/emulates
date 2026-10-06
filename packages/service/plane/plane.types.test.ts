import { describe, expect, test } from "bun:test"
import { createRuntime } from "./src/index.js"
import { PlaneHttpClient, parsePlanePage } from "./test/consumer.js"

const PROJECT = "33333333-3333-4333-8333-333333333333"
const BASE = `/api/v1/workspaces/acme/projects/${PROJECT}`
const MISSING = "00000000-0000-4000-8000-000000000000"
type WorkItemType = {
  id: string
  name: string
  is_default: boolean
  project_ids: string[]
  created_at: string
}
type Item = {
  id: string
  name: string
  type_id: string | null
  type: string | null
  sequence_id: number
}

const harness = () => {
  const runtime = createRuntime()
  runtime.clock.freeze()
  runtime.clock.set(Date.parse("2026-10-04T12:00:00Z"))
  const send = (
    path: string,
    body?: unknown,
    method = body === undefined ? "GET" : "POST",
    namespace = "default",
    key = "fixture-key",
  ) =>
    runtime.fetch(
      new Request(`http://plane.test${path}`, {
        method,
        headers: {
          "content-type": "application/json",
          "x-api-key": key,
          "x-emulates-namespace": namespace,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    )
  const sleeps: number[] = []
  const http = new PlaneHttpClient(
    "http://plane.test",
    { accessToken: "fixture-key", workspaceSlug: "acme", projectId: PROJECT },
    (input, init) => runtime.fetch(new Request(input, init)),
    async (ms) => {
      sleeps.push(ms)
    },
  )
  const request = (
    path: string,
    body?: Record<string, unknown>,
    method: "GET" | "POST" | "PATCH" = body === undefined ? "GET" : "POST",
  ) => http.requestJson({ path: `${BASE}${path}`, method, ...(body ? { body } : {}) })
  const seed = async (namespace = "default") => {
    const response = await send(
      "/__admin/work-item-types",
      {
        workspace: "acme",
        project: PROJECT,
        types: [
          { name: "Bug", description: "Fixture defects" },
          { name: "Feature" },
          { name: "Task", is_default: true },
        ],
      },
      "POST",
      namespace,
    )
    expect(response.status).toBe(200)
    return (await response.json()) as WorkItemType[]
  }
  return { runtime, send, request, seed, sleeps }
}

describe("Plane work-item type reconciliation", () => {
  test("seeded metadata has stable ids, and the vendor bare array terminates without pagination", async () => {
    const { request, seed, runtime } = harness()
    const seeded = await seed()
    const rows = (await request("/work-item-types/")) as WorkItemType[]
    expect(Array.isArray(rows)).toBe(true)
    expect(rows).toEqual(seeded)
    expect(rows.map((row) => row.name)).toEqual(["Bug", "Feature", "Task"])
    expect(new Set(rows.map((row) => row.id)).size).toBe(3)
    expect(rows.every((row) => row.project_ids.includes(PROJECT))).toBe(true)
    const page = parsePlanePage(
      await request("/work-item-types/?per_page=1&cursor=1:1:0"),
      (value) => value as WorkItemType,
    )
    expect(page.results).toEqual(rows)
    expect(page.nextCursor).toBeNull()
    expect(page.nextPageResults).toBe(false)
    runtime.clock.advance(5000)
    expect((await seed()).map((row) => [row.id, row.created_at])).toEqual(
      rows.map((row) => [row.id, row.created_at]),
    )
  })

  test("create and patch persist type_id and type; defaults and explicit patch null follow the serializer", async () => {
    const { request, seed } = harness()
    const types = await seed()
    const bug = types.find((row) => row.name === "Bug") as WorkItemType
    const feature = types.find((row) => row.name === "Feature") as WorkItemType
    const task = types.find((row) => row.name === "Task") as WorkItemType
    const created = (await request("/work-items/", {
      name: "Typed defect",
      type_id: bug.id,
    })) as Item
    expect(created).toMatchObject({ type_id: bug.id, type: bug.id })
    expect(await request(`/work-items/${created.id}/`)).toEqual(created)
    const updated = (await request(
      `/work-items/${created.id}/`,
      { type_id: feature.id },
      "PATCH",
    )) as Item
    expect(updated).toMatchObject({ type_id: feature.id, type: feature.id })
    expect(await request(`/work-items/${created.id}/`)).toEqual(updated)
    expect(await request(`/work-items/${created.id}/`, { type_id: null }, "PATCH")).toMatchObject({
      type_id: null,
      type: null,
    })
    expect(await request("/work-items/", { name: "Default task" })).toMatchObject({
      type_id: task.id,
      type: task.id,
    })
  })

  test("unknown type IDs reject create and patch atomically, including other changed fields", async () => {
    const { request, send, seed } = harness()
    const types = await seed()
    const created = (await request("/work-items/", {
      name: "Original",
      type_id: types[0]?.id,
    })) as Item
    const failed = await send(
      `${BASE}/work-items/${created.id}/`,
      { name: "Must not persist", type_id: MISSING },
      "PATCH",
    )
    expect(failed.status).toBe(400)
    expect(await failed.json()).toEqual({
      type_id: [`Invalid pk "${MISSING}" - object does not exist.`],
    })
    expect(await request(`/work-items/${created.id}/`)).toEqual(created)
    expect((await send(`${BASE}/work-items/`, { name: "Invalid", type_id: MISSING })).status).toBe(
      400,
    )
    const items = parsePlanePage(await request("/work-items/"), (value) => value as Item).results
    expect(items.map((row) => row.id)).toEqual([created.id])
    expect(await request("/work-items/", { name: "Next valid" })).toMatchObject({ sequence_id: 2 })
  })

  test("namespace reset, snapshots, mock timestamps, authentication and transient faults preserve assignments", async () => {
    const { runtime, request, send, seed, sleeps } = harness()
    const types = await seed()
    expect(types[0]?.created_at).toBe("2026-10-04T12:00:00.000Z")
    const item = (await request("/work-items/", {
      name: "Snapshot defect",
      type_id: types[0]?.id,
    })) as Item
    expect((await send(`${BASE}/work-item-types/`, undefined, "GET", "default", "")).status).toBe(
      401,
    )
    runtime.applyPreset("rate_limited", "default", { count: 2 })
    expect(await request("/work-item-types/")).toEqual(types)
    expect(sleeps).toEqual([2000, 8000])
    runtime.applyPreset("server_error", "default", { count: 1 })
    expect(
      (await send(`${BASE}/work-items/${item.id}/`, { type_id: types[1]?.id }, "PATCH")).status,
    ).toBe(500)
    expect(await request(`/work-items/${item.id}/`)).toEqual(item)
    const snapshot = (await (await send("/__admin/snapshots", {})).json()) as { id: string }
    await request(`/work-items/${item.id}/`, { type_id: types[1]?.id }, "PATCH")
    await send(`/__admin/snapshots/${snapshot.id}/restore`, {})
    expect(await request(`/work-items/${item.id}/`)).toEqual(item)
    expect(
      await (await send(`${BASE}/work-item-types/`, undefined, "GET", "other")).json(),
    ).toEqual([])
    await seed("other")
    await send("/__admin/reset", {})
    expect(await request("/work-item-types/")).toEqual([])
    expect(
      await (await send(`${BASE}/work-item-types/`, undefined, "GET", "other")).json(),
    ).toEqual(types)
  })

  test("invalid seed batches fail before provisioning types or a project", async () => {
    const { send, runtime } = harness()
    const response = await send("/__admin/work-item-types", {
      workspace: "acme",
      project: PROJECT,
      types: [{ name: "Bug" }, { name: "" }],
    })
    expect(response.status).toBe(400)
    expect(runtime.instance("default").state.projects.get(PROJECT)).toBeUndefined()
    expect(await (await send(`${BASE}/work-item-types/`)).json()).toEqual([])
  })
})
