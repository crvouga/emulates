/**
 * The file-backed {@link DurableStorage}: one directory per cluster.
 *
 *   <root>/MANIFEST.json     which file holds each database; replacing it is the commit point
 *   <root>/<sha256>.pgmm     one database's PGMM snapshot, named by the SHA-256 of its bytes
 *
 * A write stores the snapshots the manifest does not reference yet, then swaps the manifest.
 * Every file goes to a temporary name, is fsynced, renamed into place, and the directory is
 * fsynced, so a crash at any point leaves the previous manifest with all of its files or the
 * new one with all of its files. What an interrupted write leaves behind (temporary files,
 * snapshots no manifest names) is removed on the next start. A snapshot whose length or digest
 * does not match its manifest entry is refused, never decoded.
 */
import { createHash } from "node:crypto";
import { mkdir, open, readdir, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { ClusterImage, DurableStorage } from "./durable.ts";

const MANIFEST = "MANIFEST.json";
const FORMAT = "mockingbird-postgres-durable";
const VERSION = 1;
const SNAPSHOT_FILE = /^[0-9a-f]{64}\.pgmm$/;

type Manifest = { format: string; version: number; databases: { name: string; file: string; bytes: number }[] };

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

const corrupt = (root: string, why: string): Error =>
  new Error(`durable storage at ${root} is corrupt (${why}); refusing to start from it`);

const parseManifest = (root: string, text: string): Manifest => {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw corrupt(root, `${MANIFEST} is not valid JSON`);
  }
  const manifest = value as Partial<Manifest> | null;
  if (typeof manifest !== "object" || manifest === null || manifest.format !== FORMAT) {
    throw corrupt(root, `${MANIFEST} is not a ${FORMAT} manifest`);
  }
  if (manifest.version !== VERSION) {
    throw new Error(`durable storage at ${root} has format version ${manifest.version}; this server reads ${VERSION}`);
  }
  if (!Array.isArray(manifest.databases)) throw corrupt(root, `${MANIFEST} lists no databases`);
  for (const entry of manifest.databases) {
    if (typeof entry?.name !== "string" || typeof entry.bytes !== "number" || !SNAPSHOT_FILE.test(entry.file)) {
      throw corrupt(root, `${MANIFEST} has a malformed database entry`);
    }
  }
  return manifest as Manifest;
};

/** Persist a cluster under the directory `root` (created when missing). One server per root. */
export const fileStorage = (root: string): DurableStorage => {
  const digests = new WeakMap<Uint8Array, string>();
  /** Snapshot files known to be in the directory. */
  const present = new Set<string>();
  let temporary = 0;

  const fileOf = (bytes: Uint8Array): string => {
    let digest = digests.get(bytes);
    if (digest === undefined) {
      digest = sha256(bytes);
      digests.set(bytes, digest);
    }
    return `${digest}.pgmm`;
  };

  /** Durable contents under a temporary name first, so `name` is never a partial file. */
  const writeAtomic = async (name: string, bytes: Uint8Array): Promise<void> => {
    const pending = join(root, `${name}.${process.pid}.${temporary++}.tmp`);
    const handle = await open(pending, "w");
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(pending, join(root, name));
  };

  /** Make the renames above durable. Windows cannot fsync a directory; NTFS journals the rename. */
  const syncDirectory = async (): Promise<void> => {
    if (process.platform === "win32") return;
    const handle = await open(root, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  };

  const remove = (name: string): Promise<void> => unlink(join(root, name)).catch(() => undefined);

  return {
    async read(): Promise<ClusterImage | null> {
      await mkdir(root, { recursive: true });
      const entries = await readdir(root);
      await Promise.all(entries.filter((name) => name.endsWith(".tmp")).map(remove));
      const snapshots = entries.filter((name) => SNAPSHOT_FILE.test(name));
      present.clear();
      if (!entries.includes(MANIFEST)) {
        await Promise.all(snapshots.map(remove));
        return null;
      }
      const manifest = parseManifest(root, await readFile(join(root, MANIFEST), "utf8"));
      const image = new Map<string, Uint8Array>();
      for (const { name, file, bytes: length } of manifest.databases) {
        let bytes: Uint8Array;
        try {
          bytes = new Uint8Array(await readFile(join(root, file)));
        } catch {
          throw corrupt(root, `the snapshot of database "${name}" is missing`);
        }
        if (bytes.byteLength !== length || `${sha256(bytes)}.pgmm` !== file) {
          throw corrupt(root, `the snapshot of database "${name}" does not match its manifest entry`);
        }
        digests.set(bytes, file.slice(0, 64));
        present.add(file);
        image.set(name, bytes);
      }
      await Promise.all(snapshots.filter((name) => !present.has(name)).map(remove));
      return image;
    },

    async write(image: ClusterImage): Promise<void> {
      await mkdir(root, { recursive: true });
      const manifest: Manifest = { format: FORMAT, version: VERSION, databases: [] };
      let added = false;
      for (const [name, bytes] of image) {
        const file = fileOf(bytes);
        manifest.databases.push({ name, file, bytes: bytes.byteLength });
        if (present.has(file)) continue;
        await writeAtomic(file, bytes);
        present.add(file);
        added = true;
      }
      // The snapshots must be durable before a manifest that names them can be.
      if (added) await syncDirectory();
      await writeAtomic(MANIFEST, new TextEncoder().encode(`${JSON.stringify(manifest)}\n`));
      await syncDirectory();
      const referenced = new Set(manifest.databases.map((entry) => entry.file));
      for (const file of [...present]) {
        if (referenced.has(file)) continue;
        present.delete(file);
        await remove(file);
      }
    },
  };
};
