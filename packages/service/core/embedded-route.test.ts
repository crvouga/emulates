import { expect, test } from "bun:test"
import { listOperations, type OpenAPIDocument } from "@crvouga/mockingbird-openapi"
import { bootSqlite, createService } from "./src/index.js"
import { operationPath } from "./src/path.js"

test("OpenAPI embedded parameters preserve literal action and filename suffixes and decode IDs once", async () => {
  const paths: NonNullable<OpenAPIDocument["paths"]> = {}
  const document: OpenAPIDocument = {
    openapi: "3.1.0",
    info: { title: "embedded routes", version: "1" },
    paths,
  }
  const handlers: Record<string, (c: { params: Record<string, string> }) => Response> = {}
  const routes = [
    ["/properties/{id}:runReport", "run"],
    ["/properties/{id}:batchRunReports", "batch"],
    ["/files/{id}.json", "file"],
    ["/pairs/prefix-{left}-{right}:read", "pair"],
  ] as const
  for (const [path, id] of routes) {
    paths[path] = { post: { operationId: id, responses: { "200": { description: "ok" } } } }
    handlers[id] = (c) => Response.json({ operation: id, ...c.params })
  }
  const matchers = listOperations(document).map((operation) => ({
    id: operation.operationId,
    pattern: operationPath(operation).pattern,
  }))
  expect(
    matchers
      .filter(({ pattern }) => pattern.test("/properties/123:batchRunReports"))
      .map(({ id }) => id),
  ).toEqual(["batch"])
  expect(
    matchers.filter(({ pattern }) => pattern.test("/pairs/prefix-a-b:read")).map(({ id }) => id),
  ).toEqual(["pair"])
  expect(matchers.some(({ pattern }) => pattern.test("/files/name.xml"))).toBe(false)
  const service = createService({
    document,
    handlers,
    sqlite: bootSqlite(),
    namespace: "embedded",
    notFound: () => new Response(null, { status: 404 }),
    onError: () => new Response(null, { status: 500 }),
  })
  for (const [path, expected] of [
    ["/properties/123:runReport", { operation: "run", id: "123" }],
    ["/properties/123:batchRunReports", { operation: "batch", id: "123" }],
    ["/files/a%3Ab%2Fc.json", { operation: "file", id: "a:b/c" }],
    ["/pairs/prefix-a-b:read", { operation: "pair", left: "a", right: "b" }],
  ] as const) {
    expect(
      await (
        await service.fetch(new Request(`http://mock.local${path}`, { method: "POST" }))
      ).json(),
    ).toEqual(expected)
  }
  for (const path of ["/properties/123:unknown", "/files/name.xml", "/pairs/a-b:read"])
    expect(
      (await service.fetch(new Request(`http://mock.local${path}`, { method: "POST" }))).status,
    ).toBe(404)
})
