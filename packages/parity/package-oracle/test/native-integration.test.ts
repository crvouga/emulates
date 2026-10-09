import { expect, test } from "bun:test"
import { ResendAPI } from "../../../service/resend/src/index.js"
import { target } from "./targets.js"

const call = async (
  runtime: Awaited<ReturnType<typeof target>>,
  path: string,
  method = "GET",
  body?: unknown,
  token = "test_token_admin",
) =>
  runtime.fetch(
    new Request(`http://mock.local${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  )
const json = async (response: Response) => response.json() as Promise<Record<string, unknown>>

test("GitHub: repositories created through the expanded API work with native refs, issues and pulls", async () => {
  const runtime = await target("github", "http://mock.local")
  const repo = await json(
    await call(runtime, "/user/repos", "POST", { name: "mixed-repository", auto_init: true }),
  )
  expect(repo.full_name).toBe("admin/mixed-repository")
  const ref = await json(await call(runtime, "/repos/admin/mixed-repository/git/ref/heads/main"))
  const commit = (ref.object as { sha: string }).sha
  expect(commit).toMatch(/^[a-f0-9]{40}$/)
  expect(
    (
      await call(runtime, "/repos/admin/mixed-repository/git/refs", "POST", {
        ref: "refs/heads/topic",
        sha: commit,
      })
    ).status,
  ).toBe(201)
  const branches = await json(await call(runtime, "/repos/admin/mixed-repository/branches"))
  expect(JSON.stringify(branches)).toContain("topic")
  const issue = await json(
    await call(runtime, "/repos/admin/mixed-repository/issues", "POST", { title: "Mixed issue" }),
  )
  expect(issue.number).toBe(1)
  const saved = await json(await call(runtime, "/repos/admin/mixed-repository"))
  expect(saved.owner).toMatchObject({ login: "admin", type: "User" })
})

test("Slack: conversation creation, native message posting, history, and deletion share the outbox", async () => {
  const runtime = await target("slack", "http://mock.local")
  const created = await json(
    await call(
      runtime,
      "/api/conversations.create",
      "POST",
      { name: "mixed-channel" },
      "xoxb-oracle",
    ),
  )
  expect(created.ok).toBe(true)
  const channel = (created.channel as { id: string }).id
  const posted = await json(
    await call(
      runtime,
      "/api/chat.postMessage",
      "POST",
      { channel, text: "Mixed message" },
      "xoxb-oracle",
    ),
  )
  expect(posted.ok).toBe(true)
  const history = await json(
    await call(runtime, "/api/conversations.history", "POST", { channel }, "xoxb-oracle"),
  )
  expect(history.ok).toBe(true)
  expect(history.messages).toMatchObject([{ text: "Mixed message" }])
  const removed = await json(
    await call(runtime, "/api/chat.delete", "POST", { channel, ts: posted.ts }, "xoxb-oracle"),
  )
  expect(removed.ok).toBe(true)
  const after = await json(
    await call(runtime, "/api/conversations.history", "POST", { channel }, "xoxb-oracle"),
  )
  expect(after.messages).toEqual([])
  const outbox = await json(await call(runtime, "/__admin/outbox"))
  expect(JSON.stringify(outbox)).not.toContain("Mixed message")
})

test("Resend: batch sends are retrievable through the native email API and outbox", async () => {
  const runtime = await target("resend", "http://mock.local")
  const batch = await json(
    await call(runtime, "/emails/batch", "POST", [
      {
        from: "sender@example.test",
        to: ["recipient@example.test"],
        subject: "Mixed batch",
        text: "Fixture",
      },
    ]),
  )
  const id = (batch.data as { id: string }[])[0]?.id
  expect(id).toBeString()
  const email = await json(await call(runtime, `/emails/${id}`))
  expect(email).toMatchObject({ id, subject: "Mixed batch", text: "Fixture" })
  const outbox = await json(await call(runtime, "/__admin/outbox"))
  expect(JSON.stringify(outbox)).toContain("Mixed batch")
})

test("Twilio: canonical sends are visible through the original prefixed API", async () => {
  const runtime = await target("twilio", "http://mock.local")
  const account = "AC00000000000000000000000000000000"
  const headers = {
    authorization: `Basic ${btoa(`${account}:twilio_test_auth_token`)}`,
    "content-type": "application/x-www-form-urlencoded",
  }
  const sent = await runtime.fetch(
    new Request(`http://mock.local/2010-04-01/Accounts/${account}/Messages.json`, {
      method: "POST",
      headers,
      body: "To=%2B15551234568&From=%2B15551234567&Body=Mixed+message",
    }),
  )
  expect(sent.status).toBe(201)
  const message = await json(sent)
  const read = await runtime.fetch(
    new Request(
      `http://mock.local/api/2010-04-01/Accounts/${account}/Messages/${message.sid}.json`,
      { headers },
    ),
  )
  expect(read.status).toBe(200)
  expect(await json(read)).toMatchObject({ sid: message.sid, body: "Mixed message" })
})

