import { describe, expect, test } from "bun:test"
import { createRuntime } from "./src/index.js"
import { PostHogManagementClient } from "./test/consumer.js"

type Flag = {
  id: number
  key: string
  active: boolean
  version: number
  filters: Record<string, unknown>
}
type Experiment = {
  id: number
  name: string
  parameters: Record<string, unknown>
  metrics: unknown[]
  feature_flag: Flag
  start_date: string | null
  end_date: string | null
  archived: boolean
}
const harness = () => {
  const runtime = createRuntime()
  runtime.clock.freeze()
  const send = (path: string, body?: unknown, method = body === undefined ? "GET" : "POST") =>
    runtime.fetch(
      new Request(new URL(path, "http://posthog.mock"), {
        method,
        headers: { authorization: "Bearer fixture-key", "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    )
  const client = new PostHogManagementClient("http://posthog.mock", "fixture-key", (url, init) =>
    runtime.fetch(new Request(url, init)),
  )
  const draft = (name = "Synthetic experiment", key = "synthetic-test") =>
    client.request<Experiment>("/api/projects/1/experiments/", {
      name,
      feature_flag_key: key,
      parameters: { minimum_detectable_effect: 10 },
      metrics: [],
    })
  return { runtime, send, client, draft }
}

describe("project management (#259, #260)", () => {
  test("pagination preserves a custom admin prefix and namespace", async () => {
    const runtime = createRuntime({ adminPrefix: "/_control" })
    const client = new PostHogManagementClient("http://posthog.mock", "fixture-key", (url, init) =>
      runtime.fetch(new Request(url, init)),
    )
    const path = "/_control/ns/custom/api/projects/1/experiments/"
    for (let i = 0; i < 2; i++)
      await client.request(path, { name: `Custom ${i}`, feature_flag_key: `custom-${i}` })
    const page = await client.request<{ next: string }>(`${path}?limit=1`)
    expect(new URL(page.next).pathname).toBe(path)
    expect(await client.experiments<Experiment>(`${path}?limit=1`)).toHaveLength(2)
    expect(await client.experiments<Experiment>("/api/projects/1/experiments/")).toHaveLength(0)
  })

  test("a draft experiment shares its linked flag with management reads", async () => {
    const { client, draft } = harness()
    const created = await draft()
    expect(created.feature_flag.key).toBe("synthetic-test")
    expect(created.feature_flag.active).toBe(false)
    expect(created.parameters).toMatchObject({ minimum_detectable_effect: 10 })
    const read = await client.request<Experiment>(`/api/projects/1/experiments/${created.id}/`)
    expect(read).toEqual(created)
    expect(await client.experiments<Experiment>("/api/projects/1/experiments/")).toEqual([created])
    expect(
      await client.request<Flag>(`/api/projects/1/feature_flags/${created.feature_flag.id}/`),
    ).toMatchObject(created.feature_flag)
  })

  test("launch, stop and archive fields preserve parameters and the live linked flag", async () => {
    const { client, draft } = harness()
    const created = await draft()
    const launched = await client.request<Experiment>(
      `/api/projects/1/experiments/${created.id}/`,
      { start_date: "2026-01-01T00:00:00Z" },
      "PATCH",
    )
    expect(launched.feature_flag.active).toBe(true)
    expect(launched.parameters).toEqual(created.parameters)
    const stopped = await client.request<Experiment>(
      `/api/projects/1/experiments/${created.id}/`,
      { end_date: "2026-01-02T00:00:00Z", archived: true },
      "PATCH",
    )
    expect(stopped).toMatchObject({
      start_date: launched.start_date,
      end_date: "2026-01-02T00:00:00Z",
      archived: true,
      parameters: created.parameters,
    })
    // Ending via dates does not disable the flag: PostHog continues serving variants.
    expect(stopped.feature_flag).toEqual(launched.feature_flag)
    await client.request(
      `/api/projects/1/feature_flags/${created.feature_flag.id}/`,
      { active: false },
      "PATCH",
    )
    expect(
      (await client.request<Experiment>(`/api/projects/1/experiments/${created.id}/`)).feature_flag
        .active,
    ).toBe(false)
  })

  test("next links enumerate each experiment once", async () => {
    const { draft, client } = harness()
    const ids = []
    for (let i = 0; i < 3; i++) ids.push((await draft(`Synthetic ${i}`, `synthetic-${i}`)).id)
    const listed = await client.experiments<Experiment>("/api/projects/1/experiments/?limit=1")
    expect(listed.map((item) => item.id).sort()).toEqual(ids.sort())
  })

  test("GET by numeric flag id matches the existing list", async () => {
    const { send, client } = harness()
    await send("/__admin/flags/synthetic-test", { default: true }, "PUT")
    const page = await client.request<{ results: Flag[] }>("/api/projects/1/feature_flags/")
    const flag = page.results[0]
    if (!flag) throw new Error("missing seeded flag")
    expect(await client.request<Flag>(`/api/projects/1/feature_flags/${flag.id}/`)).toEqual(flag)
  })

  test("GET reads patched filters, active and version", async () => {
    const { client } = harness()
    const flag = await client.request<Flag>("/api/projects/1/feature_flags/", {
      key: "synthetic-test",
      filters: { groups: [{ rollout_percentage: 100 }] },
    })
    const updated = await client.request<Flag>(
      `/api/projects/1/feature_flags/${flag.id}/`,
      { active: false, filters: { groups: [{ rollout_percentage: 0 }] } },
      "PATCH",
    )
    const read = await client.request<Flag>(`/api/projects/1/feature_flags/${flag.id}/`)
    expect(read).toEqual(updated)
    expect(read.active).toBe(false)
    expect(read.filters).toMatchObject({ groups: [{ rollout_percentage: 0 }] })
    expect(read.version).toBeGreaterThan(flag.version)
  })

  test("unknown flag ids preserve the documented error", async () => {
    const { send } = harness()
    const response = await send("/api/projects/1/feature_flags/99999/")
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({
      type: "invalid_request",
      code: "not_found",
      detail: "Not found.",
      attr: null,
    })
  })

  test("non-object payload maps cannot mutate an experiment's linked flag (seed 172181039)", async () => {
    const { client, draft, send } = harness()
    const experiment = await draft("a", "0")
    const path = `/api/projects/1/feature_flags/${experiment.feature_flag.id}/`
    const original = await client.request<Flag>(path)
    for (const payloads of [[], ["payload"], "payload", 1, false]) {
      const response = await send(path, { active: true, filters: { payloads } }, "PATCH")
      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({ type: "validation_error", attr: "filters" })
      expect(await client.request<Flag>(path)).toEqual(original)
      expect(
        await client.request<Experiment>(`/api/projects/1/experiments/${experiment.id}/`),
      ).toEqual(experiment)
    }
    const updated = await client.request<Flag>(
      path,
      { filters: { payloads: { control: '{"value":1}' } } },
      "PATCH",
    )
    expect(updated.filters.payloads).toEqual({ control: '{"value":1}' })
  })

  test("creating a flag with a non-object payload map fails without storing it", async () => {
    const { client, send } = harness()
    const path = "/api/projects/1/feature_flags/"
    const before = await client.request<{ results: Flag[] }>(path)
    const response = await send(path, { key: "invalid-payload-map", filters: { payloads: [] } })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ type: "validation_error", attr: "filters" })
    expect(await client.request<{ results: Flag[] }>(path)).toEqual(before)
    expect(
      (await send(path, { key: "invalid-payload-map", filters: { payloads: {} } })).status,
    ).toBe(201)
  })
  test("draft variant updates and direct flag edits share one flag state", async () => {
    const { client, draft } = harness()
    const created = await draft()
    const parameters = {
      feature_flag_variants: [
        { key: "control", split_percent: 25 },
        { key: "test", split_percent: 75 },
      ],
      minimum_detectable_effect: 20,
    }
    const changed = await client.request<Experiment>(
      `/api/projects/1/experiments/${created.id}/`,
      { parameters },
      "PATCH",
    )
    expect(changed.parameters).toMatchObject(parameters)
    expect(changed.feature_flag.filters).toMatchObject({
      multivariate: {
        variants: [
          { key: "control", rollout_percentage: 25 },
          { key: "test", rollout_percentage: 75 },
        ],
      },
    })
    expect(
      await client.request<Flag>(`/api/projects/1/feature_flags/${created.feature_flag.id}/`),
    ).toMatchObject(changed.feature_flag)
  })

  test("namespace pagination, snapshot restore, clock, auth and retry remain isolated", async () => {
    const { runtime, send, client, draft } = harness()
    const created = await draft()
    const snapshot = (await (await send("/__admin/snapshots", {})).json()) as { id: string }
    runtime.clock.advance(1000)
    const patched = await client.request<Experiment & { updated_at: string }>(
      `/api/projects/1/experiments/${created.id}/`,
      { name: "Changed" },
      "PATCH",
    )
    expect(patched.updated_at).toBe(new Date(runtime.clock.now()).toISOString())
    await send(`/__admin/snapshots/${snapshot.id}/restore`, {})
    expect(await client.request<Experiment>(`/api/projects/1/experiments/${created.id}/`)).toEqual(
      created,
    )
    const isolated = new PostHogManagementClient(
      "http://posthog.mock",
      "fixture-key",
      (url, init) => runtime.fetch(new Request(url, init)),
    )
    for (let i = 0; i < 2; i++)
      await isolated.request("/__admin/ns/other/api/projects/1/experiments/", {
        name: `Synthetic ${i}`,
        feature_flag_key: `isolated-${i}`,
      })
    expect(
      await isolated.experiments<Experiment>(
        "/__admin/ns/other/api/projects/1/experiments/?limit=1",
      ),
    ).toHaveLength(2)
    expect(await client.experiments<Experiment>("/api/projects/1/experiments/")).toHaveLength(1)
    expect(await client.experiments<Experiment>("/api/projects/2/experiments/")).toHaveLength(0)
    expect((await send(`/api/projects/2/experiments/${created.id}/`)).status).toBe(404)
    for (const path of [
      "/api/projects/1/experiments/",
      `/api/projects/1/experiments/${created.id}/`,
      `/api/projects/1/feature_flags/${created.feature_flag.id}/`,
    ]) {
      expect((await runtime.fetch(new Request(`http://posthog.mock${path}`))).status).toBe(401)
      for (const status of [429, 500]) {
        await send("/__admin/faults", {
          method: "GET",
          pathPrefix: path.replace(/\/$/, ""),
          status,
          count: 1,
        })
        expect((await send(path)).status).toBe(status)
        expect((await send(path)).status).toBe(200)
      }
    }
    await send("/__admin/reset", {})
    expect(await client.experiments<Experiment>("/api/projects/1/experiments/")).toEqual([])
    expect(
      await isolated.experiments<Experiment>(
        "/__admin/ns/other/api/projects/1/experiments/?limit=1",
      ),
    ).toHaveLength(2)
  })

  test("invalid requests and failed pages leave management state intact", async () => {
    const { client, draft, send } = harness()
    const first = await draft("First", "synthetic-first")
    await draft("Second", "synthetic-second")
    const page = await client.request<{ next: string }>("/api/projects/1/experiments/?limit=1")
    expect(page.next).toBeTruthy()
    await send("/__admin/faults", {
      method: "GET",
      pathPrefix: "/api/projects/1/experiments",
      status: 500,
      count: 1,
    })
    expect((await send(page.next)).status).toBe(500)
    expect((await client.request<{ results: Experiment[] }>(page.next)).results[0]?.id).toBe(
      first.id,
    )
    for (const body of [
      { start_date: "invalid" },
      { start_date: "2026-01-02T00:00:00Z", end_date: "2026-01-01T00:00:00Z" },
      { parameters: { feature_flag_variants: [{ key: "control", split_percent: 10 }] } },
    ]) {
      expect((await send(`/api/projects/1/experiments/${first.id}/`, body, "PATCH")).status).toBe(
        400,
      )
    }
    expect(await client.request<Experiment>(`/api/projects/1/experiments/${first.id}/`)).toEqual(
      first,
    )
  })
})
