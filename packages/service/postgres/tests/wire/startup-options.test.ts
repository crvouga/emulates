import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { connect as tcp } from "node:net";
import { SQL } from "bun";
import pg from "pg";
import { type PostgresServer, serve } from "../../src/wire/index.ts";
import { splitOptions } from "../../src/wire/startup.ts";

// Run-time parameters of the StartupMessage: libpq's `options` string and parameters sent by name.
// The expectations were read off PostgreSQL 18.3 with these same clients. With
// POSTGRES_MEM_ORACLE_URL naming a real PostgreSQL 18 server, the option parsing tables and the
// RESET check below run against that server as well, with the same expected values.

let server: PostgresServer;
const oracle = process.env.POSTGRES_MEM_ORACLE_URL;

beforeAll(async () => {
  server = await serve({ port: 0 });
  const admin = await connect();
  await admin.query(
    "CREATE SCHEMA example; CREATE SCHEMA other; CREATE TABLE example.items (id int); INSERT INTO example.items VALUES (1)",
  );
  await admin.end();
});

afterAll(async () => {
  await server.close();
});

const urlWith = (options?: string, base: string = server.connectionString): string => {
  const url = new URL(base);
  if (options !== undefined) url.searchParams.set("options", options);
  return url.toString();
};

const connect = async (options?: string, config: pg.ClientConfig = {}, base?: string): Promise<pg.Client> => {
  const client = new pg.Client({ connectionString: urlWith(options, base), ...config });
  await client.connect();
  return client;
};

const show = async (client: pg.Client, name: string): Promise<unknown> =>
  Object.values((await client.query(`SHOW ${name}`)).rows[0] as Record<string, unknown>)[0];

const currentSchema = async (client: pg.Client): Promise<unknown> =>
  (await client.query("SELECT current_schema() AS name")).rows[0]?.name;

/** The error a connection attempt ends with. */
const rejection = async (options?: string, config: pg.ClientConfig = {}, base?: string): Promise<pg.DatabaseError> => {
  const client = new pg.Client({ connectionString: urlWith(options, base), ...config });
  try {
    await client.connect();
  } catch (error) {
    return error as pg.DatabaseError;
  }
  await client.end();
  throw new Error(`connected with options ${JSON.stringify(options)}`);
};

type RawSession = { status: Record<string, string>; error?: Record<string, string>; rows: (string | null)[][] };

/** A bare v3 StartupMessage and one simple query, for parameters node-postgres never sends by name. */
const rawStartup = (parameters: Record<string, string>, sql: string): Promise<RawSession> =>
  new Promise((resolve, reject) => {
    const session: RawSession = { status: {}, rows: [] };
    const socket = tcp(server.port, server.host, () => {
      const body = Buffer.concat([
        ...Object.entries({ user: "postgres", database: "postgres", ...parameters }).map(([name, value]) =>
          Buffer.from(`${name}\0${value}\0`),
        ),
        Buffer.from([0]),
      ]);
      const head = Buffer.alloc(8);
      head.writeInt32BE(body.length + 8, 0);
      head.writeInt32BE(196608, 4);
      socket.write(Buffer.concat([head, body]));
    });
    let buffer = Buffer.alloc(0);
    let asked = false;
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 5 && buffer.length >= 1 + buffer.readInt32BE(1)) {
        const type = String.fromCharCode(buffer[0] as number);
        const payload = buffer.subarray(5, 1 + buffer.readInt32BE(1));
        buffer = buffer.subarray(1 + buffer.readInt32BE(1));
        if (type === "S") {
          const [name, value] = payload.toString().split("\0");
          session.status[name as string] = value as string;
        } else if (type === "E") {
          session.error = Object.fromEntries(
            payload
              .toString()
              .split("\0")
              .filter((field) => field.length > 0)
              .map((field) => [field[0], field.slice(1)]),
          );
        } else if (type === "D") {
          const row: (string | null)[] = [];
          let at = 2;
          for (let i = 0; i < payload.readInt16BE(0); i++) {
            const length = payload.readInt32BE(at);
            row.push(length === -1 ? null : payload.subarray(at + 4, at + 4 + length).toString());
            at += 4 + Math.max(length, 0);
          }
          session.rows.push(row);
        } else if (type === "Z" && !asked) {
          asked = true;
          const query = Buffer.from(`${sql}\0`);
          const head = Buffer.alloc(5);
          head.write("Q");
          head.writeInt32BE(query.length + 4, 1);
          socket.write(Buffer.concat([head, query]));
        } else if (type === "Z") {
          socket.end();
        }
      }
    });
    socket.on("close", () => resolve(session));
    socket.on("error", reject);
  });