test("Stripe customer sessions share native customers and stay account scoped", async () => {
  const runtime = await target("stripe", "http://mock.local")
  const headers = {
    authorization: "Bearer sk_test_oracle",
    "content-type": "application/x-www-form-urlencoded",
  }
  const customer = await json(
    await runtime.fetch(
      new Request("http://mock.local/v1/customers", {
        method: "POST",
        headers,
        body: "email=customer%40example.test",
      }),
    ),
  )
  const response = await runtime.fetch(
    new Request("http://mock.local/v1/customer_sessions", {
      method: "POST",
      headers,
      body: `customer=${customer.id}&components[payment_element][enabled]=true`,
    }),
  )
  expect(response.status).toBe(200)
  const session = await json(response)
  expect(session).toMatchObject({
    object: "customer_session",
    customer: customer.id,
    components: { payment_element: { enabled: "true" } },
    livemode: false,
  })
  expect(Number(session.expires_at) - Number(session.created)).toBe(1800)
  const other = await runtime.fetch(
    new Request("http://mock.local/v1/customer_sessions", {
      method: "POST",
      headers: { ...headers, authorization: "Bearer sk_test_other" },
      body: `customer=${customer.id}`,
    }),
  )
  expect(other.status).toBe(400)
})

test("GitHub: added issue labels survive native pull operations and repository updates", async () => {
  const runtime = await target("github", "http://mock.local")
  const a = "a".repeat(40),
    b = "b".repeat(40)
  expect(
    (
      await call(runtime, "/__admin/github/repositories", "POST", {
        owner: "fixture-org",
        name: "labels",
        commits: [
          { sha: a, parents: [] },
          { sha: b, parents: [a] },
        ],
        branches: { main: a, topic: b },
      })
    ).status,
  ).toBe(201)
  const root = "/repos/fixture-org/labels"
  const pull = await json(
    await call(runtime, `${root}/pulls`, "POST", {
      title: "Fixture pull",
      head: "topic",
      base: "main",
    }),
  )
  expect(pull.number).toBe(1)
  expect(
    (await call(runtime, `${root}/labels`, "POST", { name: "bug", color: "ff0000" })).status,
  ).toBe(201)
  expect((await call(runtime, `${root}/issues/1/labels`, "POST", { labels: ["bug"] })).status).toBe(
    200,
  )
  await call(runtime, `${root}/labels`)
  expect(await json(await call(runtime, `${root}/issues/1/labels`))).toMatchObject([
    { name: "bug" },
  ])
  const owned = await json(
    await call(runtime, "/user/repos", "POST", { name: "repository-update" }),
  )
  const ownRoot = `/repos/${owned.full_name}`
  expect((await call(runtime, ownRoot, "PATCH", { private: true })).status).toBe(200)
  expect(await json(await call(runtime, ownRoot))).toMatchObject({ private: true })
})

test("Slack: external uploads and view updates share native files and views", async () => {
  const runtime = await target("slack", "http://mock.local")
  const slack = (path: string, body: unknown) => call(runtime, path, "POST", body, "xoxb-oracle")
  const upload = await json(
    await slack("/api/files.getUploadURLExternal", { filename: "fixture.txt", length: 7 }),
  )
  expect(upload.ok).toBe(true)
  expect(
    (
      await runtime.fetch(
        new Request(String(upload.upload_url), { method: "POST", body: "fixture" }),
      )
    ).status,
  ).toBe(200)
  expect(
    await json(
      await slack("/api/files.completeUploadExternal", {
        files: [{ id: upload.file_id, title: "Fixture title" }],
      }),
    ),
  ).toMatchObject({ ok: true })
  expect(await json(await slack("/api/files.info", { file: upload.file_id }))).toMatchObject({
    ok: true,
    file: { title: "Fixture title", size: 7 },
  })
  const view = await json(
    await slack("/api/views.open", {
      trigger_id: "fixture-trigger",
      view: { type: "modal", title: { type: "plain_text", text: "Before" }, blocks: [] },
    }),
  )
  const id = (view.view as { id: string }).id
  expect(
    await json(
      await slack("/api/views.update", {
        view_id: id,
        view: { type: "modal", title: { type: "plain_text", text: "After" }, blocks: [] },
      }),
    ),
  ).toMatchObject({ ok: true, view: { id, title: { text: "After" } } })
  const state = await json(await call(runtime, "/__admin/state/views"))
  expect(JSON.stringify(state)).toContain("After")
})

test("Twilio: newly covered account routes work through the native SDK prefix", async () => {
  const runtime = await target("twilio", "http://mock.local")
  const account = "AC00000000000000000000000000000000"
  const headers = { authorization: `Basic ${btoa(`${account}:twilio_test_auth_token`)}` }
  const response = await runtime.fetch(
    new Request(`http://mock.local/api/2010-04-01/Accounts/${account}.json`, { headers }),
  )
  expect(response.status).toBe(200)
  expect(await json(response)).toMatchObject({ sid: account, status: "active" })
})

test("Resend: batch forwarding fires once per accepted email and never for an idempotent replay", async () => {
  const forwarded: string[] = []
  const api = new ResendAPI({
    onSent: (email) => {
      forwarded.push(email.id)
    },
  })
  const send = () =>
    api.fetch(
      new Request("http://mock.local/emails/batch", {
        method: "POST",
        headers: {
          authorization: "Bearer oracle-probe",
          "content-type": "application/json",
          "idempotency-key": "batch-forward",
        },
        body: JSON.stringify([
          {
            from: "sender@example.test",
            to: ["recipient@example.test"],
            subject: "Fixture",
            text: "Fixture",
          },
        ]),
      }),
    )
  expect((await send()).status).toBe(200)
  expect((await send()).status).toBe(200)
  expect(forwarded).toHaveLength(1)
})
