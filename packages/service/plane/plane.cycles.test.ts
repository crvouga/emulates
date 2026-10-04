import { describe, expect, test } from "bun:test"
import { createRuntime } from "./src/index.js"
import { PlaneHttpClient, parsePlanePage, parsePlaneWorkItem } from "./test/consumer.js"

const PROJECT = "33333333-3333-4333-8333-333333333333"
const MISSING = "00000000-0000-4000-8000-000000000000"
const BASE = `/api/v1/workspaces/acme/projects/${PROJECT}`
const NOW = Date.parse("2026-10-04T12:00:00Z")
type Cycle = { id: string; name: string; start_date: string | null; end_date: string | null }
type Membership = { id: string; cycle: string; issue: string }

const harness = () => {
  const runtime = createRuntime()
  runtime.clock.freeze()
  runtime.clock.set(NOW)
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
          "x-mockingbird-namespace": namespace,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    )
  const http = new PlaneHttpClient(
    "http://plane.test",
    { accessToken: "fixture-key", workspaceSlug: "acme", projectId: PROJECT },
    (input, init) => runtime.fetch(new Request(input, init)),
    async () => {},
  )
  const request = (
    path: string,
    body?: Record<string, unknown>,
    method: "GET" | "POST" | "PATCH" = body === undefined ? "GET" : "POST",
  ) => http.requestJson({ path: `${BASE}${path}`, method, ...(body ? { body } : {}) })
  const cycle = async (name: string, start?: string, end?: string) =>
    (await request("/cycles/", {
      name,
      ...(start ? { start_date: start } : {}),
      ...(end ? { end_date: end } : {}),
    })) as Cycle
  const item = async (name: string) => parsePlaneWorkItem(await request("/work-items/", { name }))
  return { runtime, send, request, cycle, item }
}

