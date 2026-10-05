import { expect, test } from "bun:test"
import { AirtableAPI, createRuntime } from "./src/index.js"
import { createServer } from "./src/server.js"
import { client } from "./test/consumer.js"

const base = "http://airtable.test"
test("authorized metadata matches created field and persisted record", async () => {
  const api = new AirtableAPI({ now: () => Date.UTC(2026, 0, 1) }),
    c = client((r) => api.fetch(r), base)
  expect(await (await c.request("/v0/meta/whoami")).json()).toMatchObject({
    id: "usrSynthetic",
    email: "synthetic@example.invalid",
  })
  expect(await (await c.request("/v0/meta/bases")).json()).toMatchObject({
    bases: [{ id: "appMockBase" }],
  })
  const response = await c.request("/v0/meta/bases/appMockBase/tables/tblMockTable/fields", {
    name: "Score",
    type: "number",
    options: { precision: 0 },
  })
  expect(response.status).toBe(200)
  const field = (await response.json()) as { id: string }
  const write = await c.request("/v0/appMockBase/tblMockTable", {
    records: [{ fields: { Name: "Synthetic entry", [field.id]: 7 } }],
  })
  expect(write.status).toBe(200)
  const body = (await write.json()) as { records: { id: string; fields: unknown }[] }
  expect(body.records[0]?.fields).toEqual({ Name: "Synthetic entry", Score: 7 })
  expect(api.records.list()).toHaveLength(1)
  const schema = (await (await c.request("/v0/meta/bases/appMockBase/tables")).json()) as {
    tables: { fields: { id: string }[] }[]
  }
  expect(schema.tables[0]?.fields.map((f) => f.id)).toContain(field.id)
})
test("inaccessible bases and expired access fail without writing", async () => {
  let now = Date.UTC(2026, 0, 1)
  const api = new AirtableAPI({ now: () => now }),
    c = client((r) => api.fetch(r), base)
  expect(
    (await c.request("/v0/missing/tblMockTable", { records: [{ fields: { Name: "Rejected" } }] }))
      .status,
  ).toBe(403)
  const token = (await (
    await c.exchange({ grant_type: "refresh_token", refresh_token: "mock_airtable_refresh" })
  ).json()) as { access_token: string }
  expect((await c.request("/v0/meta/whoami")).status).toBe(401)
  now += 3600000
  expect(
    (await client((r) => api.fetch(r), base, token.access_token).request("/v0/meta/whoami")).status,
  ).toBe(401)
  expect(api.records.list()).toEqual([])
})
test("invalid values reject whole batch; fields use names or ids and omit empty cells", async () => {
  const api = new AirtableAPI(),
    c = client((r) => api.fetch(r), base)
  const path = "/v0/appMockBase/tblMockTable"
  expect(
    (await c.request(path, { records: [{ fields: { Name: "Valid" } }, { fields: { Name: 42 } }] }))
      .status,
  ).toBe(422)
  expect(api.records.list()).toHaveLength(0)
  expect((await c.request(path, { records: [{ fields: { Unknown: "value" } }] })).status).toBe(422)
  expect(api.records.list()).toHaveLength(0)
  const one = (await (
    await c.request(path, { fields: { fldMockName: "Value" }, returnFieldsByFieldId: true })
  ).json()) as { fields: unknown }
  expect(one.fields).toEqual({ fldMockName: "Value" })
  const empty = (await (await c.request(path, { fields: { Name: "" } })).json()) as {
    fields: unknown
  }
  expect(empty.fields).toEqual({})
})
test("OAuth S256 is mandatory, wrong verifier consumes code and refresh rotates", async () => {
  const verifier = "a".repeat(43),
    digest = new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
    )
  const challenge = btoa(String.fromCharCode(...digest))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "")
  const code = {
    code: "mock_code",
    clientId: "mock_client",
    userId: "usrSynthetic",
    scopes: ["schema.bases:read"],
    baseIds: ["appMockBase"],
    redirectUri: "https://example.invalid/callback",
    challenge,
    expiresAt: 4102444800000,
  }
  const api = new AirtableAPI({ codes: [code, { ...code, code: "mock_good_code" }] }),
    c = client((r) => api.fetch(r), base)
  const payload = {
    grant_type: "authorization_code",
    code: code.code,
    redirect_uri: code.redirectUri,
    code_verifier: "wrong",
  }
  expect((await c.exchange(payload)).status).toBe(400)
  expect((await c.exchange({ ...payload, code_verifier: verifier })).status).toBe(400)
  const responses = await Promise.all([
    c.exchange({ ...payload, code: "mock_good_code", code_verifier: verifier }),
    c.exchange({ ...payload, code: "mock_good_code", code_verifier: verifier }),
  ])
  expect(responses.map((r) => r.status).sort()).toEqual([200, 400])
  const success = responses.find((r) => r.status === 200)
  if (!success) throw new Error("Expected token")
  const token = (await success.json()) as {
    access_token: string
    refresh_token: string
    token_type: string
  }
  expect(token.token_type).toBe("Bearer ")
  expect(
    (await c.exchange({ grant_type: "refresh_token", refresh_token: token.refresh_token })).status,
  ).toBe(200)
  expect(
    (await c.exchange({ grant_type: "refresh_token", refresh_token: token.refresh_token })).status,
  ).toBe(400)
})
test("duplicate OAuth form parameters reject before rotating grants", async () => {
  const api = new AirtableAPI()
  const response = await api.fetch(
    new Request(`${base}/oauth2/v1/token`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        authorization: `Basic ${btoa("mock_client:mock_client_secret")}`,
      },
      body: "grant_type=refresh_token&refresh_token=mock_airtable_refresh&grant_type=refresh_token",
    }),
  )
  expect(response.status).toBe(400)
  expect(await response.json()).toMatchObject({ error: "invalid_request" })
  expect(api.grants.has("mock_airtable_token")).toBe(true)
  expect(api.grants.list()).toHaveLength(1)
  expect(
    (
      await client((r) => api.fetch(r), base).exchange({
        grant_type: "refresh_token",
        refresh_token: "mock_airtable_refresh",
      })
    ).status,
  ).toBe(200)
})
test("namespace reset and journal preserve isolated synthetic state", async () => {
  const runtime = createRuntime(),
    a = client((r) => runtime.fetch(r), `${base}/__admin/ns/a`),
    b = client((r) => runtime.fetch(r), `${base}/__admin/ns/b`)
  await a.request("/v0/appMockBase/tblMockTable", { fields: { Name: "Synthetic private value" } })
  await b.request("/v0/appMockBase/tblMockTable", { fields: { Name: "Other synthetic value" } })
  await runtime.fetch(new Request(`${base}/__admin/ns/a/__admin/reset`, { method: "POST" }))
  const state = async (ns: string) =>
    await (
      await runtime.fetch(new Request(`${base}/__admin/ns/${ns}/__admin/state/records`))
    ).json()
  expect(JSON.stringify(await state("a"))).not.toContain("Synthetic private value")
  expect(JSON.stringify(await state("b"))).toContain("Other synthetic value")
  await b.exchange({ grant_type: "refresh_token", refresh_token: "mock_airtable_refresh" })
  const log = await (
    await runtime.fetch(new Request(`${base}/__admin/ns/b/__admin/requests`))
  ).text()
  expect(log).not.toContain("Other synthetic value")
  expect(log).not.toContain("mock_client_secret")
  expect(log).not.toContain("mock_airtable_refresh")
})
test("served HTTP propagates quota, invalid schema and other presets", async () => {
  const server = await createServer(),
    c = client(fetch, server.url)
  try {
    expect((await c.request("/v0/meta/bases")).status).toBe(200)
    for (const [preset, status] of [
      ["unauthorized", 401],
      ["rate_limited", 429],
      ["server_error", 500],
      ["invalid_schema", 422],
    ] as const) {
      await fetch(`${server.url}/__admin/faults`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ preset, count: 1 }),
      })
      expect((await c.request("/v0/meta/bases")).status).toBe(status)
    }
    await fetch(`${server.url}/__admin/faults`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ preset: "connection_drop", count: 1 }),
    })
    await expect(
      client((r) => server.runtime.fetch(r), server.url).request("/v0/meta/bases"),
    ).rejects.toThrow()
  } finally {
    await server.close()
  }
})
