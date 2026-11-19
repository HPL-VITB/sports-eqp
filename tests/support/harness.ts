/**
 * Each test file gets a brand-new PostgreSQL database with all migrations applied, dropped afterwards.
 * Set TEST_DATABASE_URL to a server you can CREATE DATABASE on (default: local trust server on :54329).
 */
import { randomBytes } from "node:crypto";
import path from "node:path";
import { loadConfig } from "../../src/server/config";
import type { AppContext } from "../../src/server/context";
import { runMigrations } from "../../src/server/db/migrate";
import type { Db } from "../../src/server/db/types";
import type { Mailer, OutgoingEmail } from "../../src/server/email/mailer";
import { createSession } from "../../src/server/auth/sessions";
import type { Role } from "../../src/server/auth/permissions";

const ADMIN_URL = process.env.TEST_DATABASE_URL ?? "postgres://postgres@127.0.0.1:54329/postgres";

async function openDb(url: string): Promise<Db> {
  try {
    const mod = (await import("pg" as string)) as unknown;
    if (mod) {
      const { createPgDb } = await import("../../src/server/db/pg" as string);
      return createPgDb(url, 20) as Db;
    }
  } catch {
    /* pg not installed: fall back to the test wire client */
  }
  const { createWireDb } = await import("./pgwire");
  return createWireDb(url);
}

export class MemoryMailer implements Mailer {
  sent: OutgoingEmail[] = [];
  failNext = false;
  async send(msg: OutgoingEmail) {
    if (this.failNext) {
      this.failNext = false;
      throw new Error("SMTP refused (simulated)");
    }
    this.sent.push(msg);
    return { messageId: `mem-${this.sent.length}` };
  }
  lastCodeFor(email: string): string {
    const m = [...this.sent].reverse().find((x) => x.to === email);
    const code = m?.text.match(/\b(\d{6})\b/)?.[1];
    if (!code) throw new Error(`No code emailed to ${email}`);
    return code;
  }
}

export interface TestEnv {
  ctx: AppContext;
  mailer: MemoryMailer;
  clock: { now: Date; advance(ms: number): void };
  url: string;
  close(): Promise<void>;
}

export async function setupTestEnv(overrides: Record<string, string> = {}): Promise<TestEnv> {
  const name = `sei_test_${randomBytes(4).toString("hex")}`;
  const admin = await openDb(ADMIN_URL);
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(ADMIN_URL);
  url.pathname = `/${name}`;
  const db = await openDb(url.toString());
  await runMigrations(db, path.resolve("db/migrations"));

  const config = loadConfig({
    NODE_ENV: "test",
    DATABASE_URL: url.toString(),
    APP_ORIGIN: "https://sports-eqp-issue.hplvitbhopal.site",
    OTP_HMAC_SECRET: "test-secret-test-secret-test-secret-123",
    ALLOWED_EMAIL_DOMAINS: "vitbhopal.ac.in",
    MAIL_TRANSPORT: "console",
    CRON_SECRET: "cron-test-secret",
    ...overrides,
  });
  const mailer = new MemoryMailer();
  const clock = {
    now: new Date("2026-11-17T04:30:00Z"),
    advance(ms: number) {
      this.now = new Date(this.now.getTime() + ms);
    },
  };
  const ctx: AppContext = { db, config, mailer, now: () => clock.now };
  return {
    ctx,
    mailer,
    clock,
    url: url.toString(),
    async close() {
      await db.end();
      await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await admin.end();
    },
  };
}

let seq = 0;
/** Inserts a user with a completed profile and returns it with a valid session token. */
export async function makeUser(env: TestEnv, role: Role, opts: { email?: string; active?: boolean; profile?: boolean } = {}) {
  seq += 1;
  const email = opts.email ?? `${role.toLowerCase()}${seq}.${randomBytes(2).toString("hex")}@vitbhopal.ac.in`;
  const complete = opts.profile ?? true;
  const res = await env.ctx.db.query<{ id: string }>(
    `INSERT INTO users (email, name, univ_id, category, role, is_active, profile_completed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [
      email,
      complete ? `Test ${role} ${seq}` : null,
      complete ? `EMP${String(seq).padStart(4, "0")}${randomBytes(2).toString("hex").toUpperCase()}` : null,
      complete ? "STAFF" : null,
      role,
      opts.active ?? true,
      complete ? env.clock.now : null,
    ],
  );
  const id = res.rows[0]!.id;
  const token = await createSession(env.ctx.db, id, { ip: "10.0.0.1", userAgent: "test" }, env.clock.now);
  return { id, email, token };
}

export const ORIGIN = "https://sports-eqp-issue.hplvitbhopal.site";

export function req(
  method: string,
  pathname: string,
  opts: { token?: string; body?: unknown; origin?: string | null; headers?: Record<string, string> } = {},
): Request {
  const headers: Record<string, string> = { "x-forwarded-for": "203.0.113.7", ...opts.headers };
  if (opts.token) headers.cookie = `__Host-sei_session=${opts.token}`;
  if (opts.origin !== null && method !== "GET") headers.origin = opts.origin ?? ORIGIN;
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  return new Request(ORIGIN + pathname, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
}
