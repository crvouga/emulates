import { expect, test } from "bun:test"
import { CHECKR_PRESETS, createRuntime, DEFAULT_PACKAGES } from "./src/index.js"
import { createServer } from "./src/server.js"
import { call, enumerate } from "./test/consumer.js"

const origin = "http://checkr.mock"
test("URLSearchParams candidates use Fetch-inferred form content type", async () => {
  const runtime = createRuntime()
  const response = await runtime.fetch(
    new Request(`${origin}/v1/candidates`, {
      method: "POST",
      headers: { authorization: `Basic ${btoa("mock_checkr_key:")}` },
      body: new URLSearchParams({
        email: "form@example.test",
        first_name: "Synthetic",
        last_name: "Form",
      }),
    }),
  )
  expect(response.status).toBe(201)
  expect((await response.json()).email).toBe("form@example.test")
  expect(runtime.instance().candidates.count()).toBe(1)
})
const work_locations = [{ country: "US", state: "AZ", city: "Synthetic City" }]
test("candidate, package, invitation and report relationships persist", async () => {
  const runtime = createRuntime()
  const send = runtime.fetch.bind(runtime)
  const candidate = await (
    await call(send, origin, "/v1/candidates", {
      email: "candidate@example.test",
      first_name: "Synthetic",
      last_name: "Candidate",
    })
  ).json()
  const created = await call(send, origin, "/v1/invitations", {
    candidate_id: candidate.id,
    package: "synthetic_basic",
    work_locations,
  })
  expect(created.status).toBe(201)
  const invitation = await created.json()
  expect(invitation.status).toBe("pending")
  expect(
    (await (await call(send, origin, `/v1/invitations/${invitation.id}`)).json()).candidate_id,
  ).toBe(candidate.id)
  expect((await enumerate(send, origin, "/v1/invitations"))[0]?.id).toBe(invitation.id)
  runtime.instance().reports.insert("report_mock", {
    id: "report_mock",
    candidate_id: candidate.id,
    package: "synthetic_basic",
    status: "pending",
    result: null,
    adjudication: null,
    estimated_completion_time: "2026-10-06T00:00:00.000Z",
  })
  expect((await (await call(send, origin, "/v1/reports/report_mock")).json()).status).toBe(
    "pending",
  )
  expect(
    (await (await call(send, origin, "/v1/reports/report_mock/eta")).json())
      .estimated_completion_time,
  ).toBe("2026-10-06T00:00:00.000Z")
  expect((await enumerate(send, origin, "/v1/candidates"))[0]?.report_ids).toEqual(["report_mock"])
})
test("pagination stays on origin and retains a relocated path namespace", async () => {
  const runtime = createRuntime({
    adminPrefix: "/_control",
    packages: Array.from({ length: 3 }, (_, i) => ({
      id: `package_${i}`,
      slug: `package_${i}`,
      name: "Synthetic package",
      price: i,
    })),
  })
  const send = runtime.fetch.bind(runtime)
  runtime.instance("isolated").packages.delete("package_1")
  const rows = await enumerate(send, origin, "/_control/ns/isolated/v1/packages?per_page=1")
  expect(rows.map((row) => row.id)).toEqual(["package_0", "package_2"])
  expect((await enumerate(send, origin, "/v1/packages?per_page=1")).length).toBe(3)
})
test("cancellation uses deleted_at visibility; clock expiry changes status", async () => {
  const runtime = createRuntime({ invitationTtlMs: 1000 })
  runtime.clock.freeze()
  const send = runtime.fetch.bind(runtime)
  const candidate = await (
    await call(send, origin, "/v1/candidates", { email: "candidate@example.test" })
  ).json()
  const invite = async () =>
    (
      await call(send, origin, "/v1/invitations", {
        candidate_id: candidate.id,
        package: "synthetic_basic",
        work_locations,
      })
    ).json()
  const first = await invite()
  const canceled = await (
    await call(send, origin, `/v1/invitations/${first.id}`, undefined, "DELETE")
  ).json()
  expect(typeof canceled.deleted_at).toBe("string")
  expect(canceled.status).toBe("pending")
  expect((await call(send, origin, `/v1/invitations/${first.id}`)).status).toBe(404)
  expect(
    (await call(send, origin, `/v1/invitations/${first.id}?include_deleted=true`)).status,
  ).toBe(200)
  expect(await enumerate(send, origin, "/v1/invitations")).toEqual([])
  const second = await invite()
  runtime.clock.advance(1001)
  expect((await (await call(send, origin, `/v1/invitations/${second.id}`)).json()).status).toBe(
    "expired",
  )
})
test("hierarchy denial is scoped and invalid references never create orphans", async () => {
  const runtime = createRuntime()
  const send = runtime.fetch.bind(runtime)
  expect((await call(send, origin, "/v1/nodes?include=packages")).status).toBe(403)
  expect((await enumerate(send, origin, "/v1/packages")).length).toBe(DEFAULT_PACKAGES.length)
  expect(
    (
      await call(send, origin, "/v1/invitations", {
        candidate_id: "missing",
        package: "synthetic_basic",
        work_locations,
      })
    ).status,
  ).toBe(404)
  const candidate = await (
    await call(send, origin, "/v1/candidates", { email: "candidate@example.test" })
  ).json()
  expect(
    (
      await call(send, origin, "/v1/invitations", {
        candidate_id: candidate.id,
        package: "missing",
        work_locations,
      })
    ).status,
  ).toBe(400)
  expect(runtime.instance().invitations.count()).toBe(0)
  runtime.instance().settings.update("account", { hierarchyEnabled: true })
  runtime.instance().nodes.insert("synthetic", {
    custom_id: "synthetic",
    name: "Synthetic department",
    packages: ["synthetic_basic"],
  })
  expect((await enumerate(send, origin, "/v1/nodes?include=packages"))[0]?.packages).toEqual([
    "synthetic_basic",
  ])
})
test("served auth, credential namespace, reset, faults and metadata-only journal", async () => {
  const server = await createServer()
  try {
    const send = (r: Request) => fetch(r)
    expect((await fetch(`${server.url}/v1/packages`)).status).toBe(401)
    expect((await call(send, server.url, "/v1/packages")).status).toBe(200)
    const admin = (path: string, body: unknown, method = "POST") =>
      fetch(`${server.url}/__admin${path}`, {
        method,
        headers: { "content-type": "application/json", "x-emulators-namespace": "mapped" },
        body: JSON.stringify(body),
      })
    await admin("/credentials", { credentials: { mock_checkr_key: "mapped" } }, "PUT")
    await call(send, server.url, "/v1/candidates", { email: "synthetic@example.test" })
    expect(server.runtime.instance("mapped").candidates.count()).toBe(1)
    for (const preset of Object.keys(CHECKR_PRESETS)) {
      await admin("/faults", { preset, count: 1 })
      const req = () =>
        preset === "connection_drop"
          ? call(send, server.url, "/v1/candidates", { email: "synthetic@example.test" })
          : call(send, server.url, preset === "hierarchy_denied" ? "/v1/nodes" : "/v1/packages")
      if (preset === "connection_drop") await expect(req()).rejects.toThrow()
      else
        expect((await req()).status).toBe(
          (
            {
              forbidden: 403,
              hierarchy_denied: 403,
              rate_limited: 429,
              server_error: 500,
              non_json: 502,
            } as Record<string, number>
          )[preset] ?? 0,
        )
    }
    const journal = await (await fetch(`${server.url}/__admin/requests`)).text()
    expect(journal).not.toContain("mock_checkr_key")
    expect(journal).not.toContain("synthetic@example.test")
    await admin("/reset", {})
    expect(server.runtime.instance("mapped").candidates.count()).toBe(0)
  } finally {
    await server.close()
  }
})
