import { describe, expect, test } from "bun:test"
import { createClock } from "@emulators/service"
import Stripe from "stripe"
import { createRuntime } from "./src/index.js"

const SECRET = "whsec_clock"
const START = Date.UTC(2026, 0, 1)

/** A frozen mock clock, so nothing but the test moves time. */
const frozenClock = () => {
  const clock = createClock(() => START)
  clock.freeze()
  return clock
}

const createCustomer = (runtime: ReturnType<typeof createRuntime>) =>
  runtime.fetch(
    new Request("http://stripe.test/v1/customers", {
      method: "POST",
      headers: {
        authorization: "Bearer sk_test_clock",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: "email=jane@example.com",
    }),
  )

const signedAt = (request: Request | undefined) =>
  Number(/t=(\d+)/.exec(request?.headers.get("stripe-signature") ?? "")?.[1])

const harness = (respond: () => Response, webhooks: Record<string, unknown> = {}) => {
  const clock = frozenClock()
  const delivered: Request[] = []
  const runtime = createRuntime({
    clock,
    webhooks: {
      endpoints: [{ url: "http://app.test/webhooks/stripe", secret: SECRET }],
      fetch: async (request) => {
        delivered.push(request)
        return respond()
      },
      ...webhooks,
    },
  })
  return { clock, delivered, runtime }
}

describe("webhook delivery on an injected clock", () => {
  test("Stripe-Signature t is the injected clock's time, so stripe-node verifies it at that time", async () => {
    const { clock, delivered, runtime } = harness(() => new Response("ok"))
    await createCustomer(runtime)
    await runtime.webhooks.idle()
    const request = delivered[0]
    expect(signedAt(request)).toBe(START / 1000)
    // stripe-node's documented way to verify on virtual time: `receivedAt` (ms).
    const event = await Stripe.webhooks.constructEventAsync(
      (await request?.text()) ?? "",
      request?.headers.get("stripe-signature") ?? "",
      SECRET,
      300,
      undefined,
      clock.now(),
    )
    expect(event.type).toBe("customer.created")
    expect(event.created).toBe(START / 1000)
  })

  test("retries wait on the injected clock, not the wall clock", async () => {
    let status = 500
    const { clock, delivered, runtime } = harness(() => new Response("later", { status }), {
      retryDelaysMs: [0, 5_000],
    })
    await createCustomer(runtime)
    await runtime.webhooks.idle()
    expect(delivered).toHaveLength(1)

    // Not due on the mock clock: nothing is sent, however long the test takes.
    runtime.tick()
    await Bun.sleep(20)
    await runtime.webhooks.idle()
    expect(delivered).toHaveLength(1)

    status = 200
    clock.advance(4_999)
    runtime.tick()
    await runtime.webhooks.idle()
    expect(delivered).toHaveLength(1)

    clock.advance(1)
    runtime.tick()
    await runtime.webhooks.idle()
    expect(delivered).toHaveLength(2)
    expect(signedAt(delivered[1])).toBe((START + 5_000) / 1000)
    expect(runtime.webhooks.deliveries()[0]?.state).toBe("delivered")
  })

  test("advancing the runtime's own clock fires due retries", async () => {
    let status = 500
    const { delivered, runtime } = harness(() => new Response("later", { status }), {
      retryDelaysMs: [0, 60_000],
    })
    await createCustomer(runtime)
    await runtime.webhooks.idle()
    status = 200
    runtime.clock.advance(60_000)
    await runtime.webhooks.idle()
    expect(delivered).toHaveLength(2)
    expect(runtime.webhooks.deliveries()[0]?.state).toBe("delivered")
  })

  test("webhooks.now, schedule, cancel and id override the hub's sources", async () => {
    const scheduled: { delayMs: number }[] = []
    const cancelled: unknown[] = []
    const { delivered, runtime } = harness(() => new Response("ok"), {
      now: () => Date.UTC(2030, 5, 1),
      schedule: (_callback: () => void, delayMs: number) => {
        const handle = { delayMs }
        scheduled.push(handle)
        return handle
      },
      cancel: (handle: unknown) => cancelled.push(handle),
      id: (prefix: string) => `${prefix}fixed`,
    })
    await createCustomer(runtime)
    await runtime.webhooks.idle()
    expect(signedAt(delivered[0])).toBe(Date.UTC(2030, 5, 1) / 1000)
    expect(scheduled).toEqual([{ delayMs: 15_000 }])
    expect(cancelled).toEqual(scheduled)
    expect(runtime.webhooks.deliveries()[0]?.id).toBe("dlv_fixed")
  })

  test("without an injected clock the signature stays on the wall clock", async () => {
    const delivered: Request[] = []
    const runtime = createRuntime({
      webhooks: {
        endpoints: [{ url: "http://app.test/webhooks/stripe", secret: SECRET }],
        fetch: async (request) => {
          delivered.push(request)
          return new Response("ok")
        },
      },
    })
    runtime.clock.advance(400 * 86_400_000)
    await createCustomer(runtime)
    await runtime.webhooks.idle()
    expect(Math.abs(signedAt(delivered[0]) - Date.now() / 1000)).toBeLessThan(60)
  })
})
