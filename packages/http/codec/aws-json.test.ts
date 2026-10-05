import { expect, test } from "bun:test"
import { decodeBody, encodeBody } from "./src/content.js"

for (const media of ["application/x-amz-json-1.0", "application/x-amz-json-1.1"]) {
  test(`${media} encodes and decodes JSON without treating AWS responses as opaque bytes`, () => {
    const value = { Items: [{ id: "fixture" }] }
    const encoded = encodeBody(media, value)
    expect(encoded.contentType).toBe(media)
    expect(decodeBody(media, new TextEncoder().encode(encoded.body))).toEqual({
      kind: "json",
      value,
    })
    expect(decodeBody(media, new TextEncoder().encode("{")).kind).toBe("invalid")
  })
}
