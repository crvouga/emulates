import type { FetchAPI } from "@emulates/core"
import {
  type APIOptions,
  annotateResponse,
  bearerToken,
  bootSqlite,
  createService,
  defineOperations,
  faultEffect,
  type OperationContext,
  type Service,
} from "@emulates/service"
import type { SqliteClient } from "@emulates/sqlite-client"
import { document, type SupportedOperationId } from "./generated/openapi.js"
import {
  type BlobFixture,
  type BlobRecord,
  DEFAULT_CACHE_MAX_AGE,
  DEFAULT_STORE_ID,
  DEFAULT_TOKEN,
  etagOf,
  inferContentType,
  type Upload,
  VercelBlobState,
} from "./state.js"

export { document, supportedOperationIds } from "./generated/openapi.js"
export type { BlobFixture, BlobRecord, DownloadGrant, Upload, UploadPart } from "./state.js"
export { DEFAULT_CACHE_MAX_AGE, DEFAULT_STORE_ID, DEFAULT_TOKEN } from "./state.js"
export const VERCEL_BLOB_NAMESPACE = "vercel-blob"
export type VercelBlobAPIOptions = APIOptions & {
  fixtures?: readonly BlobFixture[]
  tokens?: Readonly<Record<string, string>>
  publicOrigin?: string
  publicNamespace?: string
  adminPrefix?: string
  maxBlobBytes?: number
}
const error = (status: number, code: string, message: string): Response =>
  Response.json({ error: { code, message } }, { status })
