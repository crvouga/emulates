import { expect, test } from "bun:test"
import { listOperations, type OpenAPIDocument } from "@crvouga/mockingbird-openapi"
import { operationMetadata } from "@crvouga/mockingbird-openapi-metadata"
import coverage from "../coverage.json" with { type: "json" }
import { nativeProviders } from "./targets.js"

const signature = (path: string) =>
  path.replace(/\{[^}]*\}|:[\w]+(?:\{[^}]*\})?/g, "#").replace(/\/$/, "")
// Hosted checkout URLs are emulator tooling; native Stripe provides its own tested checkout.
const aliases: Record<string, string> = {
  "GET /checkout/:id": "GET /c/pay/{session}",
  "POST /checkout/:id/complete": "POST /c/pay/{session}",
}
for (const name of nativeProviders) {
  test(`${name}: native catalog covers every pinned vendor route`, async () => {
    const module = (await import(`../../../service/${name}/src/index.ts`)) as {
      document: OpenAPIDocument
    }
    const native = new Set(
      listOperations(module.document)
        .filter((row) => operationMetadata(row.operation).supported)
        .map((row) => `${row.method.toUpperCase()} ${signature(row.path)}`),
    )
    const missing = coverage.services[name].routes.filter((route) => {
      const [method, path] = route.split(" ")
      if (!method || !path || path === "/" || path.startsWith("/_emulate")) return false
      const mapped = aliases[route] ?? route
      const separator = mapped.indexOf(" ")
      return !native.has(`${mapped.slice(0, separator)} ${signature(mapped.slice(separator + 1))}`)
    })
    expect(missing).toEqual([])
  })
}
