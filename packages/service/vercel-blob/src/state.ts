import { Collection, IdSequence } from "@emulators/service"
import type { SqliteClient } from "@emulators/sqlite-client"
import { sha256 } from "@noble/hashes/sha2.js"
export const DEFAULT_TOKEN = "vercel_blob_rw_fixture_fixture"
export const DEFAULT_STORE_ID = "fixture"
export const DEFAULT_CACHE_MAX_AGE = 2_592_000
export type BlobFixture = {
  pathname: string
  bytes: readonly number[] | string
  contentType?: string
  cacheControlMaxAge?: number
  storeId?: string
}
export type BlobRecord = {
  id: string
  storeId: string
  pathname: string
  bytes: number[]
  size: number
  contentType: string
  contentDisposition: string
  cacheControl: string
  etag: string
  uploadedAt: string
  url: string
  downloadUrl: string
}
export type Upload = {
  id: string
  storeId: string
  pathname: string
  key: string
  allowOverwrite: boolean
  ifMatch: string | null
  contentType: string
  maxAge: number
  origin: string
  status: "pending" | "complete"
  result?: Omit<BlobRecord, "bytes">
  completedParts?: { partNumber: number; etag: string }[]
}
export type UploadPart = { uploadId: string; partNumber: number; bytes: number[]; etag: string }
export type DownloadGrant = { id: string; blobId: string; expiresAt: number }
export const etagOf = (bytes: Uint8Array): string =>
  `"${Array.from(sha256(bytes), (b) => b.toString(16).padStart(2, "0")).join("")}"`
const mime: Record<string, string> = {
  avif: "image/avif",
  css: "text/css",
  csv: "text/csv",
  gif: "image/gif",
  gz: "application/gzip",
  html: "text/html",
  ico: "image/x-icon",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  js: "text/javascript",
  json: "application/json",
  md: "text/markdown",
  mp3: "audio/mpeg",
  mp4: "video/mp4",
  pdf: "application/pdf",
  png: "image/png",
  svg: "image/svg+xml",
  txt: "text/plain",
  wasm: "application/wasm",
  webm: "video/webm",
  webp: "image/webp",
  woff: "font/woff",
  woff2: "font/woff2",
  xml: "application/xml",
  zip: "application/zip",
}
export const inferContentType = (pathname: string): string =>
  mime[pathname.split(".").pop()?.toLowerCase() ?? ""] ?? "application/octet-stream"
export class VercelBlobState {
  readonly blobs: Collection<BlobRecord>
  readonly uploads: Collection<Upload>
  readonly parts: Collection<UploadPart>
  readonly grants: Collection<DownloadGrant>
  readonly settings: Collection<{ origin: string | null; initialized: boolean }>
  readonly ids: IdSequence
  constructor(
    readonly sqlite: SqliteClient,
    readonly namespace: string,
  ) {
    this.blobs = new Collection(sqlite, namespace, "blobs")
    this.uploads = new Collection(sqlite, namespace, "uploads")
    this.parts = new Collection(sqlite, namespace, "upload_parts")
    this.grants = new Collection(sqlite, namespace, "download_grants")
    this.settings = new Collection(sqlite, namespace, "settings")
    this.ids = new IdSequence(sqlite, namespace)
  }
  find(storeId: string, pathname: string): BlobRecord | undefined {
    return this.blobs
      .list()
      .find((r) => r.value.storeId === storeId && r.value.pathname === pathname)?.value
  }
}
