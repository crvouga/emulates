import { describe, expect, test } from "bun:test"
import { addTerminalUrlBoundary } from "./docs-dev.js"

describe("addTerminalUrlBoundary", () => {
  test("separates an Astro JSON URL from the following log entry", () => {
    const input = JSON.stringify({
      message: " astro  v7.3.3 ready in 1410 ms\n┃ Local    http://127.0.0.1:3080/",
      label: "SKIP_FORMAT",
      level: "info",
    })

    const output = JSON.parse(addTerminalUrlBoundary(input)) as { message: string }

    expect(output.message).toBe(
      " astro  v7.3.3 ready in 1410 ms\n┃ Local    http://127.0.0.1:3080/ ",
    )
  })

  test("separates a URL in plain terminal output", () => {
    expect(addTerminalUrlBoundary("┃ Local    http://127.0.0.1:3080/\r")).toBe(
      "┃ Local    http://127.0.0.1:3080/ \r",
    )
  })

  test("leaves URLs with an existing boundary unchanged", () => {
    const input = "Docs: http://127.0.0.1:3080/ ready"
    expect(addTerminalUrlBoundary(input)).toBe(input)
  })
})
