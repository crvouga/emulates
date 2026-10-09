import { expect } from "bun:test"
import type { ServiceName } from "./targets.js"

type Requester = (path: string, init?: RequestInit) => Promise<Response>
type Json = Record<string, unknown>
type Scenario = (request: Requester) => Promise<unknown>
const object = (value: unknown): Json => {
  expect(value).toBeObject()
  return value as Json
}
const rows = (value: unknown): Json[] => {
  expect(value).toBeArray()
  return (value as unknown[]).map(object)
}
const pick = (value: Json, keys: string[]): Json =>
  Object.fromEntries(keys.map((key) => [key, value[key]]))
const json = async (
  request: Requester,
  path: string,
  method = "GET",
  data?: unknown,
  token = "test_token_admin",
  status = 200,
): Promise<Json> => {
  const response = await request(path, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(data !== undefined ? { body: JSON.stringify(data) } : {}),
  })
  expect(response.status, `${method} ${path}`).toBe(status)
  return object(await response.json())
}
const discovery = async (request: Requester, tokenPath: string): Promise<unknown> => {
  const config = await json(request, "/.well-known/openid-configuration")
  const failure = await request(tokenPath, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "grant_type=invalid-oracle-grant",
  })
  expect(failure.status).toBeGreaterThanOrEqual(400)
  return { config, status: failure.status, error: await failure.json() }
}

