import { describe, expect, test } from "bun:test"
import { createRuntime } from "./src/index.js"
import { FetchRequestClient } from "./test/consumer.js"
import { Twilio } from "./test/twilio-sdk.js"

const ACCOUNT = `AC${"0".repeat(32)}`
const OTHER = `AC${"1".repeat(32)}`
const base = (account = ACCOUNT) => `/api/2010-04-01/Accounts/${account}/Messages.json`

const harness = () => {
  const runtime = createRuntime()
  runtime.clock.freeze()
  const send = (request: Request) => runtime.fetch(request)
  const request = (path: string, body?: unknown, account = ACCOUNT) =>
    send(
      new Request(`http://mock.test${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          authorization: `Basic ${btoa(`${account}:fixture-token`)}`,
          "content-type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    )
  const client = new Twilio(ACCOUNT, "fixture-token", {
    httpClient: new FetchRequestClient("http://mock.test", send),
  })
  const create = (body: string) =>
    client.messages.create({ to: "+12025550123", from: "+12025550124", body })
  return { runtime, send, request, client, create }
}

describe("Message collection reconciliation (#257)", () => {
  test("accepted Message resources are listed with their current status and dates", async () => {
    const { create, request } = harness()
    const message = await create("synthetic message")
    const response = await request(base())
    expect(response.status).toBe(200)
    const page = (await response.json()) as {
      messages: { sid: string; status: string; date_created: string }[]
    }
    expect(page.messages).toHaveLength(1)
    expect(page.messages[0]).toMatchObject({ sid: message.sid, status: message.status })
    const detail = await (
      await request(`${base().replace(".json", "")}/${message.sid}.json`)
    ).json()
    expect(page.messages[0]).toEqual(detail)
  })

  test("raw next-page links enumerate every SID exactly once and terminate", async () => {
    const { create, request } = harness()
    const ids = []
    for (let i = 0; i < 3; i++) ids.push((await create(`fixture-${i}`)).sid)
    let path: string | null = `${base()}?PageSize=1`
    const seen = []
    for (let i = 0; i < 3; i++) {
      if (!path) throw new Error("pagination ended early")
      const response = await request(path)
      expect(response.status).toBe(200)
      const page = (await response.json()) as {
        messages: { sid: string }[]
        next_page_uri: string | null
      }
      expect(page.messages).toHaveLength(1)
      seen.push(page.messages[0]?.sid)
      // Apply the same documented product prefix as the app's URL rewrite.
      path = page.next_page_uri ? `/api${page.next_page_uri}` : null
    }
    expect(path).toBeNull()
    expect(seen).toEqual([...ids].reverse())
  })

  test("the unmodified SDK follows collection pagination", async () => {
    const { create, client } = harness()
    const ids = []
    for (let i = 0; i < 3; i++) ids.push((await create(`sdk-fixture-${i}`)).sid)
    const messages = await client.messages.list({ pageSize: 1, limit: 10 })
    expect(messages.map((message) => message.sid)).toEqual([...ids].reverse())
    expect(messages.every((message) => message.dateCreated instanceof Date)).toBe(true)
  })

  test("another account and namespace cannot see the first account's messages", async () => {
    const { create, request } = harness()
    await create("fixture-isolated")
    for (const path of [base(OTHER), `/ns/other${base()}`]) {
      const page = (await (await request(path, undefined, OTHER)).json()) as {
        messages: unknown[]
        next_page_uri: string | null
      }
      expect(page.messages).toEqual([])
      expect(page.next_page_uri).toBeNull()
    }
  })

  test("auth, invalid cursors, reset and transient failures preserve collection state", async () => {
    const { create, request, send } = harness()
    await create("fixture-fault")
    expect((await send(new Request(`http://mock.test${base()}`))).status).toBe(401)
    expect((await request(`${base()}?PageToken=invalid`)).status).toBe(400)
    expect((await request(`${base()}?PageSize=0`)).status).toBe(400)
    for (const status of [429, 500]) {
      expect(
        (
          await request("/__admin/faults", {
            method: "GET",
            pathPrefix: base(),
            status,
            count: 1,
            body: {
              code: 20003,
              message: "synthetic failure",
              status,
              more_info: "https://www.twilio.com/docs/errors/20003",
            },
          })
        ).status,
      ).toBe(201)
      expect((await request(base())).status).toBe(status)
      const page = (await (await request(base())).json()) as { messages: unknown[] }
      expect(page.messages).toHaveLength(1)
    }
    await request("/__admin/reset", {})
    expect(await (await request(base())).json()).toMatchObject({
      messages: [],
      next_page_uri: null,
    })
  })
})