class Rejection extends Error {
  constructor(readonly response: Response) {
    super("Blob request rejected")
  }
}
const reject = (status: number, code: string, message: string): never => {
  throw new Rejection(error(status, code, message))
}
function missing(): never {
  return reject(404, "not_found", "The requested blob does not exist")
}
function bad(message: string): never {
  return reject(400, "bad_request", message)
}
function forbidden(): never {
  return reject(403, "forbidden", "Access denied")
}
const quote = (etag: string): string => (etag.startsWith('"') ? etag : `"${etag}"`)
export class VercelBlobAPI implements FetchAPI {
  readonly sqlite: SqliteClient
  readonly state: VercelBlobState
  readonly app: Service["app"]
  private readonly service: Service
  private readonly now: () => number
  private readonly tokens: Readonly<Record<string, string>>
  private readonly fixtures: readonly BlobFixture[]
  private readonly namespace: string
  private readonly prefix: string
  private readonly maxBytes: number
  private readonly initialOrigin: string | null
  private readonly bodies = new WeakMap<Request, Uint8Array>()
  constructor(options: VercelBlobAPIOptions = {}) {
    this.sqlite = options.sqlite ?? bootSqlite()
    this.now = options.now ?? Date.now
    this.namespace = options.publicNamespace ?? options.namespace ?? "default"
    this.prefix = options.adminPrefix ?? "/__admin"
    this.tokens = { ...(options.tokens ?? { [DEFAULT_TOKEN]: DEFAULT_STORE_ID }) }
    this.fixtures = structuredClone(options.fixtures ?? [])
    this.maxBytes = options.maxBlobBytes ?? 20 * 1024 * 1024
    if (!Number.isSafeInteger(this.maxBytes) || this.maxBytes <= 0)
      throw new Error("maxBlobBytes must be a positive integer")
    this.initialOrigin = options.publicOrigin ? new URL(options.publicOrigin).origin : null
    this.state = new VercelBlobState(this.sqlite, options.namespace ?? VERCEL_BLOB_NAMESPACE)
    this.ensureSeeded()
    const wrap =
      (fn: (c: OperationContext) => Response): ((c: OperationContext) => Response) =>
      (c) => {
        try {
          return fn(c)
        } catch (e) {
          if (e instanceof Rejection) return e.response
          throw e
        }
      }
    this.service = createService({
      document,
      sqlite: this.sqlite,
      namespace: options.namespace ?? VERCEL_BLOB_NAMESPACE,
      now: this.now,
      handlers: defineOperations<SupportedOperationId>({
        PutBlob: wrap((c) => this.put(c)),
        CopyBlob: wrap((c) => this.copy(c)),
        ReadBlobStore: wrap((c) => this.read(c)),
        DeleteBlobs: wrap((c) => this.del(c)),
        MultipartUpload: wrap((c) => this.multipart(c)),
        DownloadBlob: wrap((c) => this.download(c)),
        HeadDownload: wrap((c) => this.download(c)),
      }),
      before: (c) => {
        try {
          if (
            c.operation.operationId !== "DownloadBlob" &&
            c.operation.operationId !== "HeadDownload"
          )
            this.authenticate(c.request)
          return undefined
        } catch (e) {
          if (e instanceof Rejection) return e.response
          throw e
        }
      },
      notFound: () => error(404, "not_found", "The requested blob does not exist"),
      onError: (e) =>
        e instanceof Rejection ? e.response : error(400, "bad_request", "Invalid request body"),
    })
    this.app = this.service.app
  }
  async fetch(request: Request): Promise<Response> {
    // Keep the original Request identity: the shared fault engine associates effects with it.
    if (
      (request.method === "PUT" && new URL(request.url).pathname === "/api/blob/") ||
      (request.method === "POST" && request.headers.get("x-mpu-action") === "upload")
    ) {
      try {
        this.authenticate(request)
      } catch (e) {
        if (e instanceof Rejection) return e.response
        throw e
      }
      const reader = request.clone().body?.getReader()
      let size = 0
      const chunks: Uint8Array[] = []
      if (reader) {
        while (true) {
          const next = await reader.read()
          if (next.done) break
          size += next.value.length
          if (size > this.maxBytes) {
            await Promise.all([reader.cancel(), request.body?.cancel()])
            return error(
              413,
              "file_too_large",
              `the file length cannot be greater than ${this.maxBytes} bytes`,
            )
          }
          chunks.push(next.value)
        }
      }
      const bytes = new Uint8Array(size)
      let offset = 0
      for (const chunk of chunks) {
        bytes.set(chunk, offset)
        offset += chunk.length
      }
      this.bodies.set(request, bytes)
    }
    return this.service.fetch(request)
  }
  async reset(): Promise<void> {
    await this.service.reset()
    this.ensureSeeded()
  }
  ensureSeeded(): void {
    if (this.state.settings.has("current")) return
    this.sqlite.transaction(() => {
      this.state.settings.insert("current", { initialized: true, origin: this.initialOrigin })
      for (const f of this.fixtures) this.seed(f)
    })
  }
  seed(fixture: BlobFixture): BlobRecord {
    if (
      !fixture ||
      typeof fixture.pathname !== "string" ||
      !(typeof fixture.bytes === "string" || Array.isArray(fixture.bytes))
    )
      throw new Error("pathname and bytes are required")
    const bytes =
      typeof fixture.bytes === "string"
        ? new TextEncoder().encode(fixture.bytes)
        : new Uint8Array(fixture.bytes)
    if (
      Array.isArray(fixture.bytes) &&
      fixture.bytes.some((v) => !Number.isInteger(v) || v < 0 || v > 255)
    )
      throw new Error("bytes must be unsigned bytes")
    const pathname = this.path(fixture.pathname)
    this.checkSize(bytes)
    return this.save({
      pathname,
      storeId: fixture.storeId ?? DEFAULT_STORE_ID,
      bytes,
      contentType: fixture.contentType ?? inferContentType(pathname),
      maxAge: fixture.cacheControlMaxAge ?? DEFAULT_CACHE_MAX_AGE,
      origin: this.state.settings.get("current")?.origin ?? "http://mock.local",
      overwrite: true,
      ifMatch: null,
    })
  }
  private authenticate(request: Request): string {
    const token = bearerToken(request)
    const store = token && Object.hasOwn(this.tokens, token) ? this.tokens[token] : undefined
    if (!store) forbidden()
    return store
  }
  private path(pathname: string | null): string {
    if (!pathname) bad("pathname is required")
    if (pathname.includes("//")) bad("pathname cannot contain //")
    if (pathname.length > 950) bad("pathname is too long, maximum length is 950")
    return pathname
  }
  private checkSize(bytes: Uint8Array): void {
    if (bytes.length > this.maxBytes)
      reject(413, "file_too_large", `the file length cannot be greater than ${this.maxBytes} bytes`)
  }
  private origin(c: OperationContext): string {
    return this.state.settings.get("current")?.origin ?? c.url.origin
  }
  private suffix(pathname: string): string {
    const value = this.state.ids.next("", 8)
    const dot = pathname.lastIndexOf(".")
    return dot > pathname.lastIndexOf("/") + 1
      ? `${pathname.slice(0, dot)}-${value}${pathname.slice(dot)}`
      : `${pathname}-${value}`
  }
  private options(
    c: OperationContext,
    storeId: string,
  ): {
    pathname: string
    storeId: string
    contentType: string
    maxAge: number
    origin: string
    overwrite: boolean
    ifMatch: string | null
  } {
    const h = c.request.headers
    if (h.get("x-vercel-blob-access") !== "public")
      bad("Only access: public is supported by this emulator")
    let pathname = this.path(c.url.searchParams.get("pathname"))
    if (h.get("x-add-random-suffix") === "1") pathname = this.suffix(pathname)
    const maxAge = h.has("x-cache-control-max-age")
      ? Number(h.get("x-cache-control-max-age"))
      : DEFAULT_CACHE_MAX_AGE
    if (!Number.isSafeInteger(maxAge) || maxAge < 0) bad("Invalid cacheControlMaxAge")
    const contentType = h.get("x-content-type") || inferContentType(pathname)
    if (/[\r\n]/.test(contentType)) bad("Invalid contentType")
    return {
      pathname,
      storeId,
      contentType,
      maxAge,
      origin: this.origin(c),
      overwrite: h.get("x-allow-overwrite") === "1",
      ifMatch: h.get("x-if-match"),
    }
  }
  private checkWrite(
    storeId: string,
    pathname: string,
    overwrite: boolean,
    ifMatch: string | null,
  ): BlobRecord | undefined {
    const existing = this.state.find(storeId, pathname)
    if (ifMatch) {
      if (!existing || existing.etag !== quote(ifMatch))
        reject(412, "precondition_failed", "Precondition failed: ETag mismatch.")
    } else if (existing && !overwrite)
      bad("This blob already exists, use allowOverwrite: true to overwrite it")
    return existing
  }
  private save(input: {
    pathname: string
    storeId: string
    bytes: Uint8Array
    contentType: string
    maxAge: number
    origin: string
    overwrite: boolean
    ifMatch: string | null
  }): BlobRecord {
    this.checkSize(input.bytes)
    return this.sqlite.transaction(() => {
      const existing = this.checkWrite(
        input.storeId,
        input.pathname,
        input.overwrite,
        input.ifMatch,
      )
      const id = existing?.id ?? this.state.ids.next("blob_", 24)
      const url = new URL(`${this.prefix}/blobs/${id}`, input.origin)
      url.searchParams.set("namespace", this.namespace)
      const download = new URL(url)
      download.searchParams.set("download", "1")
      const name = Array.from(input.pathname.split("/").pop() || input.pathname)
        .filter((character) => {
          const code = character.charCodeAt(0)
          return character !== '"' && code > 31 && code !== 127
        })
        .join("")
      // Header values must be ASCII even when the object key contains Unicode.
      const contentDisposition = `attachment; filename="${name.replace(/[^\x20-\x7e]/g, "_")}"`
      const record: BlobRecord = {
        id,
        storeId: input.storeId,
        pathname: input.pathname,
        bytes: Array.from(input.bytes),
        size: input.bytes.length,
        contentType: input.contentType,
        contentDisposition,
        cacheControl: `public, max-age=${input.maxAge}`,
        etag: etagOf(input.bytes),
        uploadedAt: new Date(this.now()).toISOString(),
        url: url.toString(),
        downloadUrl: download.toString(),
      }
      if (existing) this.state.blobs.update(id, record)
      else this.state.blobs.insert(id, record)
      return record
    })
  }
  private response(blob: Omit<BlobRecord, "bytes">): Response {
    return annotateResponse(Response.json(this.putReply(blob)), { ids: { blob: blob.id } })
  }
  private putReply(b: Omit<BlobRecord, "bytes">): Record<string, unknown> {
    return {
      url: b.url,
      downloadUrl: b.downloadUrl,
      pathname: b.pathname,
      contentType: b.contentType,
      contentDisposition: b.contentDisposition,
      etag: b.etag,
    }
  }
  metadata(b: BlobRecord): Record<string, unknown> {
    return {
      id: b.id,
      storeId: b.storeId,
      ...this.putReply(b),
      size: b.size,
      uploadedAt: b.uploadedAt,
      cacheControl: b.cacheControl,
    }
  }
  private transportFault(c: OperationContext): void {
    if (faultEffect(c.request, "conflict"))
      bad("This blob already exists, use allowOverwrite: true to overwrite it")
    if (faultEffect(c.request, "truncated_upload")) bad("Upload body was truncated")
    if (
      faultEffect(c.request, "partial_multipart") &&
      c.request.headers.get("x-mpu-action") === "upload"
    )
      reject(503, "service_unavailable", "Service unavailable")
  }
  private put(c: OperationContext): Response {
    this.transportFault(c)
    const bytes = this.bodies.get(c.request) ?? new Uint8Array()
    const opts = this.options(c, this.authenticate(c.request))
    return this.response(this.save({ ...opts, bytes }))
  }
  private resolve(ref: string, store: string): BlobRecord | undefined {
    if (!/^https?:\/\//i.test(ref)) return this.state.find(store, ref)
    let url: URL
    try {
      url = new URL(ref)
    } catch {
      return undefined
    }
    if (url.searchParams.get("namespace") !== this.namespace) return undefined
    return this.state.blobs.list().find(({ value: b }) => {
      const expected = new URL(b.url)
      return (
        b.storeId === store && url.origin === expected.origin && url.pathname === expected.pathname
      )
    })?.value
  }
  private copy(c: OperationContext): Response {
    this.transportFault(c)
    const store = this.authenticate(c.request)
    const source = this.resolve(c.url.searchParams.get("fromUrl") ?? "", store)
    if (!source) missing()
    const opts = this.options(c, store)
    // Vercel documents copy's ifMatch against the source object, not its destination.
    if (opts.ifMatch && source.etag !== quote(opts.ifMatch))
      reject(412, "precondition_failed", "Precondition failed: ETag mismatch.")
    return this.response(this.save({ ...opts, ifMatch: null, bytes: new Uint8Array(source.bytes) }))
  }
  private read(c: OperationContext): Response {
    const store = this.authenticate(c.request)
    const ref = c.url.searchParams.get("url")
    if (ref !== null) {
      const b = this.resolve(ref, store)
      if (!b) missing()
      const { id: _id, storeId: _storeId, ...metadata } = this.metadata(b)
      return annotateResponse(Response.json(metadata), { ids: { blob: b.id } })
    }
    const prefix = c.url.searchParams.get("prefix") ?? ""
    const rawLimit = c.url.searchParams.get("limit")
    const limit = rawLimit === null ? 1000 : Number(rawLimit)
    if (!Number.isSafeInteger(limit) || limit < 1) bad("Invalid limit")
    const mode = c.url.searchParams.get("mode") ?? "expanded"
    if (mode !== "expanded" && mode !== "folded") bad("Invalid mode")
    const cursor = c.url.searchParams.get("cursor") ?? ""
    let items = this.state.blobs
      .list()
      .map((r) => r.value)
      .filter((b) => b.storeId === store && b.pathname.startsWith(prefix))
      .sort((a, b) => (a.pathname < b.pathname ? -1 : a.pathname > b.pathname ? 1 : 0))
    const folders = new Set<string>()
    if (mode === "folded")
      items = items.filter((b) => {
        const rest = b.pathname.slice(prefix.length)
        const i = rest.indexOf("/")
        if (i < 0) return true
        folders.add(prefix + rest.slice(0, i + 1))
        return false
      })
    if (cursor) items = items.filter((b) => b.pathname > cursor)
    const page = items.slice(0, limit)
    const hasMore = items.length > limit
    return Response.json({
      blobs: page.map((b) => ({
        url: b.url,
        downloadUrl: b.downloadUrl,
        pathname: b.pathname,
        size: b.size,
        uploadedAt: b.uploadedAt,
        etag: b.etag,
      })),
      hasMore,
      ...(hasMore && page.length ? { cursor: page[page.length - 1]?.pathname } : {}),
      ...(mode === "folded" ? { folders: [...folders].sort() } : {}),
    })
  }
  private del(c: OperationContext): Response {
    const store = this.authenticate(c.request)
    const value = c.body.kind === "json" ? c.body.value : null
    const urls = value && typeof value === "object" && "urls" in value ? value.urls : undefined
    if (!Array.isArray(urls) || urls.some((r) => typeof r !== "string"))
      bad("urls must be an array of strings")
    const rows = urls
      .map((ref: string) => this.resolve(ref, store))
      .filter((b): b is BlobRecord => !!b)
    const ifMatch = c.request.headers.get("x-if-match")
    for (const b of rows)
      if (ifMatch && b.etag !== quote(ifMatch))
        reject(412, "precondition_failed", "Precondition failed: ETag mismatch.")
    this.sqlite.transaction(() => {
      for (const b of rows) this.state.blobs.delete(b.id)
    })
    return Response.json(null)
  }
  private multipart(c: OperationContext): Response {
    this.transportFault(c)
    const store = this.authenticate(c.request)
    const action = c.request.headers.get("x-mpu-action")
    if (action === "create") {
      const opts = this.options(c, store)
      this.checkWrite(store, opts.pathname, opts.overwrite, opts.ifMatch)
      const id = this.state.ids.next("upload_", 24)
      const upload: Upload = {
        id,
        storeId: store,
        pathname: this.path(c.url.searchParams.get("pathname")),
        key: opts.pathname,
        allowOverwrite: opts.overwrite,
        ifMatch: opts.ifMatch,
        contentType: opts.contentType,
        maxAge: opts.maxAge,
        origin: opts.origin,
        status: "pending",
      }
      this.state.uploads.insert(id, upload)
      return annotateResponse(Response.json({ key: upload.key, uploadId: id }), {
        ids: { upload: id },
      })
    }
    const id = c.request.headers.get("x-mpu-upload-id") ?? ""
    const upload = this.state.uploads.get(id)
    let key = ""
    try {
      key = decodeURIComponent(c.request.headers.get("x-mpu-key") ?? "")
    } catch {
      bad("Invalid multipart key")
    }
    if (
      !upload ||
      upload.storeId !== store ||
      upload.key !== key ||
      upload.pathname !== c.url.searchParams.get("pathname")
    )
      missing()
    if (action === "upload") {
      if (upload.status !== "pending") bad("Multipart upload is already complete")
      const partNumber = Number(c.request.headers.get("x-mpu-part-number"))
      if (!Number.isSafeInteger(partNumber) || partNumber < 1 || partNumber > 10000)
        bad("Invalid part number")
      const bytes = this.bodies.get(c.request) ?? new Uint8Array()
      const etag = etagOf(bytes)
      const partId = JSON.stringify([id, partNumber])
      this.state.parts.insert(partId, { uploadId: id, partNumber, bytes: Array.from(bytes), etag })
      return annotateResponse(Response.json({ etag }), { ids: { upload: id } })
    }
    if (action !== "complete") bad("Invalid multipart action")
    const values = c.body.kind === "json" ? c.body.value : null
    if (!Array.isArray(values) || !values.length) bad("Multipart parts are required")
    const ordered = values.map((v: unknown) => {
      if (
        !v ||
        typeof v !== "object" ||
        !("partNumber" in v) ||
        !("etag" in v) ||
        !Number.isSafeInteger(v.partNumber) ||
        typeof v.etag !== "string"
      )
        bad("Invalid multipart part")
      const p = this.state.parts.get(JSON.stringify([id, v.partNumber]))
      if (!p || p.etag !== v.etag) bad("Invalid multipart part ETag")
      return p
    })
    if (ordered.some((p, i) => i > 0 && p.partNumber <= (ordered[i - 1]?.partNumber ?? 0)))
      bad("Multipart parts must be ordered and unique")
    const firstSize = ordered[0]?.bytes.length ?? 0
    if (
      ordered
        .slice(0, -1)
        .some((p) => p.bytes.length < 5 * 1024 * 1024 || p.bytes.length !== firstSize)
    )
      bad("Multipart parts must be at least 5 MiB and equal sized, except the last part")
    const total = ordered.reduce((n, p) => n + p.bytes.length, 0)
    if (total > this.maxBytes)
      reject(413, "file_too_large", `the file length cannot be greater than ${this.maxBytes} bytes`)
    if (upload.status === "complete" && upload.result) {
      if (
        JSON.stringify(upload.completedParts) !==
        JSON.stringify(ordered.map(({ partNumber, etag }) => ({ partNumber, etag })))
      )
        bad("Multipart upload was completed with different parts")
      return this.response(upload.result)
    }
    const bytes = new Uint8Array(total)
    let offset = 0
    for (const p of ordered) {
      bytes.set(p.bytes, offset)
      offset += p.bytes.length
    }
    const record = this.sqlite.transaction(() => {
      const result = this.save({
        storeId: store,
        pathname: upload.key,
        bytes,
        contentType: upload.contentType,
        maxAge: upload.maxAge,
        origin: upload.origin,
        overwrite: upload.allowOverwrite,
        ifMatch: upload.ifMatch,
      })
      const { bytes: _bytes, ...metadata } = result
      this.state.uploads.update(id, {
        ...upload,
        status: "complete",
        result: metadata,
        completedParts: ordered.map(({ partNumber, etag }) => ({ partNumber, etag })),
      })
      return result
    })
    return this.response(record)
  }
  private download(c: OperationContext): Response {
    const blob = this.state.blobs.get(c.params.id ?? "")
    if (!blob) missing()
    const grantId = c.url.searchParams.get("grant")
    if (grantId) {
      const grant = this.state.grants.get(grantId)
      if (!grant || grant.blobId !== blob.id || grant.expiresAt <= this.now()) forbidden()
    }
    const headers = new Headers({
      etag: blob.etag,
      "content-type": blob.contentType,
      "content-length": String(blob.size),
      "cache-control": blob.cacheControl,
    })
    if (c.url.searchParams.get("download") === "1")
      headers.set("content-disposition", blob.contentDisposition)
    if (c.request.headers.get("if-none-match") === blob.etag) {
      headers.delete("content-length")
      return new Response(null, { status: 304, headers })
    }
    return annotateResponse(
      new Response(c.request.method === "HEAD" ? null : new Uint8Array(blob.bytes), { headers }),
      { ids: { blob: blob.id } },
    )
  }
}
export type { VercelBlobRuntime, VercelBlobRuntimeOptions } from "./runtime.js"
export { createRuntime, VERCEL_BLOB_PRESETS } from "./runtime.js"
