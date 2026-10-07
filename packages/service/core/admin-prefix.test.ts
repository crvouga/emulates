import { expect, test } from "bun:test"
import {
  type AdminRoutes,
  assertAdminPrefixAvailable,
  createRuntime,
  resolveAdminPrefix,
} from "./src/index.js"

const make = (adminPrefix?: string, routes?: AdminRoutes) =>
  createRuntime({
    name: "prefix-probe",
    ...(adminPrefix === undefined ? {} : { adminPrefix }),
    adminKey: "admin-secret",
    presets: {},
    admin: () => routes ?? { "GET /extension": () => Response.json({ extension: true }) },
    create: ({ publicNamespace }) => ({
      fetch: async (request: Request) =>
        Response.json({ vendor: new URL(request.url).pathname, namespace: publicNamespace }),
      reset: async () => {},
    }),
  })
const call = (runtime: ReturnType<typeof make>, path: string, key?: string) =>
  runtime.fetch(
    new Request(`http://mock.local${path}`, {
      ...(key === undefined ? {} : { headers: { "x-mockingbird-admin-key": key } }),
    }),
  )

for (const prefix of ["/__admin", "/_control/mock"]) {
  test(`all internal routes use ${prefix} and vendor paths remain intact`, async () => {
    const runtime = make(prefix)
    {
      const health = await call(runtime, `${prefix}/health`)
      expect(health.status).toBe(200)
      expect(health.headers.get("content-type")).toBe("application/json; charset=utf-8")
      expect(await health.json()).toMatchObject({ adminPrefix: prefix, adminUi: `${prefix}/ui` })
      expect((await call(runtime, `${prefix}/extension`)).status).toBe(401)
      expect(await (await call(runtime, `${prefix}/extension`, "admin-secret")).json()).toEqual({
        extension: true,
      })
      const ui = await call(runtime, `${prefix}/ui`)
      expect(ui.status).toBe(200)
      expect(await ui.text()).toContain(`"adminPrefix":"${prefix}"`)
      expect((await call(runtime, `${prefix}/ui/manifest`)).status).toBe(401)
      expect((await call(runtime, `${prefix}/no-such-route`, "admin-secret")).status).toBe(404)
      expect(
        (await call(runtime, `${prefix}/clock?namespace=invalid!`, "admin-secret")).status,
      ).toBe(400)
      expect((await call(runtime, `${prefix}/state/%ZZ`, "admin-secret")).status).toBe(400)
      for (const path of [
        "/health",
        "/ns/worker/items",
        `${prefix}ister/clock`,
        ...(prefix === "/__admin" ? [] : ["/__admin/clock"]),
      ]) {
        expect(await (await call(runtime, path)).json()).toMatchObject({
          vendor: path,
          namespace: "default",
        })
      }
      const missing = await runtime.fetch(
        new Request(`http://mock.local${prefix}/faults/presets/missing`, {
          method: "POST",
          headers: { "x-mockingbird-admin-key": "admin-secret" },
        }),
      )
      expect(missing.status).toBe(404)
      expect((await missing.json()).error.message).toContain(`GET ${prefix}/faults/presets`)
      const path = `${prefix}/ns/worker/items?namespace=ignored`
      expect(runtime.namespaceOf(new Request(`http://mock.local${path}`))).toBe("worker")
      expect(await (await call(runtime, path)).json()).toMatchObject({
        vendor: "/items",
        namespace: "worker",
      })
    }
  })
}

test("prefix validation and declared vendor collisions fail before serving", () => {
  for (const prefix of [
    "",
    "/",
    "relative",
    "/a/",
    "/a//b",
    "/a/../b",
    "/a?b",
    "/a#b",
    "/a%2fb",
    "/a/:id",
  ]) {
    expect(() => resolveAdminPrefix(prefix)).toThrow()
  }
  for (const path of ["/__admin", "/__admin/health"]) {
    expect(() => assertAdminPrefixAvailable("/__admin", [path])).toThrow("collides")
  }
  expect(() =>
    assertAdminPrefixAvailable("/__admin", [
      "/__administer",
      "/health",
      "/ns/{name}",
      "/{bucket}/{key}",
    ]),
  ).not.toThrow()
  expect(() => make("/")).toThrow()
})

test("extensions cannot replace shared routes or namespace and blob transports", async () => {
  for (const route of ["GET /clock", "GET /health", "GET /ns/:name", "GET /blobs/:key"]) {
    expect(() => make(undefined, { [route]: () => Response.json({ replaced: true }) })).toThrow()
  }
  const runtime = make(undefined, { "GET /:anything": () => Response.json({ replaced: true }) })
  expect(await (await call(runtime, "/__admin/clock", "admin-secret")).json()).not.toHaveProperty(
    "replaced",
  )
})
