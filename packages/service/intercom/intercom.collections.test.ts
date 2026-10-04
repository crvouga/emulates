import { describe, expect, test } from "bun:test"
import { createRuntime } from "./src/index.js"
import { listIntercomCollection } from "./test/consumer.js"

for (const collection of ["contacts", "conversations"] as const) {
  describe(`${collection} collection GET (#${collection === "contacts" ? 253 : 254})`, () => {
    const harness = () => {
      const runtime = createRuntime()
      runtime.clock.freeze()
      const send = (request: Request) => runtime.fetch(request)
      const call = (path: string, body: unknown, method = "POST") =>
        send(
          new Request(`http://mock.test${path}`, {
            method,
            headers: { authorization: "Bearer fixture-key", "content-type": "application/json" },
            body: JSON.stringify(body),
          }),
        )
      const create = async (name: string) => {
        const contact = (await (
          await call("/contacts", { role: "user", external_id: name, name })
        ).json()) as { id: string }
        if (collection === "contacts") return contact
        const response = await call("/conversations", {
          from: { type: "user", id: contact.id },
          body: "synthetic conversation",
        })
        expect(response.status).toBe(200)
        const message = (await response.json()) as { conversation_id: string }
        return { id: message.conversation_id }
      }
      const list = (query: { per_page?: number; starting_after?: string } = {}) =>
        listIntercomCollection(send, "http://mock.test", "fixture-key", collection, query)
      return { runtime, send, call, create, list }
    }

    test("three resources are reachable exactly once across two pages", async () => {
      const { create, list } = harness()
      const ids = []
      for (let i = 0; i < 3; i++) ids.push((await create(`fixture-${i}`)).id)
      const first = await list({ per_page: 2 })
      const firstItems = first.data ?? first.conversations ?? []
      expect(firstItems).toHaveLength(2)
      expect(first.total_count).toBe(3)
      expect(first.pages.next?.starting_after).toBeString()
      const second = await list({ per_page: 2, starting_after: first.pages.next?.starting_after })
      const secondItems = second.data ?? second.conversations ?? []
      expect(secondItems).toHaveLength(1)
      expect(second.pages.next).toBeUndefined()
      expect([...firstItems, ...secondItems].map((row) => row.id).sort()).toEqual(ids.sort())
    })

    test("empty results use the documented envelope and defaults", async () => {
      const { list } = harness()
      const result = await list()
      expect(result.type).toBe(collection === "contacts" ? "list" : "conversation.list")
      expect(result.data ?? result.conversations).toEqual([])
      expect(result.total_count).toBe(0)
      expect(result.pages.per_page).toBe(collection === "contacts" ? 10 : 20)
      expect(result.pages.next).toBeUndefined()
    })

    test("lists the same resource and its current state after mutation", async () => {
      const { create, call, list } = harness()
      const { id } = await create("fixture-updated")
      const patch =
        collection === "contacts" ? { name: "updated fixture" } : { title: "updated fixture" }
      expect((await call(`/${collection}/${id}`, patch, "PUT")).status).toBe(200)
      const page = await list()
      expect((page.data ?? page.conversations)?.[0]).toMatchObject({ id, ...patch })
      if (collection === "conversations")
        expect(page.conversations?.[0]?.conversation_parts).toBeUndefined()
    })

    test("auth, isolation, invalid cursors and transient faults leave state intact", async () => {
      const { create, runtime, send, call, list } = harness()
      await create("fixture-isolated")
      expect((await send(new Request(`http://mock.test/${collection}`))).status).toBe(401)
      const other = await listIntercomCollection(
        send,
        "http://mock.test/ns/other",
        "fixture-key",
        collection,
      )
      expect(other.total_count).toBe(0)
      await expect(list({ starting_after: "invalid" })).rejects.toThrow("400")
      await expect(list({ per_page: 151 })).rejects.toThrow("400")
      for (const [preset, status] of [
        ["rate_limited", 429],
        ["server_error", 500],
      ] as const) {
        expect((await call("/__admin/faults", { preset, count: 1 })).status).toBe(201)
        await expect(list()).rejects.toThrow(String(status))
        expect((await list()).total_count).toBe(1)
      }
      expect((await call("/__admin/reset", {})).status).toBe(200)
      expect((await list()).total_count).toBe(0)
      expect(runtime.state()).toBeDefined()
    })
  })
}
