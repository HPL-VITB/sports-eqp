import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import {
  listAuditHandler,
  listUsersHandler,
  logoutHandler,
  meHandler,
  purgeHandler,
  requestOtpHandler,
  updateProfileHandler,
  updateUserHandler,
  verifyOtpHandler,
} from "../src/server/http/handlers";
import { makeUser, req, setupTestEnv, type TestEnv } from "./support/harness";

let env: TestEnv;
before(async () => (env = await setupTestEnv()));
after(async () => env.close());

async function body(res: Response) {
  return (await res.json()) as { error?: { code: string; message: string }; [k: string]: unknown };
}

test("sign-in over HTTP sets a secure, HttpOnly, SameSite cookie and /api/me works", async () => {
  const email = "web.user@vitbhopal.ac.in";
  const r1 = await requestOtpHandler(env.ctx, req("POST", "/api/auth/request-otp", { body: { email } }));
  assert.equal(r1.status, 200);
  const code = env.mailer.lastCodeFor(email);
  const r2 = await verifyOtpHandler(env.ctx, req("POST", "/api/auth/verify-otp", { body: { email, code } }));
  assert.equal(r2.status, 200);
  assert.equal((await r2.clone().json()).home, "/profile");
  const cookie = r2.headers.get("set-cookie")!;
  assert.match(cookie, /^__Host-sei_session=[A-Za-z0-9_-]{43};/);
  for (const attr of ["Path=/", "HttpOnly", "SameSite=Lax", "Secure"]) assert.ok(cookie.includes(attr), attr);
  const token = cookie.split(";")[0]!.split("=")[1]!;

  const me = await meHandler(env.ctx, req("GET", "/api/me", { token }));
  const meBody = await body(me);
  assert.equal(me.status, 200);
  assert.equal((meBody.user as { profileComplete: boolean }).profileComplete, false);

  // Incomplete profile: everything except /api/me and the profile form is refused.
  const blocked = await listUsersHandler(env.ctx, req("GET", "/api/admin/users", { token }));
  assert.equal((await body(blocked)).error?.code, "PROFILE_INCOMPLETE");

  const prof = await updateProfileHandler(
    env.ctx,
    req("PATCH", "/api/me/profile", { token, body: { name: "Web User", univId: "24MIM10001", category: "STAFF" } }),
  );
  assert.equal(prof.status, 200);

  const out = await logoutHandler(env.ctx, req("POST", "/api/auth/logout", { token }));
  assert.match(out.headers.get("set-cookie")!, /Max-Age=0/);
  assert.equal((await meHandler(env.ctx, req("GET", "/api/me", { token }))).status, 401);
});

test("cross-site requests are refused (CSRF)", async () => {
  const fr = await makeUser(env, "FR_SPORTS");
  const target = await makeUser(env, "RECIPIENT");
  const evil = await updateUserHandler(
    env.ctx,
    req("PATCH", `/api/admin/users/${target.id}`, { token: fr.token, origin: "https://evil.example", body: { role: "FR_SPORTS" } }),
    target.id,
  );
  assert.equal(evil.status, 403);
  assert.equal((await body(evil)).error?.code, "BAD_ORIGIN");
  const noOrigin = await updateUserHandler(
    env.ctx,
    req("PATCH", `/api/admin/users/${target.id}`, { token: fr.token, origin: null, body: { role: "FR_SPORTS" } }),
    target.id,
  );
  assert.equal(noOrigin.status, 403);
  const row = await env.ctx.db.query<{ role: string }>("SELECT role FROM users WHERE id = $1", [target.id]);
  assert.equal(row.rows[0]!.role, "RECIPIENT");
});

