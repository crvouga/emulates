import { expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { providerServeValues } from "./src/fixtures.js"

test("provider startup loads fixtures and validates advertised URLs without leaking input", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mockingbird-fixtures-"))
  const file = join(directory, "fixtures.json")
  try {
    await writeFile(file, JSON.stringify({ users: [{ email: "fixture@example.test" }] }))
    expect(
      await providerServeValues({
        fixtures: file,
        "base-url": "https://preview.example.test/mock/google/",
      }),
    ).toEqual({
      fixtures: { users: [{ email: "fixture@example.test" }] },
      baseUrl: "https://preview.example.test/mock/google",
    })
    for (const input of ["null", "[]", "123", '"input must stay private"']) {
      await writeFile(file, input)
      await expect(providerServeValues({ fixtures: file })).rejects.toThrow("JSON object")
    }
    await writeFile(file, '{"input must stay private":')
    await expect(providerServeValues({ fixtures: file })).rejects.toThrow(
      "Cannot read --fixtures as JSON",
    )
    for (const url of [
      "file:///fixture",
      "https://user:pass@example.test",
      "https://example.test?q=1",
      "https://example.test/#fragment",
      "relative",
    ])
      await expect(providerServeValues({ "base-url": url })).rejects.toThrow("--base-url")
    expect(await providerServeValues({})).toEqual({})
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
