import { readFile } from "node:fs/promises"
import type { CliOption, CliValues, CommonServeOptions } from "./cli.js"

export const providerServeOptions: Record<string, CliOption> = {
  fixtures: {
    type: "string",
    value: "<json-file>",
    description: "Load synthetic provider fixtures from a JSON object",
  },
  "base-url": {
    type: "string",
    value: "<url>",
    description: "Public HTTP(S) base URL advertised in provider responses",
  },
}

/** Node-only input loading. Contents and parse errors never enter startup logs. */
export async function providerServeValues<T>(
  values: CliValues,
  defaults: Pick<CommonServeOptions, "fixtures" | "baseUrl"> = {},
): Promise<{ fixtures?: T; baseUrl?: string }> {
  const options: { fixtures?: T; baseUrl?: string } = {}
  if (values.fixtures !== undefined) {
    if (typeof values.fixtures !== "string") throw new Error("--fixtures requires a JSON file")
    let parsed: unknown
    try {
      parsed = JSON.parse(await readFile(values.fixtures, "utf8"))
    } catch {
      throw new Error("Cannot read --fixtures as JSON; supply a synthetic provider fixture object")
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error("--fixtures must contain a JSON object")
    options.fixtures = parsed as T
  } else if (defaults.fixtures !== undefined) {
    if (
      defaults.fixtures === null ||
      typeof defaults.fixtures !== "object" ||
      Array.isArray(defaults.fixtures)
    )
      throw new Error("fleet fixtures must contain a JSON object")
    options.fixtures = defaults.fixtures as T
  }
  const advertised = values["base-url"] ?? defaults.baseUrl
  if (advertised !== undefined) {
    let url: URL
    try {
      if (typeof advertised !== "string") throw new Error()
      url = new URL(advertised)
    } catch {
      throw new Error("--base-url must be an absolute HTTP(S) URL")
    }
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error("--base-url must be HTTP(S) without credentials, query or fragment")
    options.baseUrl = url.href.replace(/\/+$/, "")
  }
  return options
}
