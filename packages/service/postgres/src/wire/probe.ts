import { createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";
import { createConnection } from "node:net";

/** Check startup, authentication and SELECT over the bound wire listener. */
export function probe(connectionString: string): Promise<boolean> {
  const url = new URL(connectionString);
  return new Promise((resolve) => {
    const socket = createConnection({ host: url.hostname, port: Number(url.port) });
    let buffer = Buffer.alloc(0);
    let result = false;
    let querying = false;
    let row = false;
    const nonce = randomBytes(18).toString("base64");
    const first = `n=,r=${nonce}`;
    const finish = (ok: boolean) => {
      result = ok;
      socket.destroy();
    };
    const timeout = setTimeout(() => finish(false), 2000);
    const send = (type: string, body: Buffer) => {
      const header = Buffer.alloc(5);
      header.write(type);
      header.writeInt32BE(body.length + 4, 1);
      socket.write(Buffer.concat([header, body]));
    };
    socket.once("close", () => {
      clearTimeout(timeout);
      resolve(result);
    });
    socket.on("error", () => finish(false));
    socket.once("connect", () => {
      const parameters = Buffer.from(
        `user\0${decodeURIComponent(url.username)}\0database\0${decodeURIComponent(url.pathname.slice(1))}\0\0`,
      );
      const header = Buffer.alloc(8);
      header.writeInt32BE(parameters.length + 8);
      header.writeInt32BE(196608, 4);
      socket.write(Buffer.concat([header, parameters]));
    });
    socket.on("data", (data) => {
      buffer = Buffer.concat([buffer, data]);
      while (buffer.length >= 5) {
        const length = buffer.readInt32BE(1);
        if (length < 4 || length > 1_000_000) {
          finish(false);
          return;
        }
        if (buffer.length < length + 1) return;
        const type = String.fromCharCode(buffer[0] as number);
        const body = buffer.subarray(5, length + 1);
        buffer = buffer.subarray(length + 1);
        if (type === "E") {
          finish(false);
          return;
        }
        if (type === "R") {
          const auth = body.readInt32BE();
          if (auth === 10) {
            const initial = Buffer.from(`n,,${first}`);
            const size = Buffer.alloc(4);
            size.writeInt32BE(initial.length);
            send("p", Buffer.concat([Buffer.from("SCRAM-SHA-256\0"), size, initial]));
          } else if (auth === 11) {
            const serverFirst = body.subarray(4).toString();
            const fields = Object.fromEntries(serverFirst.split(",").map((field) => [field[0], field.slice(2)]));
            if (!fields.r?.startsWith(nonce) || !fields.s || fields.i !== "4096") {
              finish(false);
              return;
            }
            const salted = pbkdf2Sync(
              decodeURIComponent(url.password),
              Buffer.from(fields.s, "base64"),
              4096,
              32,
              "sha256",
            );
            const key = createHmac("sha256", salted).update("Client Key").digest();
            const stored = createHash("sha256").update(key).digest();
            const final = `c=biws,r=${fields.r}`;
            const signature = createHmac("sha256", stored).update(`${first},${serverFirst},${final}`).digest();
            const proof = Buffer.from(key.map((value, index) => value ^ (signature[index] as number)));
            send("p", Buffer.from(`${final},p=${proof.toString("base64")}`));
          } else if (auth !== 0 && auth !== 12) {
            finish(false);
            return;
          }
        }
        if (type === "D") row = body.readInt16BE() === 1 && body.subarray(6).toString() === "1";
        if (type === "Z") {
          if (querying) {
            finish(row);
            return;
          }
          querying = true;
          send("Q", Buffer.from("SELECT 1\0"));
        }
      }
    });
  });
}