test("every non-FR role gets 403 from user administration when calling the API directly", async () => {
  const victim = await makeUser(env, "RECIPIENT");
  for (const role of ["ASO", "STOREKEEPER", "PROCUREMENT", "MANAGEMENT", "RECIPIENT"] as const) {
    const u = await makeUser(env, role);
    const list = await listUsersHandler(env.ctx, req("GET", "/api/admin/users", { token: u.token }));
    assert.equal(list.status, 403, `${role} list`);
    const patch = await updateUserHandler(
      env.ctx,
      req("PATCH", `/api/admin/users/${victim.id}`, { token: u.token, body: { role: "FR_SPORTS" } }),
      victim.id,
    );
    assert.equal(patch.status, 403, `${role} patch`);
  }
  const fr = await makeUser(env, "FR_SPORTS");
  assert.equal((await listUsersHandler(env.ctx, req("GET", "/api/admin/users", { token: fr.token }))).status, 200);
  const ok = await updateUserHandler(
    env.ctx,
    req("PATCH", `/api/admin/users/${victim.id}`, { token: fr.token, body: { role: "STOREKEEPER" } }),
    victim.id,
  );
  assert.equal(ok.status, 200);
});

test("audit log: FR Sports and management can read it, others cannot", async () => {
  for (const [role, status] of [["FR_SPORTS", 200], ["MANAGEMENT", 200], ["ASO", 403], ["RECIPIENT", 403]] as const) {
    const u = await makeUser(env, role);
    const res = await listAuditHandler(env.ctx, req("GET", "/api/admin/audit", { token: u.token }));
    assert.equal(res.status, status, role);
  }
});

test("no cookie -> 401; malformed input -> 400 with a readable message", async () => {
  assert.equal((await listUsersHandler(env.ctx, req("GET", "/api/admin/users"))).status, 401);
  const bad = await requestOtpHandler(
    env.ctx,
    new Request("https://sports-eqp-issue.hplvitbhopal.site/api/auth/request-otp", {
      method: "POST",
      headers: { origin: "https://sports-eqp-issue.hplvitbhopal.site", "content-type": "application/json" },
      body: "{not json",
    }),
  );
  assert.equal(bad.status, 400);
  assert.equal((await body(bad)).error?.code, "BAD_JSON");
  const wrongDomain = await requestOtpHandler(env.ctx, req("POST", "/api/auth/request-otp", { body: { email: "a@gmail.com" } }));
  assert.equal((await body(wrongDomain)).error?.message, "Use your @vitbhopal.ac.in email address.");
});

test("rate-limited responses carry Retry-After", async () => {
  const email = "rl.user@vitbhopal.ac.in";
  await requestOtpHandler(env.ctx, req("POST", "/api/auth/request-otp", { body: { email } }));
  const second = await requestOtpHandler(env.ctx, req("POST", "/api/auth/request-otp", { body: { email } }));
  assert.equal(second.status, 429);
  assert.ok(Number(second.headers.get("retry-after")) > 0);
});

test("cron endpoint requires the shared secret", async () => {
  assert.equal((await purgeHandler(env.ctx, req("GET", "/api/cron/purge"))).status, 401);
  const ok = await purgeHandler(env.ctx, req("GET", "/api/cron/purge", { headers: { authorization: "Bearer cron-test-secret" } }));
  assert.equal(ok.status, 200);
});

test("the admin mailbox fr.sports@ becomes FR Sports on sign-in and goes straight to the dashboard", async () => {
  const email = "fr.sports@vitbhopal.ac.in";
  await requestOtpHandler(env.ctx, req("POST", "/api/auth/request-otp", { body: { email } }));
  const code = env.mailer.lastCodeFor(email);
  const r = await verifyOtpHandler(env.ctx, req("POST", "/api/auth/verify-otp", { body: { email, code } }));
  assert.equal(r.status, 200);
  const b = (await r.json()) as { home: string; user: { role: string } };
  assert.equal(b.user.role, "FR_SPORTS");
  assert.equal(b.home, "/dashboard");
  const token = r.headers.get("set-cookie")!.split(";")[0]!.split("=")[1]!;
  // No profile form in the way for the shared admin mailbox.
  assert.equal((await listUsersHandler(env.ctx, req("GET", "/api/admin/users", { token }))).status, 200);
});
