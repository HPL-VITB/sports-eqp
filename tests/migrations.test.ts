import assert from "node:assert/strict";
import { cp, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { runMigrations } from "../src/server/db/migrate";
import { setupTestEnv, type TestEnv } from "./support/harness";

let env: TestEnv;
before(async () => (env = await setupTestEnv()));
after(async () => env.close());

test("migrations apply once and are idempotent", async () => {
  const again = await runMigrations(env.ctx.db, path.resolve("db/migrations"));
  assert.deepEqual(again.applied, []);
  assert.ok(again.alreadyApplied.includes("0001_foundation"));
});

test("an edited, already-applied migration is refused", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mig-"));
  await cp(path.resolve("db/migrations"), dir, { recursive: true });
  await writeFile(path.join(dir, "0001_foundation.sql"), "-- tampered\n", { flag: "a" });
  await assert.rejects(runMigrations(env.ctx.db, dir), /was changed after it was applied/);
});

test("audit_log is append-only at the database level", async () => {
  await env.ctx.db.query("INSERT INTO audit_log (action, entity) VALUES ('test', 'test')");
  await assert.rejects(env.ctx.db.query("UPDATE audit_log SET action = 'x'"), /append-only/);
  await assert.rejects(env.ctx.db.query("DELETE FROM audit_log"), /append-only/);
});

test("database rejects invalid roles, upper-case emails and incomplete 'complete' profiles", async () => {
  await assert.rejects(env.ctx.db.query("INSERT INTO users (email, role) VALUES ('a@vitbhopal.ac.in', 'ADMIN')"), /users_role_valid/);
  await assert.rejects(env.ctx.db.query("INSERT INTO users (email) VALUES ('A@vitbhopal.ac.in')"), /users_email_lower/);
  await assert.rejects(
    env.ctx.db.query("INSERT INTO users (email, profile_completed_at) VALUES ('b@vitbhopal.ac.in', now())"),
    /users_profile_complete/,
  );
});
