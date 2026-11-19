import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { after, before, test } from "node:test";
import { loadConfig } from "../src/server/config";
import { EXPECTED_SCHEMA_VERSION } from "../src/server/db/schema-version";
import { assertCronSecret } from "../src/server/http/handlers";
import { healthHandler } from "../src/server/http/health-handlers";
import { req, setupTestEnv, type TestEnv } from "./support/harness";

let env: TestEnv;
before(async () => { env = await setupTestEnv(); });
after(async () => env.close());

test("the build's expected schema version is the newest migration file", () => {
  const newest = readdirSync("db/migrations").filter((f) => /^\d{4}_/.test(f)).sort().at(-1)!.slice(0, 4);
  assert.equal(EXPECTED_SCHEMA_VERSION, newest);
});

test("health: ok when the schema is current, 503 when the database is behind, nothing else revealed", async () => {
  const ok = await healthHandler(env.ctx, req("GET", "/api/health"));
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { status: "ok", database: "up", schema: "current" });
  assert.equal(ok.headers.get("cache-control"), "no-store");
  const row = (await env.ctx.db.query("SELECT version, checksum FROM schema_migrations WHERE left(version, 4) = $1", [EXPECTED_SCHEMA_VERSION])).rows[0] as { version: string; checksum: string };
  await env.ctx.db.query("DELETE FROM schema_migrations WHERE version = $1", [row.version]);
  try {
    const behind = await healthHandler(env.ctx, req("GET", "/api/health"));
    assert.equal(behind.status, 503);
    assert.equal(((await behind.json()) as { schema: string }).schema, "behind");
  } finally {
    await env.ctx.db.query("INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)", [row.version, row.checksum]);
  }
  const broken = { ...env.ctx, db: { ...env.ctx.db, query: async () => { throw new Error("connection refused at 10.1.2.3"); } } };
  const down = await healthHandler(broken as never, req("GET", "/api/health"));
  assert.equal(down.status, 503);
  const text = await down.text();
  assert.ok(!text.includes("10.1.2.3"), "internal error details are not exposed");
});

test("production configuration refuses weak or example secrets and missing job secret", () => {
  const base = {
    NODE_ENV: "production", DATABASE_URL: "postgres://x", APP_ORIGIN: "https://sports-eqp-issue.hplvitbhopal.site",
    OTP_HMAC_SECRET: "k".repeat(48), MAIL_TRANSPORT: "smtp", SMTP_HOST: "smtp.gmail.com", SMTP_USER: "a@vitbhopal.ac.in", SMTP_PASS: "p",
    CRON_SECRET: "c".repeat(32),
  };
  assert.doesNotThrow(() => loadConfig(base));
  assert.throws(() => loadConfig({ ...base, CRON_SECRET: undefined }), /CRON_SECRET/);
  assert.throws(() => loadConfig({ ...base, CRON_SECRET: "short" }), /CRON_SECRET/);
  assert.throws(() => loadConfig({ ...base, OTP_HMAC_SECRET: "change-me-to-a-long-random-string-of-48-characters" }), /example value/);
  assert.throws(() => loadConfig({ ...base, MAIL_TRANSPORT: "console" }), /console mail/);
  assert.throws(() => loadConfig({ ...base, APP_ORIGIN: "http://sports-eqp-issue.hplvitbhopal.site" }), /https/);
  assert.doesNotThrow(() => loadConfig({ ...base, NODE_ENV: "development", CRON_SECRET: undefined }), "development stays easy");
});

test("scheduled-job secret: exact match only (wrong, shorter, longer, missing all refused)", () => {
  const ctx = env.ctx; // CRON_SECRET = "cron-test-secret"
  const call = (h?: string) => assertCronSecret(ctx, req("GET", "/api/cron/dispatch", { headers: h ? { authorization: h } : {} }));
  assert.doesNotThrow(() => call("Bearer cron-test-secret"));
  for (const h of ["Bearer cron-test-secreT", "Bearer cron-test-secre", "cron-test-secret", undefined]) {
    assert.throws(() => call(h), /Invalid job credentials/, String(h));
  }
});
