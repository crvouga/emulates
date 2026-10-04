import { describe, expect, test } from "bun:test"
import {
  AgentDispatchClient as ReconciliationAgents,
  RoomServiceClient as ReconciliationRooms,
} from "livekit-reconciliation"
import { AgentDispatchClient, RoomServiceClient } from "livekit-server-sdk"
import { createServer } from "./src/server.js"

const key = "fixture"
const secret = "fixture-secret-that-is-at-least-32-chars"
for (const sdk of [
  {
    version: "2.19.1",
    agents: AgentDispatchClient,
    rooms: RoomServiceClient,
  },
  { version: "2.19.0", agents: ReconciliationAgents, rooms: ReconciliationRooms },
]) {
  const withServer = async (
    work: (
      server: Awaited<ReturnType<typeof createServer>>,
      rooms: Pick<RoomServiceClient, "createRoom" | "listRooms" | "deleteRoom">,
      agents: Pick<
        AgentDispatchClient,
        "createDispatch" | "listDispatch" | "getDispatch" | "deleteDispatch"
      >,
    ) => Promise<void>,
  ) => {
    const server = await createServer({ keys: { [key]: secret } })
    const rooms = new sdk.rooms(server.url, key, secret, { failover: false })
    const agents = new sdk.agents(server.url, key, secret, { failover: false })
    try {
      await work(server, rooms, agents)
    } finally {
      await server.close()
    }
  }

  describe(`agent dispatch SDK ${sdk.version} reconciliation (#261)`, () => {
    test("created dispatch metadata and job state are returned through the official SDK", () =>
      withServer(async (_server, rooms, agents) => {
        await rooms.createRoom({ name: "synthetic-room" })
        const created = await agents.createDispatch("synthetic-room", "synthetic-agent", {
          metadata: "synthetic dispatch metadata",
        })
        expect(created.agentName).toBe("synthetic-agent")
        expect(created.room).toBe("synthetic-room")
        expect(created.metadata).toBe("synthetic dispatch metadata")
        expect(created.state?.createdAt).toBeGreaterThan(0n)
        expect(created.state?.jobs).toEqual([])
        expect(
          (await agents.listDispatch("synthetic-room")).map((dispatch) => dispatch.id),
        ).toEqual([created.id])
        expect((await agents.getDispatch(created.id, "synthetic-room"))?.id).toBe(created.id)
        const auto = await agents.createDispatch("synthetic-auto-room", "synthetic-agent")
        expect((await rooms.listRooms()).map((room) => room.name)).toContain(auto.room)
      }))

    test("a room with no dispatches returns an empty SDK list", () =>
      withServer(async (_server, rooms, agents) => {
        await rooms.createRoom({ name: "synthetic-room" })
        expect(await agents.listDispatch("synthetic-room")).toEqual([])
        expect(await agents.getDispatch("missing", "synthetic-room")).toBeUndefined()
      }))

    test("synthetic assignment, snapshot restore and deletion change shared dispatch state", () =>
      withServer(async (server, rooms, agents) => {
        const created = await agents.createDispatch("synthetic-room", "synthetic-agent")
        const snapshot = (await (
          await fetch(`${server.url}/__admin/snapshots`, { method: "POST" })
        ).json()) as { id: string }
        const assigned = await fetch(`${server.url}/__admin/dispatches/${created.id}/jobs`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ status: "JS_RUNNING", workerId: "synthetic-worker" }),
        })
        expect(assigned.status).toBe(200)
        expect((await agents.listDispatch("synthetic-room"))[0]?.state?.jobs).toHaveLength(1)
        await agents.deleteDispatch(created.id, "synthetic-room")
        expect(await agents.listDispatch("synthetic-room")).toEqual([])
        await fetch(`${server.url}/__admin/snapshots/${snapshot.id}/restore`, { method: "POST" })
        expect((await agents.listDispatch("synthetic-room"))[0]?.state?.jobs).toEqual([])
        await rooms.deleteRoom("synthetic-room")
        expect(server.runtime.instance("default").state.dispatches.count()).toBe(0)
      }))
  })
}