describe("Plane cycle workflows (official REST API and clock)", () => {
  test("current cycles use inclusive project-day boundaries and return the vendor's bare array", async () => {
    const { runtime, request, cycle } = harness()
    await cycle("Past", "2026-10-01", "2026-10-03")
    const current = await cycle("Current", "2026-10-04", "2026-10-04")
    const upcoming = await cycle("Upcoming", "2026-10-05", "2026-10-08")
    const draft = await cycle("Draft")
    expect(current.start_date).toBe("2026-10-04T12:00:00.000Z")
    expect(current.end_date).toBe("2026-10-04T23:59:00.000Z")
    expect(upcoming.start_date).toBe("2026-10-05T00:00:01.000Z")
    const rows = (await request("/cycles/?cycle_view=current")) as Cycle[]
    expect(Array.isArray(rows)).toBe(true)
    expect(rows.map((row) => row.id)).toEqual([current.id])
    runtime.clock.set(Date.parse(current.start_date as string))
    expect(await request("/cycles/?cycle_view=current")).toEqual(rows)
    runtime.clock.set(Date.parse(current.end_date as string))
    expect(await request("/cycles/?cycle_view=current")).toEqual(rows)
    runtime.clock.advance(1)
    expect(await request("/cycles/?cycle_view=current")).toEqual([])
    runtime.clock.set(Date.parse(upcoming.start_date as string))
    expect(
      ((await request("/cycles/?cycle_view=current")) as Cycle[]).map((row) => row.id),
    ).toEqual([upcoming.id])
    expect(
      parsePlanePage(
        await request("/cycles/?cycle_view=draft"),
        (value) => value as Cycle,
      ).results.map((row) => row.id),
    ).toEqual([draft.id])
  })

  test("membership deduplicates, moves between cycles and reads the live shared work item", async () => {
    const { request, cycle, item } = harness()
    const first = await cycle("First")
    const second = await cycle("Second")
    const workItem = await item("Fixture task")
    const path = `/cycles/${first.id}/cycle-issues/`
    const created = (await request(path, { issues: [workItem.id, workItem.id] })) as Membership[]
    expect(created).toHaveLength(1)
    expect(created[0]).toMatchObject({ cycle: first.id, issue: workItem.id })
    expect(await request(path, { issues: [workItem.id] })).toEqual(created)
    await request(`/work-items/${workItem.id}/`, { name: "Updated task" }, "PATCH")
    const page = parsePlanePage(await request(path), parsePlaneWorkItem)
    expect(page.results.map((row) => [row.id, row.name])).toEqual([[workItem.id, "Updated task"]])
    const moved = (await request(`/cycles/${second.id}/cycle-issues/`, {
      issues: [workItem.id],
    })) as Membership[]
    expect(moved[0]).toMatchObject({ id: created[0]?.id, cycle: second.id, issue: workItem.id })
    expect(parsePlanePage(await request(path), parsePlaneWorkItem).results).toEqual([])
    expect(
      parsePlanePage(
        await request(`/cycles/${second.id}/cycle-issues/`),
        parsePlaneWorkItem,
      ).results.map((row) => row.id),
    ).toEqual([workItem.id])
    const cycles = parsePlanePage(
      await request("/cycles/"),
      (value) => value as Cycle & { total_issues: number },
    ).results
    expect(cycles.find((row) => row.id === second.id)?.total_issues).toBe(1)
  })

  test("missing cycles fail; unknown and foreign work items are ignored without orphan memberships", async () => {
    const { send, request, cycle } = harness()
    const target = await cycle("Target")
    const missing = await send(`${BASE}/cycles/${MISSING}/cycle-issues/`, { issues: [MISSING] })
    expect(missing.status).toBe(404)
    expect(await missing.json()).toEqual({ error: "The requested resource does not exist." })
    expect(await request(`/cycles/${target.id}/cycle-issues/`, { issues: [MISSING] })).toEqual([])
    const foreignBase = BASE.replace(PROJECT, "44444444-4444-4444-8444-444444444444")
    const foreign = (await (
      await send(`${foreignBase}/work-items/`, { name: "Other project" })
    ).json()) as { id: string }
    expect(await request(`/cycles/${target.id}/cycle-issues/`, { issues: [foreign.id] })).toEqual(
      [],
    )
    expect(
      parsePlanePage(await request(`/cycles/${target.id}/cycle-issues/`), parsePlaneWorkItem)
        .results,
    ).toEqual([])
  })

  test("date validation, completed cycles and empty memberships reject before changing state", async () => {
    const { send, cycle, item } = harness()
    for (const body of [
      { name: "Missing end", start_date: "2026-10-04" },
      { name: "Invalid", start_date: "not-a-date", end_date: "2026-10-05" },
      { name: "Reversed", start_date: "2026-10-06", end_date: "2026-10-05" },
    ])
      expect((await send(`${BASE}/cycles/`, body)).status).toBe(400)
    const completed = await cycle("Completed", "2026-10-01", "2026-10-03")
    const workItem = await item("Task")
    const failed = await send(`${BASE}/cycles/${completed.id}/cycle-issues/`, {
      issues: [workItem.id],
    })
    expect(failed.status).toBe(400)
    expect(await failed.json()).toMatchObject({ code: "CYCLE_COMPLETED" })
    const empty = await send(`${BASE}/cycles/${completed.id}/cycle-issues/`, { issues: [] })
    expect(empty.status).toBe(400)
    expect(await empty.json()).toMatchObject({ code: "MISSING_WORK_ITEMS" })
  })

  test("cursor walks terminate for cycles and membership work items without losing rows", async () => {
    const { request, cycle, item } = harness()
    const ids: string[] = []
    for (let i = 0; i < 5; i++) ids.push((await cycle(`Cycle ${i}`)).id)
    const walk = async (path: string, parse: (value: unknown) => { id: string }) => {
      let cursor = "2:0:0"
      const seen: string[] = []
      for (let pages = 0; pages < 4; pages++) {
        const page = parsePlanePage(await request(`${path}?per_page=2&cursor=${cursor}`), parse)
        seen.push(...page.results.map((row) => row.id))
        if (!page.nextPageResults) return seen
        cursor = page.nextCursor as string
      }
      throw new Error("pagination did not terminate")
    }
    expect(new Set(await walk("/cycles/", (value) => value as Cycle))).toEqual(new Set(ids))
    const items = []
    for (let i = 0; i < 5; i++) items.push((await item(`Task ${i}`)).id)
    const path = `/cycles/${ids[0]}/cycle-issues/`
    await request(path, { issues: items })
    expect(await walk(path, parsePlaneWorkItem)).toEqual(items)
  })

  test("auth, faults, namespace reset and snapshot restore preserve the cycle graph", async () => {
    const { runtime, send, cycle, item, request } = harness()
    const target = await cycle("Snapshot")
    const workItem = await item("Snapshot task")
    const path = `${BASE}/cycles/${target.id}/cycle-issues/`
    expect((await send(path, undefined, "GET", "default", "")).status).toBe(401)
    runtime.applyPreset("rate_limited", "default", { count: 1 })
    expect((await send(path, { issues: [workItem.id] })).status).toBe(429)
    runtime.applyPreset("server_error", "default", { count: 1 })
    expect((await send(path, { issues: [workItem.id] })).status).toBe(500)
    expect(
      parsePlanePage(await request(`/cycles/${target.id}/cycle-issues/`), parsePlaneWorkItem)
        .results,
    ).toEqual([])
    await send(path, { issues: [workItem.id] })
    const snapshot = (await (await send("/__admin/snapshots", {})).json()) as { id: string }
    await send(`${BASE}/cycles/`, { name: "Other namespace" }, "POST", "other")
    const later = await item("Created after snapshot")
    await send(path, { issues: [later.id] })
    await send(`/__admin/snapshots/${snapshot.id}/restore`, {})
    expect(
      parsePlanePage(
        await request(`/cycles/${target.id}/cycle-issues/`),
        parsePlaneWorkItem,
      ).results.map((row) => row.id),
    ).toEqual([workItem.id])
    await send("/__admin/reset", {})
    expect(parsePlanePage(await request("/cycles/"), (value) => value as Cycle).results).toEqual([])
    const isolated = await send(path, { issues: [workItem.id] }, "POST", "other")
    expect(isolated.status).toBe(200)
    expect(await isolated.json()).toEqual([])
    const other = await (await send(`${BASE}/cycles/`, undefined, "GET", "other")).json()
    expect(parsePlanePage(other, (value) => value as Cycle).results.map((row) => row.name)).toEqual(
      ["Other namespace"],
    )
  })
})
