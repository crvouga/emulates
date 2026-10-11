/**
 * Opt-in durable mode for the wire server: a commit is acknowledged only once the whole cluster,
 * as PGMM snapshots, has reached a {@link DurableStorage}. It is snapshot persistence, not a
 * write-ahead log and not PostgreSQL's on-disk format. The guarantee it models is the one a
 * client relies on: https://www.postgresql.org/docs/18/wal-intro.html (an acknowledged COMMIT
 * survives a crash) and https://www.postgresql.org/docs/18/sql-commit.html.
 *
 * Nothing here touches a filesystem: the storage is a port the server awaits, so a test can
 * model failure and pauses, and {@link fileStorage} (./file-storage.ts) is the real one.
 */
// The PGMM codec registers itself on load; this entry can be the only one a process imports.
import "../serialization/codec.ts";
import { type Database, requireCodec } from "../api/database.ts";
import { Snapshot } from "../api/snapshot.ts";
import { PostgresError } from "../errors/error.ts";
import type { Cluster } from "./cluster.ts";

/** One durable image of the cluster: each database's PGMM snapshot bytes by database name. */
export type ClusterImage = ReadonlyMap<string, Uint8Array>;

/** Where durable mode keeps the cluster. The server awaits it before acknowledging a commit. */
export interface DurableStorage {
  /** The image of the last {@link write} that resolved, or `null` when nothing was persisted yet. */
  read(): Promise<ClusterImage | null>;
  /**
   * Replace the persisted image with `image`, atomically: resolve once it would survive the
   * process being killed, or reject and leave the previous image intact. The server never
   * calls it concurrently, and passes the same `Uint8Array` object for a database that did
   * not change since the last call, so an implementation can skip rewriting it.
   */
  write(image: ClusterImage): Promise<void>;
}

/** A commit the server persisted, as the test controls of {@link DurableOptions} see it. */
export type DurableCommit = {
  /** Backend pid of the session that committed. */
  pid: number;
  /** Database the commit belongs to. */
  database: string;
  /** The statement that committed: the write itself in autocommit, else `COMMIT`. */
  sql: string;
};

export type DurableOptions = {
  /** A directory for the file-backed store, or an injected {@link DurableStorage}. */
  storage: string | DurableStorage;
  /**
   * Test control: awaited after a commit was persisted and before the server acknowledges it.
   * A process killed while this is pending restarts with the commit; the client never saw it.
   */
  beforeAcknowledge?: (commit: DurableCommit) => void | Promise<void>;
  /**
   * Test control: awaited right after the acknowledgement was written to the socket
   * (`CommandComplete`, or `ReadyForQuery` for the implicit commit of a multi-statement query).
   */
  afterAcknowledge?: (commit: DurableCommit) => void | Promise<void>;
};

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean => {
  if (a === b) return true;
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
  return true;
};

/**
 * A storage failure as the client sees it: the commit is not acknowledged, and the statement
 * ends with `58030` (io_error), or `53100` (disk_full) when the storage ran out of space.
 */
export const storageFailure = (cause: unknown): PostgresError => {
  const errno = typeof cause === "object" && cause !== null ? (cause as { code?: unknown }).code : undefined;
  const reason = cause instanceof Error ? cause.message : String(cause);
  return new PostgresError(
    "internal",
    `could not persist the commit to durable storage: ${reason}`,
    errno === "ENOSPC" || errno === "EDQUOT" ? "53100" : "58030",
  );
};

/**
 * PGMM bytes of a database as it stands, the same bytes `snapshot().encode()` gives. Encoding
 * the live state keeps a commit from leaving a checkpoint behind on the database's timeline.
 */
const encodeLive = (database: Database): Uint8Array =>
  requireCodec().encodeDatabaseState(database.state, {
    prngState: database.prng.getState(),
    nowMs: database.now().getTime(),
  });

/** Rebuild the databases of a persisted image, with the runtime (clock, seed, entropy) of `template`. */
export const openImage = (image: ClusterImage, template: Database): Map<string, Database> => {
  const databases = new Map<string, Database>();
  for (const [name, bytes] of image) {
    const database = Snapshot.decode(bytes).open({
      seed: template.seed,
      random: template.randomMode,
      int8: template.int8Mode,
      ...(template.systemClock ? { now: "system" as const } : {}),
    });
    if (!template.systemClock) database.now = template.now;
    databases.set(name, database);
  }
  return databases;
};

/** Persists the cluster for the server, re-encoding only the databases a commit touched. */
export class Durability {
  /** PGMM bytes of each database as storage holds them. */
  private readonly persisted = new WeakMap<Database, Uint8Array>();
  private image: ClusterImage | null = null;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly cluster: Cluster,
    private readonly storage: DurableStorage,
    private readonly hooks: Pick<DurableOptions, "beforeAcknowledge" | "afterAcknowledge">,
  ) {}

  /** Record that storage already holds `image` for the cluster's databases (after a restart). */
  adopt(image: ClusterImage): void {
    this.image = image;
    for (const [name, bytes] of image) {
      const database = this.cluster.getDatabase(name);
      if (database) this.persisted.set(database, bytes);
    }
  }

  /**
   * Write the cluster with `changed` (or every database) encoded from its live state. Resolves
   * to whether storage was written: an image identical to the persisted one is skipped. The
   * caller holds the statement turn, so no session runs between the commit and this.
   */
  persist(changed: readonly Database[] | "all"): Promise<boolean> {
    const next = this.tail.then(() => this.write(changed));
    this.tail = next.catch(() => undefined);
    return next;
  }

  /** Resolves when no write is in flight. */
  idle(): Promise<void> {
    return this.tail.then(() => undefined);
  }

  private async write(changed: readonly Database[] | "all"): Promise<boolean> {
    const image = new Map<string, Uint8Array>();
    const databases = new Map<Database, Uint8Array>();
    let same = this.image !== null && this.image.size === this.cluster.databaseNames().length;
    for (const name of this.cluster.databaseNames()) {
      const database = this.cluster.requireDatabase(name);
      const previous = this.persisted.get(database);
      let bytes = previous;
      if (bytes === undefined || changed === "all" || changed.includes(database)) {
        const encoded = encodeLive(database);
        bytes = previous !== undefined && sameBytes(previous, encoded) ? previous : encoded;
      }
      same &&= this.image?.get(name) === bytes;
      image.set(name, bytes);
      databases.set(database, bytes);
    }
    if (same) return false;
    await this.storage.write(image);
    this.image = image;
    for (const [database, bytes] of databases) this.persisted.set(database, bytes);
    return true;
  }

  beforeAcknowledge(commit: DurableCommit): void | Promise<void> {
    return this.hooks.beforeAcknowledge?.(commit);
  }

  afterAcknowledge(commit: DurableCommit): void | Promise<void> {
    return this.hooks.afterAcknowledge?.(commit);
  }
}