describe("behavior 1: an existing schema named in startup options", () => {
  test("is current_schema() and scopes unqualified reads and writes", async () => {
    const client = await connect("-c search_path=example");
    try {
      expect(await currentSchema(client)).toBe("example");
      expect(await show(client, "search_path")).toBe("example");
      expect((await client.query("SELECT id FROM items")).rows).toEqual([{ id: 1 }]);
      await client.query("INSERT INTO items VALUES (2)");
      await client.query("CREATE TABLE scoped (id int)");
      const placed = await client.query("SELECT schemaname FROM pg_tables WHERE tablename = 'scoped'");
      expect(placed.rows).toEqual([{ schemaname: "example" }]);
    } finally {
      await client.end();
    }
    const plain = await connect();
    try {
      expect((await plain.query("SELECT id FROM example.items ORDER BY id")).rows).toEqual([{ id: 1 }, { id: 2 }]);
      await expect(plain.query("SELECT id FROM items")).rejects.toMatchObject({ code: "42P01" });
    } finally {
      await plain.end();
    }
  });

  test("folds an unquoted schema name and keeps a quoted one, like SET", async () => {
    const client = await connect('-c search_path=Example,"Keep"');
    try {
      expect(await currentSchema(client)).toBe("example");
      await client.query('CREATE SCHEMA "Keep"; SET search_path = "Keep"');
      expect(await currentSchema(client)).toBe("Keep");
    } finally {
      await client.query('DROP SCHEMA "Keep"');
      await client.end();
    }
  });

  test("holds for every physical connection of a pool", async () => {
    const pool = new pg.Pool({ connectionString: urlWith("-c search_path=example"), max: 3 });
    try {
      const held = await Promise.all([pool.connect(), pool.connect(), pool.connect()]);
      try {
        const pids = new Set<number>();
        for (const client of held) {
          expect(await currentSchema(client)).toBe("example");
          pids.add((await client.query("SELECT pg_backend_pid() AS pid")).rows[0]?.pid);
        }
        expect(pids.size).toBe(3);
      } finally {
        for (const client of held) client.release();
      }
    } finally {
      await pool.end();
    }
  });
});

describe("session functions under a startup path without public", () => {
  test("advisory locks still coordinate across connections", async () => {
    const holder = await connect("-c search_path=example");
    const other = await connect("-c search_path=example");
    try {
      await holder.query("SELECT pg_advisory_lock(317)");
      expect((await other.query("SELECT pg_try_advisory_lock(317) AS locked")).rows).toEqual([{ locked: false }]);
      await holder.query("SELECT pg_catalog.pg_advisory_unlock(317)");
      expect((await other.query("SELECT pg_try_advisory_lock(317) AS locked")).rows).toEqual([{ locked: true }]);
    } finally {
      await holder.end();
      await other.end();
    }
  });
});

describe("behavior 2: a startup schema that does not exist yet", () => {
  test("starts resolving once the same connection creates it", async () => {
    const client = await connect("-c search_path=later");
    try {
      expect(await show(client, "search_path")).toBe("later");
      expect(await currentSchema(client)).toBeNull();
      await client.query("CREATE SCHEMA later");
      expect(await currentSchema(client)).toBe("later");
      await client.query("CREATE TABLE arrivals (id int)");
      const placed = await client.query("SELECT schemaname FROM pg_tables WHERE tablename = 'arrivals'");
      expect(placed.rows).toEqual([{ schemaname: "later" }]);
    } finally {
      await client.end();
    }
  });
});

describe("behavior 3: connections with different startup paths", () => {
  test("stay independent while one of them changes its path", async () => {
    const first = await connect("-c search_path=example");
    const second = await connect("-c search_path=other");
    const plain = await connect();
    try {
      await first.query("SET search_path = public");
      await first.query("SELECT set_config('application_name', 'first', false)");
      expect(await show(first, "search_path")).toBe("public");
      expect(await show(second, "search_path")).toBe("other");
      expect(await currentSchema(second)).toBe("other");
      expect(await show(plain, "search_path")).toBe('"$user", public');
      expect(await show(plain, "application_name")).toBe("");

      await second.query("CREATE TABLE mine (id int)");
      const placed = await plain.query("SELECT schemaname FROM pg_tables WHERE tablename = 'mine'");
      expect(placed.rows).toEqual([{ schemaname: "other" }]);
    } finally {
      await first.end();
      await second.end();
      await plain.end();
    }
    // A connection opened afterwards starts from its own startup packet, not a neighbour's SET.
    const later = await connect();
    try {
      expect(await show(later, "search_path")).toBe('"$user", public');
    } finally {
      await later.end();
    }
  });

  test("a SET inside a transaction block is private until commit and undone by rollback", async () => {
    const first = await connect("-c search_path=example");
    const second = await connect("-c search_path=example");
    try {
      await first.query("BEGIN");
      await first.query("SET search_path = other");
      expect(await currentSchema(first)).toBe("other");
      expect(await currentSchema(second)).toBe("example");
      await first.query("ROLLBACK");
      expect(await show(first, "search_path")).toBe("example");

      await first.query("BEGIN");
      await first.query("SET search_path = other");
      await first.query("COMMIT");
      expect(await show(first, "search_path")).toBe("other");
      expect(await show(second, "search_path")).toBe("example");
    } finally {
      await first.end();
      await second.end();
    }
  });
});

