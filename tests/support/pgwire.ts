/**
 * TEST-ONLY minimal PostgreSQL client (wire protocol v3, trust or cleartext/no auth).
 * Exists because this repository must be testable where the `pg` package cannot be installed.
 * When `pg` is installed (normal dev machines and CI), tests use the production adapter instead.
 * Type parsing mirrors node-postgres defaults (see src/server/db/types.ts).
 */
import net from "node:net";
import { withTxRetry, type Db, type Queryable, type QueryResult } from "../../src/server/db/types";

export class PgError extends Error {
  code?: string;
  constraint?: string;
  detail?: string;
  constructor(fields: Record<string, string>) {
    super(fields.M ?? "PostgreSQL error");
    this.code = fields.C;
    this.constraint = fields.n;
    this.detail = fields.D;
  }
}

interface Msg {
  type: string;
  body: Buffer;
}

function cstr(s: string): Buffer {
  return Buffer.concat([Buffer.from(s, "utf8"), Buffer.from([0])]);
}

function frame(type: string, body: Buffer): Buffer {
  const head = Buffer.alloc(5);
  head.write(type, 0, "ascii");
  head.writeInt32BE(body.length + 4, 1);
  return Buffer.concat([head, body]);
}

function int16(n: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeInt16BE(n);
  return b;
}
function int32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeInt32BE(n);
  return b;
}

function serialize(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  if (v instanceof Uint8Array) return `\\x${Buffer.from(v).toString("hex")}`;
  if (typeof v === "boolean") return v ? "t" : "f";
  if (Array.isArray(v)) {
    return `{${v.map((x) => (x === null ? "NULL" : `"${String(serialize(x)).replace(/["\\]/g, "\\$&")}"`)).join(",")}}`;
  }
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

function parseValue(oid: number, text: string): unknown {
  switch (oid) {
    case 16:
      return text === "t";
    case 21:
    case 23:
    case 26:
    case 700:
    case 701:
      return Number(text);
    case 17:
      return Buffer.from(text.slice(2), "hex");
    case 114:
    case 3802:
      return JSON.parse(text);
    case 1114:
      return new Date(text.replace(" ", "T") + "Z");
    case 1184:
      return new Date(text.replace(" ", "T").replace(/([+-]\d\d)$/, "$1:00"));
    default:
      return text; // int8, numeric, text, date, uuid ...
  }
}

class Connection {
  private sock!: net.Socket;
  private buf = Buffer.alloc(0);
  private queue: Msg[] = [];
  private waiter: ((m: Msg) => void) | null = null;
  private closedErr: Error | null = null;

  async connect(url: URL): Promise<void> {
    this.sock = net.connect({ host: url.hostname, port: Number(url.port || 5432) });
    this.sock.on("data", (d: Buffer) => this.onData(d));
    this.sock.on("error", (e) => (this.closedErr = e));
    await new Promise<void>((res, rej) => {
      this.sock.once("connect", () => res());
      this.sock.once("error", rej);
    });
    const params = Buffer.concat([
      int32(196608),
      cstr("user"),
      cstr(decodeURIComponent(url.username || "postgres")),
      cstr("database"),
      cstr(url.pathname.slice(1) || "postgres"),
      cstr("client_encoding"),
      cstr("UTF8"),
      Buffer.from([0]),
    ]);
    this.sock.write(Buffer.concat([int32(params.length + 4), params]));
    for (;;) {
      const m = await this.next();
      if (m.type === "R") {
        const kind = m.body.readInt32BE(0);
        if (kind === 3) this.sock.write(frame("p", cstr(decodeURIComponent(url.password))));
        else if (kind !== 0) throw new Error(`Unsupported auth method ${kind} (test client supports trust/cleartext)`);
      } else if (m.type === "E") throw new PgError(this.fields(m.body));
      else if (m.type === "Z") return;
    }
  }

  private onData(d: Buffer) {
    this.buf = Buffer.concat([this.buf, d]);
    while (this.buf.length >= 5) {
      const len = this.buf.readInt32BE(1);
      if (this.buf.length < len + 1) break;
      const msg = { type: String.fromCharCode(this.buf[0]!), body: this.buf.subarray(5, len + 1) };
      this.buf = this.buf.subarray(len + 1);
      if (this.waiter) {
        const w = this.waiter;
        this.waiter = null;
        w(msg);
      } else this.queue.push(msg);
    }
  }