export const scenarios: Record<ServiceName, Scenario> = {
  async vercel(request) {
    const project = await json(request, "/v11/projects", "POST", {
      name: "oracle-project",
      framework: "nextjs",
    })
    const listed = await json(request, "/v10/projects")
    const fetched = await json(request, `/v9/projects/${project.id}`)
    return {
      project: pick(project, ["name", "framework"]),
      fetched: pick(fetched, ["name", "framework"]),
      listed: rows(listed.projects)
        .map((p) => p.name)
        .sort(),
    }
  },
  async github(request) {
    const user = await json(request, "/user")
    const repo = await json(
      request,
      "/user/repos",
      "POST",
      { name: "oracle-repository", auto_init: true },
      "test_token_admin",
      201,
    )
    const issue = await json(
      request,
      `/repos/${repo.full_name}/issues`,
      "POST",
      { title: "oracle issue", body: "fixture", labels: [] },
      "test_token_admin",
      201,
    )
    const updated = await json(
      request,
      `/repos/${repo.full_name}/issues/${issue.number}`,
      "PATCH",
      { state: "closed" },
    )
    return {
      user: pick(user, ["login", "type"]),
      repo: pick(repo, ["name", "full_name", "private"]),
      issue: pick(issue, ["title", "body", "state", "number"]),
      updated: pick(updated, ["title", "state", "number"]),
    }
  },
  async google(request) {
    const label = await json(request, "/gmail/v1/users/me/labels", "POST", {
      name: "OracleLabel",
      labelListVisibility: "labelShow",
      messageListVisibility: "show",
    })
    const fetched = await json(request, `/gmail/v1/users/me/labels/${label.id}`)
    const drive = await json(request, "/drive/v3/files", "POST", {
      name: "oracle.txt",
      mimeType: "text/plain",
    })
    return {
      label: pick(label, ["name", "type", "labelListVisibility", "messageListVisibility"]),
      fetched: pick(fetched, ["name", "type"]),
      drive: pick(drive, ["name", "mimeType"]),
      oidc: await discovery(request, "/oauth2/token"),
    }
  },
  async slack(request) {
    const created = await json(
      request,
      "/api/conversations.create",
      "POST",
      {
        name: "oracle-channel",
      },
      "xoxb-oracle",
    )
    expect(created.ok).toBe(true)
    const channel = object(created.channel)
    const posted = await json(
      request,
      "/api/chat.postMessage",
      "POST",
      {
        channel: channel.id,
        text: "oracle message",
      },
      "xoxb-oracle",
    )
    expect(posted.ok).toBe(true)
    const history = await json(
      request,
      "/api/conversations.history",
      "POST",
      {
        channel: channel.id,
      },
      "xoxb-oracle",
    )
    expect(history.ok).toBe(true)
    return {
      channel: pick(channel, ["name", "is_private", "is_archived"]),
      message: pick(object(posted.message), ["text", "type"]),
      history: rows(history.messages).map((message) => pick(message, ["text", "type"])),
    }
  },
  apple: (request) => discovery(request, "/auth/token"),
  microsoft: (request) => discovery(request, "/oauth2/v2.0/token"),
  async okta(request) {
    const created = await json(
      request,
      "/api/v1/groups",
      "POST",
      { profile: { name: "OracleGroup", description: "fixture" } },
      "test_token_admin",
      201,
    )
    const fetched = await json(request, `/api/v1/groups/${created.id}`)
    return {
      created: pick(created, ["type", "profile"]),
      fetched: pick(fetched, ["type", "profile"]),
      oidc: await discovery(request, "/oauth2/v1/token"),
    }
  },
  async aws(request) {
    const created = await request("/s3/oracle-bucket", { method: "PUT" })
    expect(created.status).toBe(200)
    const bytes = Uint8Array.from([0, 255, 128, 10, 65])
    const uploaded = await request("/s3/oracle-bucket/a/b.bin", {
      method: "PUT",
      body: bytes,
      headers: { "content-type": "application/octet-stream" },
    })
    expect(uploaded.status).toBe(200)
    const fetched = await request("/s3/oracle-bucket/a/b.bin")
    expect(fetched.status).toBe(200)
    expect(new Uint8Array(await fetched.clone().arrayBuffer())).toEqual(bytes)
    return {
      bytes: [...new Uint8Array(await fetched.arrayBuffer())],
      etag: fetched.headers.get("etag"),
      type: fetched.headers.get("content-type"),
      length: fetched.headers.get("content-length"),
    }
  },
  async resend(request) {
    const headers = {
      authorization: "Bearer re_test_admin",
      "content-type": "application/json",
      "idempotency-key": "oracle-batch",
    }
    const payload = [
      {
        from: "sender@example.test",
        to: ["receiver@example.test"],
        subject: "oracle email",
        text: "fixture",
      },
    ]
    const send = async () => {
      const response = await request("/emails/batch", {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      })
      expect(response.status).toBe(200)
      return object(await response.json())
    }
    const first = await send()
    expect(await send()).toEqual(first)
    const id = rows(first.data)[0]?.id
    const email = await json(request, `/emails/${id}`, "GET", undefined, "re_test_admin")
    const domain = await json(
      request,
      "/domains",
      "POST",
      { name: "oracle.example.test" },
      "re_test_admin",
    )
    const verified = await json(
      request,
      `/domains/${domain.id}/verify`,
      "POST",
      {},
      "re_test_admin",
    )
    return {
      email: pick(email, ["from", "to", "subject", "text", "last_event"]),
      domain: pick(domain, ["name", "status", "region"]),
      verified: pick(verified, ["object", "status"]),
    }
  },
  async stripe(request) {
    const auth = {
      authorization: "Bearer sk_test_oracle",
      "content-type": "application/x-www-form-urlencoded",
    }
    const response = await request("/v1/products", {
      method: "POST",
      headers: auth,
      body: "name=Oracle+Product&metadata[fixture]=true",
    })
    expect(response.status).toBe(200)
    const product = object(await response.json())
    const fetchedResponse = await request(`/v1/products/${product.id}`, { headers: auth })
    expect(fetchedResponse.status).toBe(200)
    const fetched = object(await fetchedResponse.json())
    const customerResponse = await request("/v1/customers", {
      method: "POST",
      headers: auth,
      body: "email=fixture%40example.test",
    })
    expect(customerResponse.status).toBe(200)
    const customer = object(await customerResponse.json())
    const sessionResponse = await request("/v1/customer_sessions", {
      method: "POST",
      headers: auth,
      body: `customer=${customer.id}&components[payment_element][enabled]=true`,
    })
    expect(sessionResponse.status).toBe(200)
    const session = object(await sessionResponse.json())
    expect(session.customer).toBe(customer.id)
    expect(String(session.client_secret)).toStartWith("cuss_secret_")
    return {
      customerSession: {
        ...pick(session, ["object", "components", "livemode"]),
        lifetime: Number(session.expires_at) - Number(session.created),
      },
      product: pick(product, ["object", "name", "active", "metadata"]),
      fetched: pick(fetched, ["object", "name", "active", "metadata"]),
    }
  },
  async mongoatlas(request) {
    const target = { dataSource: "Cluster0", database: "test", collection: "items" }
    const inserted = await json(
      request,
      "/app/data-api/v1/action/insertOne",
      "POST",
      { ...target, document: { _id: "oracle-doc", name: "fixture", count: 1 } },
      "test_token_admin",
      201,
    )
    const updated = await json(request, "/app/data-api/v1/action/updateOne", "POST", {
      ...target,
      filter: { _id: "oracle-doc" },
      update: { $inc: { count: 2 } },
    })
    const found = await json(request, "/app/data-api/v1/action/findOne", "POST", {
      ...target,
      filter: { _id: "oracle-doc" },
    })
    expect(object(found.document).count).toBe(3)
    return { inserted, updated, found }
  },
  async clerk(request) {
    const created = await json(request, "/v1/users", "POST", {
      email_address: ["oracle@example.test"],
      first_name: "Fixture",
      last_name: "User",
    })
    const fetched = await json(request, `/v1/users/${created.id}`)
    const banned = await json(request, `/v1/users/${created.id}/ban`, "POST", {})
    expect(banned.banned).toBe(true)
    return {
      created: pick(created, ["object", "first_name", "last_name", "banned"]),
      fetched: pick(fetched, ["object", "first_name", "last_name", "banned"]),
      banned: pick(banned, ["object", "first_name", "banned"]),
    }
  },
  async linear(request) {
    const gql = async (query: string, variables?: unknown) =>
      json(request, "/graphql", "POST", { query, variables }, "lin_test_admin")
    const listed = await gql("query { teams { nodes { id key name } } }")
    const teams = rows(object(object(listed.data).teams).nodes)
    const team = teams.find((t) => t.key === "ENG")
    expect(team).toBeDefined()
    const created = await gql(
      "mutation($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { identifier title priority priorityLabel } } }",
      { input: { teamId: team?.id, title: "Oracle issue", priority: 2 } },
    )
    const result = object(object(created.data).issueCreate)
    expect(result.success).toBe(true)
    return { teams: teams.map((t) => pick(t, ["key", "name"])), created: result }
  },
  async twilio(request) {
    const account = "AC00000000000000000000000000000000"
    const headers = {
      authorization: `Basic ${Buffer.from(`${account}:twilio_test_auth_token`).toString("base64")}`,
      "content-type": "application/x-www-form-urlencoded",
    }
    const path = `/2010-04-01/Accounts/${account}/Messages.json`
    const created = await request(path, {
      method: "POST",
      headers,
      body: new URLSearchParams({
        To: "+15559876543",
        From: "+15551234567",
        Body: "Oracle message",
      }),
    })
    expect(created.status).toBe(201)
    const message = object(await created.json())
    const fetched = await request(`/2010-04-01/Accounts/${account}/Messages/${message.sid}.json`, {
      headers,
    })
    expect(fetched.status).toBe(200)
    return {
      created: pick(message, ["body", "from", "to", "status", "num_segments", "error_code"]),
      fetched: pick(object(await fetched.json()), [
        "body",
        "from",
        "to",
        "status",
        "num_segments",
        "error_code",
      ]),
    }
  },
}