describe("behavior 4: option parsing", () => {
  test("splits on unescaped whitespace like pg_split_opts", () => {
    expect(splitOptions("")).toEqual([]);
    expect(splitOptions("  -c   a=1\t-c\nb=2  ")).toEqual(["-c", "a=1", "-c", "b=2"]);
    expect(splitOptions("-c search_path=a,\\ b")).toEqual(["-c", "search_path=a, b"]);
    expect(splitOptions("-c name=x\\\\y")).toEqual(["-c", "name=x\\y"]);
    expect(splitOptions("a\\")).toEqual(["a"]);
  });

  const accepted: [label: string, options: string, expected: Record<string, string>][] = [
    [
      "several -c options",
      "-c search_path=example -c application_name=probe -c statement_timeout=5000",
      { search_path: "example", application_name: "probe", statement_timeout: "5s" },
    ],
    ["-c with its value attached", "-csearch_path=example", { search_path: "example" }],
    ["the --name=value form", "--search_path=example", { search_path: "example" }],
    [
      "dashes in a --name",
      "--search-path=example --application-name=x",
      { search_path: "example", application_name: "x" },
    ],
    ["a backslash-escaped space", "-c search_path=example,\\ public", { search_path: "example, public" }],
    ["an escaped backslash", "-c application_name=my\\ app\\\\x", { application_name: "my app\\x" }],
    [
      "runs of blanks, tabs and newlines",
      "  -c   search_path=other\t-c\napplication_name=z  ",
      { search_path: "other", application_name: "z" },
    ],
    ["a repeated parameter (last wins)", "-c search_path=example -c search_path=other", { search_path: "other" }],
    ["a parameter name in upper case", "-c SEARCH_PATH=example", { search_path: "example" }],
    ["a value containing =", "-c application_name=a=b", { application_name: "a=b" }],
    ["an empty value", "-c search_path=", { search_path: "" }],
    ["an empty options string", "", { search_path: '"$user", public' }],
    ["-- ending the switches", "-c search_path=example --", { search_path: "example" }],
    ["a custom dotted parameter", "-c my.setting=1", { "my.setting": "1" }],
    [
      "booleans and enums in any accepted spelling",
      "-c row_security=yes -c array_nulls=0 -c check_function_bodies=of -c bytea_output=ESCAPE",
      { row_security: "on", array_nulls: "off", check_function_bodies: "off", bytea_output: "escape" },
    ],
    ["a time with a unit", "-c lock_timeout=2min", { lock_timeout: "2min" }],
  ];
  /** The server under test, and the real one when the run has it. */
  const targets: [who: string, base: string | undefined][] = [["", undefined]];
  if (oracle) targets.push([" (PostgreSQL itself)", oracle]);

  for (const [who, base] of targets) {
    for (const [label, options, expected] of accepted) {
      test(`accepts ${label}${who}`, async () => {
        const client = await connect(options, {}, base);
        try {
          for (const [name, value] of Object.entries(expected)) expect(await show(client, name)).toBe(value);
        } finally {
          await client.end();
        }
      });
    }
  }

  const rejected: [label: string, options: string, code: string, message: string, extra?: Record<string, string>][] = [
    ["an unknown parameter", "-c nope=1", "42704", 'unrecognized configuration parameter "nope"'],
    ["an unknown --parameter", "--no-pe=1", "42704", 'unrecognized configuration parameter "no_pe"'],
    ["-c without =value", "-c search_path", "42601", "-c search_path requires a value"],
    ["--name without =value", "--search_path", "42601", "--search_path requires a value"],
    [
      "an argument that is not a switch",
      "search_path=example",
      "42601",
      "invalid command-line argument for server process: search_path=example",
      { hint: 'Try "postgres --help" for more information.' },
    ],
    [
      "a trailing argument",
      "-c search_path=example extra",
      "42601",
      "invalid command-line argument for server process: extra",
    ],
    ["an unknown switch", "-Z", "42601", "invalid command-line argument for server process: -Z"],
    ["an argument after --", "-- foo", "42601", "invalid command-line argument for server process: foo"],
    [
      "an empty search_path element",
      "-c search_path=a,,b",
      "22023",
      'invalid value for parameter "search_path": "a,,b"',
      { detail: "List syntax is invalid." },
    ],
    [
      "an unterminated quoted schema",
      '-c search_path="open',
      "22023",
      'invalid value for parameter "search_path": ""open"',
      { detail: "List syntax is invalid." },
    ],
    [
      "a non-numeric integer",
      "-c extra_float_digits=abc",
      "22023",
      'invalid value for parameter "extra_float_digits": "abc"',
    ],
    [
      "an integer out of range",
      "-c extra_float_digits=99",
      "22023",
      '99 is outside the valid range for parameter "extra_float_digits" (-15 .. 3)',
    ],
    [
      "an unknown time unit",
      "-c statement_timeout=5parsecs",
      "22023",
      'invalid value for parameter "statement_timeout": "5parsecs"',
      { hint: 'Valid units for this parameter are "us", "ms", "s", "min", "h", and "d".' },
    ],
    [
      "a negative timeout",
      "-c statement_timeout=-1",
      "22023",
      '-1 ms is outside the valid range for parameter "statement_timeout" (0 ms .. 2147483647 ms)',
    ],
    ["a non-boolean", "-c row_security=maybe", "22023", 'parameter "row_security" requires a Boolean value'],
    [
      "an unknown enum value",
      "-c bytea_output=base64",
      "22023",
      'invalid value for parameter "bytea_output": "base64"',
      { hint: "Available values: escape, hex." },
    ],
    [
      "an unknown DateStyle key word",
      "-c datestyle=garbage",
      "22023",
      'invalid value for parameter "DateStyle": "garbage"',
      { detail: 'Unrecognized key word: "garbage".' },
    ],
    [
      "an unknown time zone",
      "-c timezone=Nowhere/Land",
      "22023",
      'invalid value for parameter "TimeZone": "Nowhere/Land"',
    ],
    ["a read-only parameter", "-c server_version=1", "55P02", 'parameter "server_version" cannot be changed'],
  ];
  for (const [who, base] of targets) {
    for (const [label, options, code, message, extra] of rejected) {
      test(`rejects ${label} with FATAL ${code}${who}`, async () => {
        const error = await rejection(options, {}, base);
        expect({ severity: error.severity, code: error.code, message: error.message }).toEqual({
          severity: "FATAL",
          code,
          message,
        });
        if (extra) expect(error).toMatchObject(extra);
      });
    }
  }

  test("rejects a switch that needs an argument and has none", async () => {
    // PostgreSQL names `argv[optind]` here, which is platform getopt state; the SQLSTATE is the contract.
    for (const options of ["-c", "-c search_path=example -c"]) {
      const error = await rejection(options);
      expect({ severity: error.severity, code: error.code }).toEqual({ severity: "FATAL", code: "42601" });
    }
  });

  test("fails loud on postgres switches the server does not model", async () => {
    // PostgreSQL accepts `-e` (European DateStyle) and `-S 1024` (work_mem); this server has neither.
    for (const options of ["-e", "-S 1024"]) {
      const error = await rejection(options);
      expect({ severity: error.severity, code: error.code }).toEqual({ severity: "FATAL", code: "0A000" });
    }
  });

  test("leaves no session behind when startup fails", async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
    const before = server.connections;
    await rejection("-c nope=1");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(server.connections).toBe(before);
  });

  test("applies options after SCRAM authentication too", async () => {
    const secured = await serve({ port: 0, password: "secret" });
    try {
      const url = new URL(secured.connectionString);
      url.searchParams.set("options", "-c search_path=audit -c application_name=secured");
      const client = new pg.Client({ connectionString: url.toString() });
      await client.connect();
      try {
        expect(await show(client, "search_path")).toBe("audit");
        expect(await show(client, "application_name")).toBe("secured");
      } finally {
        await client.end();
      }
      url.searchParams.set("options", "-c nope=1");
      const refused = new pg.Client({ connectionString: url.toString() });
      await expect(refused.connect()).rejects.toMatchObject({ severity: "FATAL", code: "42704" });
    } finally {
      await secured.close();
    }
  });
});

