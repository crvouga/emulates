import { describe, expect, test } from "bun:test"
import { createRuntime } from "./src/index.js"

type Referral = {
  id: number
  email: string
  uid: string
  state: string
  customer_since: string | null
  promoter_campaign: { promoter_id: number }
}
const harness = () => {
  const runtime = createRuntime({ settings: { autoConvert: false } })
  runtime.clock.freeze()
  runtime.clock.set(Date.parse("2026-10-04T12:00:00Z"))
  const send = (
    path: string,
    body?: unknown,
    method = body === undefined ? "GET" : "POST",
    namespace = "default",
    auth = true,
  ) =>
    runtime.fetch(
      new Request(`http://firstpromoter.test${path}`, {
        method,
        headers: {
          "content-type": "application/json",
          "x-emulators-namespace": namespace,
          ...(auth ? { authorization: "Bearer fixture", "account-id": "fixture" } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    )
  const json = async (path: string, body?: unknown) => {
    const response = await send(path, body)
    expect(response.status).toBe(200)
    return response.json()
  }
  const seed = async () => {
    const promoter = (await json("/v2/company/promoters", { email: "promoter@example.test" })) as {
      id: number
    }
    const referrals: Referral[] = []
    for (let i = 0; i < 5; i++) {
      runtime.clock.advance(1000)
      referrals.push(
        (await json("/v2/track/signup", {
          email: `fixture-${i}@example.test`,
          uid: `user-${i}`,
          promoter_id: promoter.id,
        })) as Referral,
      )
    }
    return { promoter, referrals }
  }
  return { runtime, send, json, seed }
}

describe("FirstPromoter referral reconciliation", () => {
  test("tracked signups filter by uid/email and terminate deterministic numeric pages", async () => {
    const { json, seed } = harness()
    const { referrals, promoter } = await seed()
    expect(
      ((await json("/v2/company/referrals?q=USER-2")) as Referral[]).map((row) => row.id),
    ).toEqual([(referrals[2] as Referral).id])
    expect(
      ((await json("/v2/company/referrals?q=fixture-3%40example.test")) as Referral[]).map(
        (row) => row.id,
      ),
    ).toEqual([(referrals[3] as Referral).id])
    const ids: number[] = []
    for (let page = 1; page <= 4; page++) {
      const rows = (await json(
        `/v2/company/referrals?page=${page}&per_page=2&filters[promoter_id]=${promoter.id}`,
      )) as Referral[]
      if (rows.length === 0) break
      ids.push(...rows.map((row) => row.id))
    }
    expect(new Set(ids)).toEqual(new Set(referrals.map((row) => row.id)))
    expect(ids).toHaveLength(5)
    const selected = (await json(
      `/v2/company/referrals?ids[]=${(referrals[1] as Referral).id}&ids[]=${(referrals[3] as Referral).id}`,
    )) as Referral[]
    expect(new Set(selected.map((row) => row.id))).toEqual(
      new Set([(referrals[1] as Referral).id, (referrals[3] as Referral).id]),
    )
  })

  test("numeric detail matches listing and conversion changes the shared referral filters", async () => {
    const { runtime, json, seed } = harness()
    const { referrals } = await seed()
    const listed = (await json(`/v2/company/referrals?q=user-0`)) as Referral[]
    expect(await json(`/v2/company/referrals/${(referrals[0] as Referral).id}`)).toEqual(listed[0])
    expect(await json(`/v2/company/referrals/user-0?find_by=uid`)).toEqual(listed[0])
    expect(
      await json(
        `/v2/company/referrals/${encodeURIComponent(referrals[0]?.email ?? "")}?find_by=email`,
      ),
    ).toEqual(listed[0])
    runtime.instance("default").convert((referrals[0] as Referral).id as number)
    const customers = (await json(
      "/v2/company/referrals?filters[type]=customer&filters[state]=active",
    )) as Referral[]
    expect(customers.map((row) => row.id)).toEqual([(referrals[0] as Referral).id])
    expect(customers[0]?.customer_since).toBe("2026-10-04T12:00:05.000Z")
    expect((await json("/v2/company/referrals?filters[type]=lead")) as Referral[]).toHaveLength(4)
    expect(
      (await json("/v2/company/referrals?filters[created_at][from]=2026-10-05")) as Referral[],
    ).toEqual([])
  })

  test("unknown searches and exhausted pages are arrays; unknown detail is an error", async () => {
    const { json, send } = harness()
    expect(await json("/v2/company/referrals?q=missing")).toEqual([])
    expect(await json("/v2/company/referrals?page=9&per_page=2")).toEqual([])
    const missing = await send("/v2/company/referrals/999999")
    expect(missing.status).toBe(404)
    expect(await missing.json()).toMatchObject({ message: "Referral not found" })
  })

  test("authentication, namespace reset, snapshot restore and faults preserve referrals", async () => {
    const { runtime, json, send, seed } = harness()
    const { referrals } = await seed()
    const path = `/v2/company/referrals/${(referrals[0] as Referral).id}`
    expect((await send(path, undefined, "GET", "default", false)).status).toBe(401)
    for (const [preset, status] of [
      ["rate_limited", 429],
      ["server_error", 500],
    ] as const) {
      runtime.applyPreset(preset, "default", { count: 1 })
      expect((await send(path)).status).toBe(status)
    }
    const before = await json(path)
    const snapshotResponse = await send("/__admin/snapshots", {})
    expect(snapshotResponse.status).toBe(201)
    const snapshot = (await snapshotResponse.json()) as { id: string }
    runtime.instance("default").convert((referrals[0] as Referral).id as number)
    await json(`/__admin/snapshots/${snapshot.id}/restore`, {})
    expect(await json(path)).toEqual(before)
    expect(await (await send("/v2/company/referrals", undefined, "GET", "other")).json()).toEqual(
      [],
    )
    await json("/__admin/reset", {})
    expect(await json("/v2/company/referrals")).toEqual([])
  })
})