  private next(): Promise<Msg> {
    if (this.closedErr) return Promise.reject(this.closedErr);
    const m = this.queue.shift();
    if (m) return Promise.resolve(m);
    return new Promise((res) => (this.waiter = res));
  }

  private fields(body: Buffer): Record<string, string> {
    const out: Record<string, string> = {};
    let i = 0;
    while (i < body.length && body[i] !== 0) {
      const k = String.fromCharCode(body[i]!);
      const end = body.indexOf(0, i + 1);
      out[k] = body.subarray(i + 1, end).toString("utf8");
      i = end + 1;
    }
    return out;
  }

  async query<T>(text: string, params?: readonly unknown[]): Promise<QueryResult<T>> {
    if (params === undefined) {
      this.sock.write(frame("Q", cstr(text)));
    } else {
      const vals = params.map(serialize);
      const bind = Buffer.concat([
        cstr(""),
        cstr(""),
        int16(0),
        int16(vals.length),
        ...vals.map((v) => (v === null ? int32(-1) : Buffer.concat([int32(Buffer.byteLength(v)), Buffer.from(v, "utf8")]))),
        int16(0),
      ]);
      this.sock.write(
        Buffer.concat([
          frame("P", Buffer.concat([cstr(""), cstr(text), int16(0)])),
          frame("B", bind),
          frame("D", Buffer.concat([Buffer.from("P"), cstr("")])),
          frame("E", Buffer.concat([cstr(""), int32(0)])),
          frame("S", Buffer.alloc(0)),
        ]),
      );
    }
    let cols: { name: string; oid: number }[] = [];
    let rows: T[] = [];
    let rowCount = 0;
    let error: PgError | null = null;
    for (;;) {
      const m = await this.next();
      switch (m.type) {
        case "T": {
          const n = m.body.readInt16BE(0);
          let i = 2;
          cols = [];
          rows = [];
          for (let c = 0; c < n; c++) {
            const end = m.body.indexOf(0, i);
            const name = m.body.subarray(i, end).toString("utf8");
            i = end + 1;
            const oid = m.body.readInt32BE(i + 6);
            i += 18;
            cols.push({ name, oid });
          }
          break;
        }
        case "D": {
          const n = m.body.readInt16BE(0);
          let i = 2;
          const row: Record<string, unknown> = {};
          for (let c = 0; c < n; c++) {
            const len = m.body.readInt32BE(i);
            i += 4;
            const col = cols[c]!;
            if (len === -1) row[col.name] = null;
            else {
              row[col.name] = parseValue(col.oid, m.body.subarray(i, i + len).toString("utf8"));
              i += len;
            }
          }
          rows.push(row as T);
          break;
        }
        case "C": {
          const tag = m.body.subarray(0, m.body.length - 1).toString();
          const num = Number(tag.split(" ").pop());
          rowCount = Number.isFinite(num) ? num : 0;
          break;
        }
        case "E":
          error = new PgError(this.fields(m.body));
          break;
        case "Z":
          if (error) throw error;
          return { rows, rowCount };
        default:
          break; // 1, 2, n, N, S, I ...
      }
    }
  }

  close() {
    this.sock.end(frame("X", Buffer.alloc(0)));
  }
}

/** Db implementation over the test client, with a simple connection pool. */
export function createWireDb(connectionString: string): Db {
  const url = new URL(connectionString);
  const idle: Connection[] = [];
  const all: Connection[] = [];
  async function acquire(): Promise<Connection> {
    const c = idle.pop();
    if (c) return c;
    const n = new Connection();
    await n.connect(url);
    all.push(n);
    return n;
  }
  async function withConn<T>(fn: (c: Connection) => Promise<T>): Promise<T> {
    const c = await acquire();
    try {
      return await fn(c);
    } finally {
      idle.push(c);
    }
  }
  return {
    query: <T>(text: string, params?: readonly unknown[]) => withConn((c) => c.query<T>(text, params)),
    tx: <T>(fn: (q: Queryable) => Promise<T>) =>
      withTxRetry(() =>
        withConn(async (c) => {
          await c.query("BEGIN");
          try {
            await c.query("SET LOCAL lock_timeout = '5s'");
            const result = await fn({ query: (t, p) => c.query(t, p) });
            await c.query("COMMIT");
            return result;
          } catch (err) {
            await c.query("ROLLBACK").catch(() => undefined);
            throw err;
          }
        }),
      ),
    async end() {
      for (const c of all) c.close();
    },
  };
}