describe("run-time parameters sent by name in the startup packet", () => {
  test("search_path as a startup parameter sets the path", async () => {
    const session = await rawStartup({ search_path: "example" }, "SELECT current_schema()");
    expect(session.error).toBeUndefined();
    expect(session.rows).toEqual([["example"]]);
  });

  test("a parameter sent by name overrides the options string", async () => {
    const session = await rawStartup({ options: "-c search_path=other", search_path: "example" }, "SHOW search_path");
    expect(session.rows).toEqual([["example"]]);
  });

  test("names are case-insensitive and reported values follow the session", async () => {
    const session = await rawStartup(
      { DateStyle: "ISO", TimeZone: "America/New_York", extra_float_digits: "2", application_name: "driver" },
      "SELECT current_setting('datestyle'), current_setting('timezone'), current_setting('extra_float_digits')",
    );
    expect(session.rows).toEqual([["ISO, MDY", "America/New_York", "2"]]);
    expect(session.status).toMatchObject({
      DateStyle: "ISO, MDY",
      TimeZone: "America/New_York",
      application_name: "driver",
      client_encoding: "UTF8",
    });
  });

  test("an unknown or invalid parameter is FATAL, as in the options string", async () => {
    const unknown = await rawStartup({ nope: "1" }, "SELECT 1");
    expect(unknown.error).toMatchObject({ S: "FATAL", C: "42704", M: 'unrecognized configuration parameter "nope"' });
    expect(unknown.rows).toEqual([]);
    // Only names inside the options string have their dashes folded to underscores.
    const dashed = await rawStartup({ "search-path": "example" }, "SELECT 1");
    expect(dashed.error).toMatchObject({ S: "FATAL", C: "42704" });
    const invalid = await rawStartup({ extra_float_digits: "abc" }, "SELECT 1");
    expect(invalid.error).toMatchObject({ S: "FATAL", C: "22023" });
  });

  test("replication and protocol extension parameters are not settings", async () => {
    const session = await rawStartup({ replication: "false", "_pq_.unknown": "1" }, "SHOW search_path");
    expect(session.error).toBeUndefined();
    expect(session.rows).toEqual([['"$user", public']]);
  });

  test("node-postgres timeouts and application_name arrive as settings", async () => {
    const client = await connect(undefined, { statement_timeout: 5000, application_name: "worker" });
    try {
      expect(await show(client, "statement_timeout")).toBe("5s");
      expect(await show(client, "application_name")).toBe("worker");
    } finally {
      await client.end();
    }
  });

  test("Bun SQL connection parameters set the path", async () => {
    const sql = new SQL({ url: server.connectionString, connection: { search_path: "example" } });
    try {
      const rows = await sql`SELECT current_schema() AS name`;
      expect(rows[0]?.name).toBe("example");
    } finally {
      await sql.close();
    }
  });
});

