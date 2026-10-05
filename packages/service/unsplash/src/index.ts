import type { FetchAPI } from "@crvouga/mockingbird-core"
import {
  type APIOptions,
  annotateResponse,
  bootSqlite,
  Collection,
  createService,
  defineOperations,
  jsonRes,
  type OperationContext,
  type Service,
} from "@crvouga/mockingbird-service"
import type { Hono } from "hono"
import { document, type SupportedOperationId } from "./generated/openapi.js"

export type { OperationId, SupportedOperationId } from "./generated/openapi.js"
export { document, operationIds, supportedOperationIds } from "./generated/openapi.js"
export { createRuntime, UNSPLASH_PRESETS } from "./runtime.js"
export const UNSPLASH_NAMESPACE = "unsplash"
export type PhotoFixture = {
  id: string
  queries: string[]
  orientation: "landscape" | "portrait" | "squarish"
  alt_description: string | null
  user: { first_name: string; last_name?: string | null; links: { html: string } }
  imageBase64: string
  contentType: string
}
// A synthetic 1x1 PNG. No third-party image is downloaded or embedded.
export const DEFAULT_PHOTOS: PhotoFixture[] = [
  {
    id: "mock-photo",
    queries: ["mock"],
    orientation: "landscape",
    alt_description: null,
    user: {
      first_name: "Synthetic",
      last_name: null,
      links: { html: "https://example.invalid/photographer" },
    },
    imageBase64:
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=",
    contentType: "image/png",
  },
]
export type UnsplashAPIOptions = APIOptions & {
  accessKeys?: string[]
  photos?: PhotoFixture[]
  publicNamespace?: string
  adminPrefix?: string
}
export const accessKey = (request: Request): string | undefined =>
  request.headers.get("authorization")?.match(/^Client-ID\s+(.+)$/i)?.[1] ??
  new URL(request.url).searchParams.get("client_id") ??
  undefined
const failure = (status: number, message: string) => jsonRes(status, { errors: [message] })
export class UnsplashAPI implements FetchAPI {
  readonly app: Hono
  readonly photos: Collection<PhotoFixture>
  readonly downloads: Collection<{ count: number }>
  private readonly service: Service
  private readonly seeds: PhotoFixture[]
  private readonly initialized: Collection<{ value: boolean }>
  private readonly basePath: string
  private readonly prefix: string
  constructor(options: UnsplashAPIOptions = {}) {
    const sqlite = bootSqlite(options.sqlite),
      namespace = options.namespace ?? UNSPLASH_NAMESPACE
    this.prefix = options.adminPrefix ?? "/__admin"
    const publicNamespace = options.publicNamespace ?? "default"
    this.basePath =
      publicNamespace === "default"
        ? ""
        : `${this.prefix}/ns/${encodeURIComponent(publicNamespace)}`
    this.photos = new Collection(sqlite, namespace, "photos")
    this.downloads = new Collection(sqlite, namespace, "downloads")
    this.initialized = new Collection(sqlite, namespace, "initialized")
    this.seeds = structuredClone(options.photos ?? DEFAULT_PHOTOS)
    this.seed()
    this.service = createService({
      sqlite,
      namespace,
      document,
      now: options.now ?? Date.now,
      notFound: () => failure(404, "Not found"),
      onError: (error) => {
        throw error
      },
      before: (context) => {
        if (context.operation.operationId === "GetImage") return undefined
        const key = accessKey(context.request)
        return key && (options.accessKeys ?? ["mock_unsplash_key"]).includes(key)
          ? undefined
          : failure(401, "OAuth error: The access token is invalid")
      },
      handlers: defineOperations<SupportedOperationId>({
        SearchPhotos: (context) => this.search(context),
        TrackDownload: (context) => {
          const id = context.params.id ?? ""
          if (!this.photos.has(id)) return failure(404, "Photo not found")
          this.downloads.insert(id, { count: (this.downloads.get(id)?.count ?? 0) + 1 })
          const response = jsonRes(200, { url: this.imageUrl(context, id) })
          annotateResponse(response, { ids: { photoId: id } })
          return response
        },
        GetImage: (context) => {
          const photo = this.photos.get(context.params.id ?? "")
          if (!photo) return failure(404, "Photo not found")
          const bytes = Uint8Array.from(atob(photo.imageBase64), (char) => char.charCodeAt(0))
          return new Response(bytes, {
            headers: { "content-type": photo.contentType, "access-control-allow-origin": "*" },
          })
        },
      }),
    })
    this.app = this.service.app
  }
  private seed(): void {
    if (this.initialized.has("seed")) return
    for (const photo of this.seeds) this.photos.insert(photo.id, photo)
    this.initialized.insert("seed", { value: true })
  }
  fetch(request: Request): Promise<Response> {
    return this.service.fetch(request)
  }
  async reset(): Promise<void> {
    await this.service.reset()
    this.seed()
  }
  private imageUrl(context: OperationContext, id: string): string {
    return `${context.url.origin}${this.basePath}${this.prefix}/blobs/${encodeURIComponent(id)}`
  }
  private search(context: OperationContext): Response {
    const query = context.url.searchParams.get("query")?.trim().toLowerCase()
    const page = Number(context.url.searchParams.get("page") ?? 1)
    const perPage = Math.min(30, Number(context.url.searchParams.get("per_page") ?? 10))
    const orientation = context.url.searchParams.get("orientation")
    if (
      !query ||
      !Number.isInteger(page) ||
      page < 1 ||
      !Number.isInteger(perPage) ||
      perPage < 1 ||
      (orientation && !["landscape", "portrait", "squarish"].includes(orientation))
    )
      return failure(400, "Invalid search parameters")
    const photos = this.photos
      .list({ order: "oldest" })
      .map(({ value }) => value)
      .filter(
        (photo) =>
          photo.queries.some((term) => term.trim().toLowerCase() === query) &&
          (!orientation || photo.orientation === orientation),
      )
    const totalPages = Math.ceil(photos.length / perPage)
    const results = photos.slice((page - 1) * perPage, page * perPage).map((photo) => ({
      id: photo.id,
      alt_description: photo.alt_description,
      user: photo.user,
      urls: { regular: this.imageUrl(context, photo.id) },
      links: {
        download_location: `${context.url.origin}${this.basePath}/photos/${encodeURIComponent(photo.id)}/download`,
      },
    }))
    const links: string[] = []
    const link = (number: number, relation: string) => {
      const url = new URL(`${context.url.origin}${this.basePath}/search/photos`)
      url.search = context.url.search
      // Never copy an access key into pagination links.
      url.searchParams.delete("client_id")
      url.searchParams.set("page", String(number))
      links.push(`<${url.href}>; rel="${relation}"`)
    }
    if (totalPages) {
      link(1, "first")
      link(totalPages, "last")
      if (page > 1) link(page - 1, "prev")
      if (page < totalPages) link(page + 1, "next")
    }
    const response = jsonRes(200, { total: photos.length, total_pages: totalPages, results })
    response.headers.set("x-total", String(photos.length))
    response.headers.set("x-per-page", String(perPage))
    response.headers.set("x-ratelimit-limit", "50")
    response.headers.set("x-ratelimit-remaining", "49")
    if (links.length) response.headers.set("link", links.join(", "))
    return response
  }
}
