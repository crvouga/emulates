import { describe, expect, test } from "bun:test"
import { AccessToken } from "livekit-server-sdk"
import { createRuntime } from "./src/runtime.js"

const key = "fixture"
const secret = "fixture-secret-that-is-at-least-32-chars"
const harness = async () => {
  const runtime = createRuntime({ keys: { [key]: secret } })
  runtime.clock.freeze()
  const token = new AccessToken(key, secret)
  token.addGrant({ roomAdmin: true, roomCreate: true, roomList: true })
  const bearer = await token.toJwt()
  const call = (path: string, body: unknown = {}, auth = bearer) =>
    runtime.fetch(
      new Request(`http://mock${path}`, {
        method: "POST",
        headers: { authorization: `Bearer ${auth}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    )
  const rpc = (method: string, body: unknown = {}, namespace = "") =>
    call(`${namespace}/twirp/livekit.AgentDispatchService/${method}`, body)
  return { runtime, call, rpc }
}
type Dispatch = {
  id: string
  agentName: string
  metadata: string
  state: {
    createdAt: string
    deletedAt: string
    jobs: { state: { startedAt: string; endedAt: string; updatedAt: string; status: string } }[]
  }
}

describe("dispatch control and isolation", () => {
  test("snake-case requests share the SDK state, filters, and mock-clock timestamps", async () => {
    const { runtime, rpc, call } = await harness()
    const created = (await (
      await rpc("CreateDispatch", {
        room: "synthetic-room",
        agent_name: "synthetic-agent",
        metadata: "synthetic",
      })
    ).json()) as Dispatch
    expect(created.agentName).toBe("synthetic-agent")
    expect(created.state.createdAt).toBe(String(Math.floor(runtime.clock.now() / 1000)))
    await rpc("CreateDispatch", { room: "synthetic-room", agentName: "synthetic-second" })
    expect(
      await (await rpc("ListDispatch", { room: "synthetic-room", dispatch_id: created.id })).json(),
    ).toMatchObject({ agentDispatches: [created] })
    runtime.clock.advance(1000)
    expect(
      (await call(`/__admin/dispatches/${created.id}/jobs`, { workerId: "synthetic-worker" }))
        .status,
    ).toBe(200)
    runtime.clock.advance(1000)
    await call(`/__admin/dispatches/${created.id}/jobs`, { status: "JS_SUCCESS" })
    const listed = (await (
      await rpc("ListDispatch", { room: "synthetic-room", dispatchId: created.id })
    ).json()) as { agentDispatches: Dispatch[] }
    const job = listed.agentDispatches[0]?.state.jobs[0]
    expect(job?.state).toMatchObject({
      status: "JS_SUCCESS",
      endedAt: String(Math.floor(runtime.clock.now() / 1000)),
      updatedAt: String(Math.floor(runtime.clock.now() / 1000)),
    })
    expect(job?.state.startedAt).not.toBe(job?.state.endedAt)
    const deleted = (await (
      await rpc("DeleteDispatch", { room: "synthetic-room", dispatch_id: created.id })
    ).json()) as Dispatch
    expect(deleted.state.deletedAt).toBe(String(Math.floor(runtime.clock.now() / 1000)))
    expect(
      (await rpc("DeleteDispatch", { room: "synthetic-room", dispatchId: created.id })).status,
    ).toBe(404)
  })

  test("all dispatch operations enforce signed roomAdmin and room-scoped grants", async () => {
    const { runtime, call } = await harness()
    const wrongRoom = new AccessToken(key, secret)
    wrongRoom.addGrant({ roomAdmin: true, room: "other-room" })
    const insufficient = new AccessToken(key, secret)
    insufficient.addGrant({ roomList: true })
    for (const method of ["CreateDispatch", "ListDispatch", "DeleteDispatch"]) {
      const path = `/twirp/livekit.AgentDispatchService/${method}`
      const body = { room: "synthetic-room", agent_name: "synthetic-agent", dispatch_id: "missing" }
      for (const auth of ["invalid-fixture", await wrongRoom.toJwt(), await insufficient.toJwt()])
        expect((await call(path, body, auth)).status).toBe(401)
      expect(
        (
          await runtime.fetch(
            new Request(`http://mock${path}`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(body),
            }),
          )
        ).status,
      ).toBe(401)
    }
  })

  test("namespaces, fault retries and reset preserve independent room dispatches", async () => {
    const { rpc, call } = await harness()
    const first = (await (
      await rpc("CreateDispatch", { room: "synthetic-room", agentName: "first" })
    ).json()) as Dispatch
    const second = (await (
      await rpc("CreateDispatch", { room: "synthetic-room", agentName: "second" }, "/ns/other")
    ).json()) as Dispatch
    for (const status of [429, 500]) {
      await call("/__admin/faults", {
        method: "POST",
        pathPrefix: "/twirp/livekit.AgentDispatchService/ListDispatch",
        status,
        count: 1,
        body: {
          code: status === 429 ? "resource_exhausted" : "internal",
          msg: "synthetic failure",
          meta: {},
        },
      })
      expect((await rpc("ListDispatch", { room: "synthetic-room" })).status).toBe(status)
      expect(await (await rpc("ListDispatch", { room: "synthetic-room" })).json()).toMatchObject({
        agentDispatches: [first],
      })
    }
    await call("/__admin/reset")
    expect(await (await rpc("ListDispatch", { room: "synthetic-room" })).json()).toEqual({
      agentDispatches: [],
    })
    expect(
      await (await rpc("ListDispatch", { room: "synthetic-room" }, "/ns/other")).json(),
    ).toMatchObject({ agentDispatches: [second] })
    expect((await call(`/__admin/dispatches/${second.id}/jobs`, {})).status).toBe(404)
  })

  test("invalid requests and controls do not create orphan rooms or jobs", async () => {
    const { runtime, rpc, call } = await harness()
    for (const body of [
      null,
      [],
      {},
      { room: "synthetic-room" },
      { room: "synthetic-room", agent_name: false },
      { room: "synthetic-room", agentName: "agent", metadata: 1 },
    ])
      expect((await rpc("CreateDispatch", body)).status).toBe(400)
    expect(runtime.instance("default").state.rooms.count()).toBe(0)
    const created = (await (
      await rpc("CreateDispatch", { room: "synthetic-room", agentName: "agent" })
    ).json()) as Dispatch
    for (const body of [{ status: "invalid" }, { workerId: 1 }, null])
      expect((await call(`/__admin/dispatches/${created.id}/jobs`, body)).status).toBe(400)
    expect(await (await rpc("ListDispatch", { room: "synthetic-room" })).json()).toMatchObject({
      agentDispatches: [created],
    })
  })
})
