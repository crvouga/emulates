/*! Adapted from vercel-labs/emulate (Apache-2.0), modified for Mockingbird. See port.json, LICENSE_EMULATE and THIRD_PARTY_NOTICES.md. */
import { Buffer } from "buffer";
import { createHash, randomBytes } from "../../core/crypto.js";
import type { Context, RouteContext } from "../../core/index.js";
import type { ContentfulStatusCode } from "../../core/index.js";
import { getVercelStore } from "../store.js";
import type { VercelStore } from "../store.js";
import type { VercelBlob } from "../entities.js";

const DEFAULT_CACHE_MAX_AGE = 2592000;
const DEFAULT_LIST_LIMIT = 1000;

const MIME_TYPES: Record<string, string> = {
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
};

function blobErr(c: Context, status: ContentfulStatusCode, code: string, message: string): Response {
  return c.json({ error: { code, message } }, status);
}

function forbidden(c: Context): Response {
  return blobErr(c, 403, "forbidden", "Access denied");
}

function resolveStoreId(c: Context): string | null {
  const authHeader = c.req.header("authorization") ?? "";
  const match = /^Bearer\s+(\S+)$/i.exec(authHeader);
  if (!match) return null;
  const token = match[1];
  if (token.startsWith("vercel_blob_rw_")) {
    const parts = token.split("_");
    if (parts.length >= 5 && parts[3] !== "" && parts[4] !== "") {
      return parts[3];
    }
    return null;
  }

  const storeId = c.req.header("x-vercel-blob-store-id")?.trim();
  return storeId ? storeId : null;
}

function inferContentType(pathname: string): string {
  const basename = pathname.split("/").pop() ?? "";
  const dot = basename.lastIndexOf(".");
  if (dot <= 0) return "application/octet-stream";
  const ext = basename.slice(dot + 1).toLowerCase();
  return MIME_TYPES[ext] ?? "application/octet-stream";
}

function randomSuffix(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = randomBytes(8);
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += alphabet[bytes[i] % alphabet.length];
  }
  return out;
}

function withRandomSuffix(pathname: string): string {
  const suffix = randomSuffix();
  const slash = pathname.lastIndexOf("/");
  const dot = pathname.lastIndexOf(".");
  if (dot > slash + 1) {
    return `${pathname.slice(0, dot)}-${suffix}${pathname.slice(dot)}`;
  }
  return `${pathname}-${suffix}`;
}