describe("RESET returns to the startup value", () => {
  test("RESET search_path, SET ... TO DEFAULT and RESET ALL", async () => {
    const client = await connect("-c search_path=example -c application_name=boot");
    try {
      await client.query("SET search_path = other");
      await client.query("RESET search_path");
      expect(await show(client, "search_path")).toBe("example");

      await client.query("SET search_path = other");
      await client.query("SET search_path TO DEFAULT");
      expect(await show(client, "search_path")).toBe("example");

      await client.query("SET search_path = other");
      await client.query("SET application_name = later");
      await client.query("RESET ALL");
      expect(await show(client, "search_path")).toBe("example");
      expect(await show(client, "application_name")).toBe("boot");
      expect(await currentSchema(client)).toBe("example");
    } finally {
      await client.end();
    }
  });

  test("a parameter sent by name is the reset value as well", async () => {
    const session = await rawStartup(
      { search_path: "example" },
      "SET search_path = other; RESET search_path; SHOW search_path",
    );
    expect(session.rows).toEqual([["example"]]);
  });

  if (oracle) {
    test("RESET, SET ... TO DEFAULT and RESET ALL (PostgreSQL itself)", async () => {
      const client = await connect("-c search_path=example -c application_name=boot", {}, oracle);
      try {
        for (const reset of ["RESET search_path", "SET search_path TO DEFAULT", "RESET ALL"]) {
          await client.query("SET search_path = other; SET application_name = later");
          await client.query(reset);
          expect(await show(client, "search_path")).toBe("example");
        }
        expect(await show(client, "application_name")).toBe("boot");
      } finally {
        await client.end();
      }
    });
  }

  test("without startup settings RESET returns to the built-in default", async () => {
    const client = await connect();
    try {
      await client.query("SET search_path = example");
      await client.query("RESET search_path");
      expect(await show(client, "search_path")).toBe('"$user", public');
    } finally {
      await client.end();
    }
  });
});
