import { expect, test } from "bun:test"
import { Buffer } from "node:buffer"
import {
  BlobAccessError,
  BlobError,
  BlobFileTooLargeError,
  BlobNotFoundError,
  BlobPreconditionFailedError,
  BlobServiceRateLimited,
  completeMultipartUpload,
  copy,
  createMultipartUpload,
  del,
  head,
  list,
  put,
  uploadPart,
} from "@vercel/blob"
import { DEFAULT_TOKEN } from "./src/index.js"
import { createServer, type VercelBlobServerOptions } from "./src/server.js"

const setup = async (options: VercelBlobServerOptions = {}) => {
  const server = await createServer(options)
  const oldUrl = process.env.VERCEL_BLOB_API_URL,
    oldRetries = process.env.VERCEL_BLOB_RETRIES
  process.env.VERCEL_BLOB_API_URL = `${server.url}/api/blob`
  process.env.VERCEL_BLOB_RETRIES = "0"
  return {
    server,
    close: async () => {
      if (oldUrl === undefined) delete process.env.VERCEL_BLOB_API_URL
      else process.env.VERCEL_BLOB_API_URL = oldUrl
      if (oldRetries === undefined) delete process.env.VERCEL_BLOB_RETRIES
      else process.env.VERCEL_BLOB_RETRIES = oldRetries
      await server.close()
    },
  }
}
const options = { access: "public" as const, token: DEFAULT_TOKEN, addRandomSuffix: false }
test("unmodified @vercel/blob 2.8.0: put → public binary GET → overwrite → del", async () => {
  const { server, close } = await setup()
  try {
    const bytes = Buffer.from([0, 255, 1, 128, 13, 10])
    const uploaded = await put("fixture/data.bin", Buffer.from(bytes), {
      ...options,
      contentType: "application/x-fixture",
      cacheControlMaxAge: 123,
    })
    expect(uploaded.pathname).toBe("fixture/data.bin")
    expect(uploaded.contentType).toBe("application/x-fixture")
    expect("size" in uploaded).toBe(false)
    const downloaded = await fetch(uploaded.url)
    expect(Array.from(new Uint8Array(await downloaded.arrayBuffer()))).toEqual([...bytes])
    expect(downloaded.headers.get("content-length")).toBe("6")
    expect(downloaded.headers.get("cache-control")).toBe("public, max-age=123")
    expect(downloaded.headers.get("etag")).toBe(uploaded.etag)
    expect((await head(uploaded.url, { token: DEFAULT_TOKEN })).size).toBe(6)
    await expect(put(uploaded.pathname, "duplicate", options)).rejects.toBeInstanceOf(BlobError)
    expect(await (await fetch(uploaded.url)).text()).not.toBe("duplicate")
    const overwritten = await put(uploaded.pathname, "replacement", {
      ...options,
      allowOverwrite: true,
    })
    expect(overwritten.url).toBe(uploaded.url)
    expect(await (await fetch(uploaded.url)).text()).toBe("replacement")
    await del(overwritten.url, { token: DEFAULT_TOKEN })
    expect((await fetch(uploaded.url)).status).toBe(404)
    await del([overwritten.url, overwritten.pathname, "missing.bin"], { token: DEFAULT_TOKEN })
    expect(server.runtime.instance().state.blobs.count()).toBe(0)
  } finally {
    await close()
  }
})
test("official SDK head/list/copy, lexical cursors and conditional writes", async () => {
  const { close } = await setup()
  try {
    const a = await put("file2.txt", "two", options)
    await put("file10.txt", "ten", options)
    await put("folder/child.txt", "child", options)
    const first = await list({ token: DEFAULT_TOKEN, limit: 1 })
    expect(first.blobs.map((b) => b.pathname)).toEqual(["file10.txt"])
    expect(first.hasMore).toBe(true)
    expect(first.blobs[0]?.uploadedAt).toBeInstanceOf(Date)
    const second = await list({ token: DEFAULT_TOKEN, limit: 1, cursor: first.cursor ?? "" })
    expect(second.blobs.map((b) => b.pathname)).toEqual(["file2.txt"])
    const third = await list({ token: DEFAULT_TOKEN, limit: 1, cursor: second.cursor ?? "" })
    expect(third.blobs.map((b) => b.pathname)).toEqual(["folder/child.txt"])
    expect(third.hasMore).toBe(false)
    const folded = await list({ token: DEFAULT_TOKEN, mode: "folded" })
    expect(folded.folders).toEqual(["folder/"])
    const copied = await copy(a.url, "copy.json", {
      ...options,
      ifMatch: a.etag,
      cacheControlMaxAge: 7,
    })
    expect(copied.contentType).toBe("application/json")
    expect(await (await fetch(copied.url)).text()).toBe("two")
    await expect(put(a.pathname, "bad", { ...options, ifMatch: '"wrong"' })).rejects.toBeInstanceOf(
      BlobPreconditionFailedError,
    )
    const updated = await put(a.pathname, "updated", { ...options, ifMatch: a.etag })
    expect(await (await fetch(updated.url)).text()).toBe("updated")
    await expect(head("missing", { token: DEFAULT_TOKEN })).rejects.toBeInstanceOf(
      BlobNotFoundError,
    )
  } finally {
    await close()
  }
})
test("official SDK automatic and manual multipart preserve binary bytes and replay completion", async () => {
  const { server, close } = await setup()
  try {
    const bytes = Buffer.from([0, 1, 2, 255])
    const auto = await put("auto.bin", Buffer.from(bytes), { ...options, multipart: true })
    expect(Array.from(new Uint8Array(await (await fetch(auto.url)).arrayBuffer()))).toEqual([
      ...bytes,
    ])
    const created = await createMultipartUpload("manual.bin", options)
    const part = await uploadPart("manual.bin", Buffer.from(bytes), {
      ...options,
      ...created,
      partNumber: 1,
    })
    expect(part.partNumber).toBe(1)
    expect((await list({ token: DEFAULT_TOKEN })).blobs.map((b) => b.pathname)).not.toContain(
      "manual.bin",
    )
    const completed = await completeMultipartUpload("manual.bin", [part], {
      ...options,
      ...created,
    })
    const replay = await completeMultipartUpload("manual.bin", [part], { ...options, ...created })
    expect(replay).toEqual(completed)
    expect(Array.from(new Uint8Array(await (await fetch(completed.url)).arrayBuffer()))).toEqual([
      ...bytes,
    ])
    expect(server.runtime.instance().state.blobs.count()).toBe(2)
  } finally {
    await close()
  }
})
test("SDK deserializes access, payload and rate-limit errors without retry sleeps", async () => {
  const { server, close } = await setup({ maxBlobBytes: 64 })
  try {
    await expect(
      put("bad.bin", "fixture", { ...options, token: "fixture-invalid" }),
    ).rejects.toBeInstanceOf(BlobAccessError)
    await expect(put("large.bin", Buffer.alloc(65), options)).rejects.toBeInstanceOf(
      BlobFileTooLargeError,
    )
    const preset = await fetch(`${server.url}/__admin/faults/presets/rate_limited`, {
      method: "POST",
    })
    expect(preset.status).toBe(201)
    await expect(put("rate.bin", "fixture", options)).rejects.toBeInstanceOf(BlobServiceRateLimited)
    expect(server.runtime.instance().state.blobs.count()).toBe(0)
  } finally {
    await close()
  }
})