function encodePathname(pathname: string): string {
  return pathname
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function blobUrl(baseUrl: string, storeId: string, pathname: string): string {
  return `${baseUrl}/blob/${encodeURIComponent(storeId)}/${encodePathname(pathname)}`;
}

function downloadUrl(url: string): string {
  return `${url}?download=1`;
}

function contentDispositionFor(pathname: string): string {
  const basename = (pathname.split("/").pop() ?? pathname).replace(/"/g, "");
  return `attachment; filename="${basename}"`;
}

interface BlobRef {
  pathname: string;
  storeId?: string;
}

function resolveBlobRef(urlOrPathname: string, baseUrl?: URL): BlobRef {
  if (!/^https?:\/\//i.test(urlOrPathname)) {
    return { pathname: urlOrPathname };
  }
  let url: URL;
  try {
    url = new URL(urlOrPathname);
  } catch {
    return { pathname: urlOrPathname };
  }
  let path = decodeURIComponent(url.pathname);
  const basePath = baseUrl?.pathname.replace(/\/$/, "") ?? "";
  if (basePath && url.origin === baseUrl?.origin && path.startsWith(`${basePath}/blob/`)) {
    path = path.slice(basePath.length);
  }
  const match = /^\/blob\/([^/]+)\/(.+)$/.exec(path);
  if (match) {
    return { storeId: match[1], pathname: match[2] };
  }
  const vercelHost = /^([^.]+)\.(?:public|private)\.blob\.vercel-storage\.com$/i.exec(url.hostname);
  if (vercelHost) {
    return { storeId: vercelHost[1], pathname: path.replace(/^\//, "") };
  }
  return { pathname: path.replace(/^\//, "") };
}

function findBlob(vs: VercelStore, storeId: string, pathname: string): VercelBlob | undefined {
  return vs.blobs.findBy("pathname", pathname).find((b) => b.storeId === storeId);
}

function findBlobRef(vs: VercelStore, storeId: string, ref: BlobRef): VercelBlob | undefined {
  if (ref.storeId && ref.storeId !== storeId) return undefined;
  return findBlob(vs, storeId, ref.pathname);
}

function headResponse(baseUrl: string, blob: VercelBlob): Record<string, unknown> {
  const url = blobUrl(baseUrl, blob.storeId, blob.pathname);
  return {
    url,
    downloadUrl: downloadUrl(url),
    pathname: blob.pathname,
    size: blob.size,
    contentType: blob.contentType,
    contentDisposition: blob.contentDisposition,
    cacheControl: blob.cacheControl,
    uploadedAt: blob.uploadedAt,
    etag: blob.etag,
  };
}

export function blobRoutes({ app, store, baseUrl }: RouteContext): void {
  const vs = getVercelStore(store);
  const parsedBaseUrl = new URL(baseUrl);

  // Upload. The SDK sends PUT <api>/?pathname=<pathname> with the raw bytes as body.

  const handlePut = async (c: Context): Promise<Response> => {
    const storeId = resolveStoreId(c);
    if (!storeId) return forbidden(c);

    const rawPathname = c.req.query("pathname");
    if (!rawPathname) {
      return blobErr(c, 400, "bad_request", "pathname is required");
    }
    if (rawPathname.includes("//")) {
      return blobErr(c, 400, "bad_request", "pathname cannot contain //");
    }

    const access = c.req.header("x-vercel-blob-access") ?? "public";
    if (access !== "public") {
      return blobErr(c, 400, "bad_request", "Only access: public is supported by the emulator");
    }

    const pathname = c.req.header("x-add-random-suffix") === "1" ? withRandomSuffix(rawPathname) : rawPathname;

    const existing = findBlob(vs, storeId, pathname);

    const ifMatch = c.req.header("x-if-match");
    if (ifMatch) {
      const normalized = ifMatch.startsWith('"') ? ifMatch : `"${ifMatch}"`;
      if (!existing || existing.etag !== normalized) {
        return blobErr(c, 412, "precondition_failed", "Precondition failed: ETag mismatch.");
      }
    } else if (existing && c.req.header("x-allow-overwrite") !== "1") {
      return blobErr(c, 400, "bad_request", "This blob already exists, use allowOverwrite: true to overwrite it");
    }

    const fromUrl = c.req.query("fromUrl");
    const source = fromUrl === undefined ? undefined : findBlobRef(vs, storeId, resolveBlobRef(fromUrl, parsedBaseUrl));
    if (fromUrl !== undefined && !source) {
      return blobErr(c, 404, "not_found", "The requested blob does not exist");
    }

    const body = source ? Buffer.from(source.dataBase64, "base64") : Buffer.from(await c.req.arrayBuffer());
    const contentType = c.req.header("x-content-type") || inferContentType(pathname);
    const maxAgeHeader = c.req.header("x-cache-control-max-age");
    const maxAge = maxAgeHeader ? parseInt(maxAgeHeader, 10) : NaN;
    const cacheControl = `public, max-age=${Number.isFinite(maxAge) ? maxAge : DEFAULT_CACHE_MAX_AGE}`;
    const contentDisposition = contentDispositionFor(pathname);
    const etag = `"${createHash("sha256").update(body).digest("hex")}"`;
    const uploadedAt = new Date(store.now()).toISOString();

    const fields = {
      pathname,
      storeId,
      contentType,
      contentDisposition,
      cacheControl,
      size: body.byteLength,
      etag,
      uploadedAt,
      dataBase64: body.toString("base64"),
    };

    if (existing) {
      vs.blobs.update(existing.id, fields);
    } else {
      vs.blobs.insert(fields);
    }

    const url = blobUrl(baseUrl, storeId, pathname);
    return c.json({
      url,
      downloadUrl: downloadUrl(url),
      pathname,
      contentType,
      contentDisposition,
      etag,
    });
  };

  // Head and list.
  // The SDK sends GET <api>?url=<urlOrPathname> for head and
  // GET <api>?prefix=&limit=&cursor=&mode= for list.

  const handleGet = (c: Context): Response => {
    const storeId = resolveStoreId(c);
    if (!storeId) return forbidden(c);

    const urlParam = c.req.query("url");
    if (urlParam !== undefined) {
      const blob = findBlobRef(vs, storeId, resolveBlobRef(urlParam, parsedBaseUrl));
      if (!blob) {
        return blobErr(c, 404, "not_found", "The requested blob does not exist");
      }
      return c.json(headResponse(baseUrl, blob));
    }

    const prefix = c.req.query("prefix") ?? "";
    const limitParam = parseInt(c.req.query("limit") ?? "", 10);
    const limit = Number.isFinite(limitParam) && limitParam > 0 ? limitParam : DEFAULT_LIST_LIMIT;
    const cursor = c.req.query("cursor");
    const folded = c.req.query("mode") === "folded";

    let items = vs.blobs
      .findBy("storeId", storeId)
      .filter((b) => b.pathname.startsWith(prefix))
      .sort((a, b) => (a.pathname < b.pathname ? -1 : a.pathname > b.pathname ? 1 : 0));

    const folders = new Set<string>();
    if (folded) {
      items = items.filter((b) => {
        const rest = b.pathname.slice(prefix.length);
        const slash = rest.indexOf("/");
        if (slash === -1) return true;
        folders.add(prefix + rest.slice(0, slash + 1));
        return false;
      });
    }

    if (cursor) {
      items = items.filter((b) => b.pathname > cursor);
    }

    const hasMore = items.length > limit;
    const page = items.slice(0, limit);

    const result: Record<string, unknown> = {
      blobs: page.map((b) => {
        const url = blobUrl(baseUrl, b.storeId, b.pathname);
        return {
          url,
          downloadUrl: downloadUrl(url),
          pathname: b.pathname,
          size: b.size,
          uploadedAt: b.uploadedAt,
          etag: b.etag,
        };
      }),
      hasMore,
    };
    if (hasMore && page.length > 0) {
      result.cursor = page[page.length - 1].pathname;
    }
    if (folded) {
      result.folders = [...folders].sort();
    }
    return c.json(result);
  };

  app.put("/api/blob", handlePut);
  app.put("/api/blob/", handlePut);
  app.get("/api/blob", handleGet);
  app.get("/api/blob/", handleGet);

  // Delete.

  app.post("/api/blob/delete", async (c) => {
    const storeId = resolveStoreId(c);
    if (!storeId) return forbidden(c);

    let body: { urls?: unknown };
    try {
      body = (await c.req.json()) as { urls?: unknown };
    } catch {
      body = {};
    }
    const urls = Array.isArray(body.urls) ? body.urls.filter((u): u is string => typeof u === "string") : [];

    const ifMatch = c.req.header("x-if-match");
    for (const urlOrPathname of urls) {
      const blob = findBlobRef(vs, storeId, resolveBlobRef(urlOrPathname, parsedBaseUrl));
      if (!blob) continue;
      if (ifMatch) {
        const normalized = ifMatch.startsWith('"') ? ifMatch : `"${ifMatch}"`;
        if (blob.etag !== normalized) {
          return blobErr(c, 412, "precondition_failed", "Precondition failed: ETag mismatch.");
        }
      }
      vs.blobs.delete(blob.id);
    }

    return c.json(null);
  });

  // Multipart uploads are not supported yet.

  const handleMpu = (c: Context): Response =>
    blobErr(c, 400, "bad_request", "Multipart uploads are not supported by the emulator yet");
  app.post("/api/blob/mpu", handleMpu);
  app.put("/api/blob/mpu", handleMpu);

  // Public content serving.
  // Blob URLs point here. Public access, no authentication.

  app.get("/blob/:storeId/:pathname{.+}", (c) => {
    const storeId = c.req.param("storeId");
    const pathname = c.req.param("pathname");
    const blob = findBlob(vs, storeId, pathname);
    if (!blob) {
      return blobErr(c, 404, "not_found", "The requested blob does not exist");
    }

    const headers: Record<string, string> = {
      etag: blob.etag,
      "cache-control": blob.cacheControl,
    };

    if (c.req.header("if-none-match") === blob.etag) {
      return c.body(null, 304, headers);
    }

    headers["content-type"] = blob.contentType;
    if (c.req.query("download") === "1") {
      headers["content-disposition"] = blob.contentDisposition;
    }
    return c.body(Buffer.from(blob.dataBase64, "base64"), 200, headers);
  });
}
