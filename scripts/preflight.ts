/**
 * Go-live check. Run with the PRODUCTION environment variables before opening the portal to users, and again after any
 * change to secrets, the database or the mail account. Changes nothing except: --migrate applies pending migrations, and
 * --send-test sends one email.
 *
 *   npm run preflight
 *   npm run preflight -- --migrate --send-test your.name@vitbhopal.ac.in
 *
 * Exit code 0 only if every check passes.
 */
import path from "node:path";
import { loadConfig } from "../src/server/config";
import { createPgDb } from "../src/server/db/pg";
import { runMigrations } from "../src/server/db/migrate";
import { EXPECTED_SCHEMA_VERSION } from "../src/server/db/schema-version";
import { SmtpMailer } from "../src/server/email/smtp";

const args = process.argv.slice(2);
const testTo = args.includes("--send-test") ? args[args.indexOf("--send-test") + 1] : undefined;
let failed = 0;
const pass = (m: string) => console.log(`  PASS  ${m}`);
const fail = (m: string, hint?: string) => { failed++; console.log(`  FAIL  ${m}${hint ? `\n        → ${hint}` : ""}`); };
const warn = (m: string) => console.log(`  WARN  ${m}`);

console.log("Sports Equipment Portal — preflight\n");
let config;
try {
  config = loadConfig({ ...process.env, NODE_ENV: "production" });
  pass(`configuration valid for production (origin ${config.APP_ORIGIN}, sign-in domain ${config.ALLOWED_EMAIL_DOMAINS.join(", ")})`);
} catch (e) {
  fail("configuration", (e as Error).message);
  process.exit(1);
}
if (!/pooler|pgbouncer/i.test(config.DATABASE_URL)) warn("DATABASE_URL does not look like a pooled (Neon -pooler) connection string; use the pooled one on Vercel");

const db = createPgDb(config.DATABASE_URL, 1);
try {
  const v = await db.query<{ v: string }>("SELECT current_setting('server_version') AS v");
  pass(`database reachable (PostgreSQL ${v.rows[0]!.v})`);
  if (args.includes("--migrate")) {
    const r = await runMigrations(db, path.resolve("db/migrations"));
    pass(`migrations: ${r.applied.length ? `applied ${r.applied.join(", ")}` : "nothing to apply"}`);
  }
  const s = await db.query<{ v: string | null }>("SELECT left(max(version), 4) AS v FROM schema_migrations").catch(() => ({ rows: [{ v: null }] }));
  const cur = s.rows[0]?.v ?? null;
  if (cur === EXPECTED_SCHEMA_VERSION) pass(`database schema current (${cur})`);
  else fail(`database schema is ${cur ?? "empty"}, this build expects ${EXPECTED_SCHEMA_VERSION}`, "run: npm run preflight -- --migrate");
  if (cur) {
    const admins = await db.query<{ n: number }>("SELECT count(*)::int n FROM users WHERE role = 'FR_SPORTS' AND is_active");
    if (admins.rows[0]!.n > 0) pass(`${admins.rows[0]!.n} active FR Sports administrator(s)`);
    else fail("no active FR Sports administrator", 'run: npm run admin:create -- name@vitbhopal.ac.in "Full Name"');
    const mism = await db.query<{ n: number }>("SELECT count(*)::int n FROM stock_ledger_mismatches").catch(() => null);
    if (mism) mism.rows[0]!.n === 0 ? pass("stock balances agree with the movement history") : fail(`${mism.rows[0]!.n} item(s) where balances and history disagree`, "do not open to users; contact the maintainer");
  }
} catch (e) {
  fail("database", (e as Error).message);
} finally {
  await db.end();
}

const mailer = new SmtpMailer(config);
try {
  await mailer.verify();
  pass(`mail server accepted sign-in (${config.SMTP_HOST}:${config.SMTP_PORT} as ${config.SMTP_USER})`);
  if (testTo) {
    const r = await mailer.send({
      to: testTo,
      subject: "Sports Equipment Portal — test email",
      text: "This is a test from the portal's preflight check. If you can read this, sign-in codes and issue emails will reach university inboxes.",
    });
    pass(`test email accepted by the mail server for ${testTo} (id ${r.messageId}) — check that it arrived and is not in spam`);
  } else warn("no test email sent; add --send-test your.name@vitbhopal.ac.in");
} catch (e) {
  fail("mail server", `${(e as Error).message} — for smtp.gmail.com use an app password (2-Step Verification must be on); for smtp-relay.gmail.com the relay must allow SMTP AUTH`);
}

try {
  const res = await fetch(`${config.APP_ORIGIN}/api/health`, { signal: AbortSignal.timeout(15_000) });
  const body = (await res.json().catch(() => ({}))) as { status?: string; schema?: string };
  if (res.ok && body.status === "ok") pass(`${config.APP_ORIGIN}/api/health responds ok`);
  else fail(`${config.APP_ORIGIN}/api/health returned ${res.status} ${JSON.stringify(body)}`);
  const hsts = res.headers.get("strict-transport-security");
  hsts ? pass("security headers present") : warn("Strict-Transport-Security header missing on the live site");
} catch (e) {
  warn(`could not reach ${config.APP_ORIGIN} (${(e as Error).message}); fine before the first deployment, required after`);
}

console.log(failed ? `\n${failed} check(s) failed.` : "\nAll checks passed.");
process.exit(failed ? 1 : 0);
