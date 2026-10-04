import { describe, expect, test } from "bun:test"
import { createRuntime } from "./src/index.js"
import { listResendEmails } from "./test/consumer.js"

for (const receiving of [false, true]) {
  describe(`${receiving ? "received" : "sent"} email collection (#${receiving ? 256 : 255})`, () => {
    const harness = () => {
      const runtime = createRuntime()
      runtime.clock.freeze()
      const send = (request: Request) => runtime.fetch(request)
      const call = (path: string, body?: unknown) =>
        send(
          new Request(`http://mock.test${path}`, {
            method: body === undefined ? "GET" : "POST",
            headers: { authorization: "Bearer fixture-key", "content-type": "application/json" },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          }),
        )
      const create = async (subject: string) => {
        const response = await call(receiving ? "/__admin/inbound" : "/emails", {
          from: "fixture@example.test",
          to: ["recipient@example.test"],
          subject,
          text: "synthetic email",
        })
        expect(response.status).toBe(receiving ? 201 : 200)
        return (await response.json()) as { id: string }
      }
      const list = (query: { limit?: number; after?: string; before?: string } = {}) =>
        listResendEmails(send, "http://mock.test", receiving, query)
      return { send, call, create, list }
    }

    test("newest-first pages terminate and reach every stored message once", async () => {
      const { create, list } = harness()
      const ids = []
      for (let i = 0; i < 3; i++) ids.push((await create(`fixture-${i}`)).id)
      const seen = []
      let after: string | undefined
      for (let i = 0; i < 3; i++) {
        const page = await list({ limit: 1, ...(after === undefined ? {} : { after }) })
        expect(page.data).toHaveLength(1)
        expect(page.has_more).toBe(i < 2)
        const id = page.data[0]?.id
        if (!id) throw new Error("missing email id")
        seen.push(id)
        after = id
      }
      expect(seen).toEqual([...ids].reverse())
      const middle = ids[1]
      if (!middle) throw new Error("missing middle fixture")
      expect((await list({ limit: 1, before: middle })).data[0]?.id).toBe(ids[2])
    })

    test("empty results return 200 with an empty data envelope", async () => {
      const { list } = harness()
      expect(await list()).toEqual({ object: "list", has_more: false, data: [] })
    })

    test("listed metadata refers to the same detail resource without exposing content", async () => {
      const { create, call, list } = harness()
      const { id } = await create("fixture detail")
      const row = (await list()).data[0]
      expect(row).toMatchObject({ id, subject: "fixture detail" })
      expect(row?.html).toBeUndefined()
      expect(row?.text).toBeUndefined()
      const detail = await (await call(`/emails${receiving ? "/receiving" : ""}/${id}`)).json()
      expect(detail).toMatchObject({ id, subject: "fixture detail", text: "synthetic email" })
    })

    test("namespaces, auth, cursor validation and transient failures preserve state", async () => {
      const { create, call, send, list } = harness()
      await create("fixture isolated")
      const path = `/emails${receiving ? "/receiving" : ""}`
      expect((await send(new Request(`http://mock.test${path}`))).status).toBe(401)
      expect(await listResendEmails(send, "http://mock.test/__admin/ns/other", receiving)).toEqual({
        object: "list",
        has_more: false,
        data: [],
      })
      await expect(list({ limit: 101 })).rejects.toThrow("422")
      await expect(list({ after: "invalid" })).rejects.toThrow("422")
      for (const status of [429, 500]) {
        expect(
          (
            await call("/__admin/faults", {
              method: "GET",
              pathPrefix: path,
              status,
              count: 1,
              body: { statusCode: status, name: "fixture_error", message: "synthetic failure" },
            })
          ).status,
        ).toBe(201)
        await expect(list()).rejects.toThrow(String(status))
        expect((await list()).data).toHaveLength(1)
      }
      await call("/__admin/reset", {})
      expect((await list()).data).toEqual([])
    })
  })
}
