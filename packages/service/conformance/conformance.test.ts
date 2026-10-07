import { describe, expect, test } from "bun:test"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { STANDARD_ADMIN_ROUTES } from "@crvouga/mockingbird-service"

const servicesRoot = join(import.meta.dir, "..")
const skip = new Set(["core", "sqlite", "postgres", "conformance"])

/** HTTP mocks are the service packages whose public entry exports `createRuntime`. */
const httpMocks = (): string[] =>
  readdirSync(servicesRoot)
    .filter((name) => {
      if (skip.has(name)) return false
      const indexPath = join(servicesRoot, name, "src", "index.ts")
      if (!existsSync(indexPath)) return false
      return /\bcreateRuntime\b/.test(readFileSync(indexPath, "utf8"))
    })
    .sort()

const surface = readFileSync(join(import.meta.dir, "src", "surface.ts"), "utf8")

describe("surface", () => {
  test("every HTTP mock is named in the type proof", () => {
    const missing = httpMocks().filter(
      (name) => !surface.includes(`@crvouga/mockingbird-service-${name}`),
    )
    expect(missing).toEqual([])
  })
})

const call = async (
  runtime: { fetch(request: Request): Promise<Response> },
  method: string,
  path: string,
  body?: unknown,
) =>
  runtime.fetch(
    new Request(`http://mock.local${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        "x-mockingbird-admin-key": "conformance-fixture-admin",
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }),
  )

for (const adminPrefix of ["/__admin", "/_control/mock"])
  test(
    `every HTTP mock serves the shared admin API at ${adminPrefix}`,
    async () => {
      const failures: string[] = []
      for (const name of httpMocks()) {
        const mod = (await import(`../${name}/src/index.ts`)) as {
          createRuntime: (options?: { seed?: number; adminPrefix?: string; adminKey?: string }) => {
            fetch(request: Request): Promise<Response>
            state(namespace?: string): { collections: unknown[] }
            stop?: () => void
          }
        }
        let runtime: ReturnType<typeof mod.createRuntime> | undefined
        try {
          runtime = mod.createRuntime({
            seed: 1,
            adminPrefix,
            adminKey: "conformance-fixture-admin",
          })
          const health = await call(runtime, "GET", `${adminPrefix}/health`)
          if (health.status !== 200) failures.push(`${name}: health ${health.status}`)
          const healthBody = (await health.json()) as { adminUi?: string }
          if (healthBody.adminUi !== `${adminPrefix}/ui`) failures.push(`${name}: health.adminUi`)

          const listed = (
            (await (await call(runtime, "GET", adminPrefix)).json()) as { routes?: string[] }
          ).routes
          for (const route of STANDARD_ADMIN_ROUTES) {
            if (!listed?.includes(route)) failures.push(`${name}: missing ${route}`)
          }

          const ui = await call(runtime, "GET", `${adminPrefix}/ui`)
          const html = await ui.text()
          if (ui.status !== 200 || !html.includes("data-mockingbird-admin")) {
            failures.push(`${name}: admin ui`)
          }

          const created = await call(runtime, "POST", `${adminPrefix}/state/conformance_probe`, {
            id: "probe",
            value: { ok: true },
          })
          if (created.status !== 201) failures.push(`${name}: create ${created.status}`)
          const page = (await (
            await call(runtime, "GET", `${adminPrefix}/state/conformance_probe`)
          ).json()) as { records?: { id: string }[] }
          if (!page.records?.some((row) => row.id === "probe")) failures.push(`${name}: list`)
          const removed = await call(
            runtime,
            "DELETE",
            `${adminPrefix}/state/conformance_probe/probe`,
          )
          if (removed.status !== 200) failures.push(`${name}: delete ${removed.status}`)
          if (!Array.isArray(runtime.state().collections)) failures.push(`${name}: state()`)
        } catch (error) {
          failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`)
        } finally {
          runtime?.stop?.()
        }
      }
      expect(failures).toEqual([])
    },
    { timeout: 180_000 },
  )
