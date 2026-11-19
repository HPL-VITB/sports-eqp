import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { purgeExpired, requestOtp, verifyOtp } from "../src/server/auth/otp";
import { getSessionUser, revokeSession } from "../src/server/auth/sessions";
import { AppError } from "../src/server/errors";
import { makeUser, setupTestEnv, type TestEnv } from "./support/harness";

let env: TestEnv;
before(async () => (env = await setupTestEnv()));
after(async () => env.close());

const MIN = 60_000;
let n = 0;
const freshEmail = () => `student${++n}@vitbhopal.ac.in`;
const ip = () => `198.51.100.${n % 250}`;

async function rejectsWith(p: Promise<unknown>, code: string) {
  await assert.rejects(p, (e: unknown) => e instanceof AppError && e.code === code);
}

test("only vitbhopal.ac.in addresses can request a code", async () => {
  await rejectsWith(requestOtp(env.ctx, { email: "someone@gmail.com", ip: "1.1.1.1" }), "EMAIL_DOMAIN");
  await rejectsWith(requestOtp(env.ctx, { email: "x@sub.vitbhopal.ac.in", ip: "1.1.1.1" }), "EMAIL_DOMAIN");
  await rejectsWith(requestOtp(env.ctx, { email: "not-an-email", ip: "1.1.1.1" }), "EMAIL_INVALID");
});

test("full sign-in: code emailed, verified, recipient account created, session works", async () => {
  const email = freshEmail();
  const r = await requestOtp(env.ctx, { email: `  ${email.toUpperCase()} `, ip: ip() });
  assert.equal(r.sent, true);
  const code = env.mailer.lastCodeFor(email);
  assert.match(code, /^\d{6}$/);
  const stored = await env.ctx.db.query<{ code_hash: string }>("SELECT code_hash FROM otp_challenges WHERE email = $1", [email]);
  assert.ok(!stored.rows[0]!.code_hash.includes(code), "code is stored only as a hash");

  const { user, token } = await verifyOtp(env.ctx, { email, code, ip: ip(), userAgent: "t" });
  assert.equal(user.role, "RECIPIENT");
  assert.equal(user.profile_completed_at, null);
  const sessionUser = await getSessionUser(env.ctx, token);
  assert.equal(sessionUser?.id, user.id);
  const audit = await env.ctx.db.query("SELECT 1 FROM audit_log WHERE action = 'auth.login' AND entity_id = $1", [user.id]);
  assert.equal(audit.rowCount, 1);
});

test("a code works once only", async () => {
  const email = freshEmail();
  await requestOtp(env.ctx, { email, ip: ip() });
  const code = env.mailer.lastCodeFor(email);
  await verifyOtp(env.ctx, { email, code, ip: ip(), userAgent: null });
  await rejectsWith(verifyOtp(env.ctx, { email, code, ip: ip(), userAgent: null }), "OTP_INVALID");
});

test("five wrong attempts lock the code, even the correct one afterwards", async () => {
  const email = freshEmail();
  await requestOtp(env.ctx, { email, ip: ip() });
  const code = env.mailer.lastCodeFor(email);
  const wrong = code === "000000" ? "111111" : "000000";
  for (let i = 4; i >= 1; i--) {
    await assert.rejects(verifyOtp(env.ctx, { email, code: wrong, ip: ip(), userAgent: null }), (e: unknown) => {
      return e instanceof AppError && e.code === "OTP_WRONG" && e.extra.attemptsLeft === i;
    });
  }
  await rejectsWith(verifyOtp(env.ctx, { email, code: wrong, ip: ip(), userAgent: null }), "OTP_LOCKED");
  await rejectsWith(verifyOtp(env.ctx, { email, code, ip: ip(), userAgent: null }), "OTP_LOCKED");
});

test("codes expire after 10 minutes", async () => {
  const email = freshEmail();
  await requestOtp(env.ctx, { email, ip: ip() });
  const code = env.mailer.lastCodeFor(email);
  env.clock.advance(10 * MIN + 1000);
  await rejectsWith(verifyOtp(env.ctx, { email, code, ip: ip(), userAgent: null }), "OTP_INVALID");
});

test("resend cooldown of 60 s; a new code replaces the old one", async () => {
  const email = freshEmail();
  await requestOtp(env.ctx, { email, ip: ip() });
  const first = env.mailer.lastCodeFor(email);
  await assert.rejects(requestOtp(env.ctx, { email, ip: ip() }), (e: unknown) => {
    return e instanceof AppError && e.status === 429 && typeof e.extra.retryAfterSec === "number";
  });
  env.clock.advance(61_000);
  await requestOtp(env.ctx, { email, ip: ip() });
  const second = env.mailer.lastCodeFor(email);
  if (first !== second) {
    await rejectsWith(verifyOtp(env.ctx, { email, code: first, ip: ip(), userAgent: null }), "OTP_WRONG");
  }
  const ok = await verifyOtp(env.ctx, { email, code: second, ip: ip(), userAgent: null });
  assert.ok(ok.token);
});

test("at most 5 codes per email per hour", async () => {
  // Align to the start of an hour window so the six requests share one window.
  const t = env.clock.now.getTime();
  env.clock.advance(3600_000 - (t % 3600_000) + 1000);
  const email = freshEmail();
  for (let i = 0; i < 5; i++) {
    await requestOtp(env.ctx, { email, ip: `192.0.2.${i}` });
    env.clock.advance(61_000);
  }
  await assert.rejects(requestOtp(env.ctx, { email, ip: "192.0.2.99" }), (e: unknown) => e instanceof AppError && e.status === 429);
});

test("simultaneous code requests for one email send exactly one code", async () => {
  const email = freshEmail();
  const before = env.mailer.sent.length;
  const results = await Promise.allSettled(
    Array.from({ length: 8 }, (_, i) => requestOtp(env.ctx, { email, ip: i % 2 ? null : `203.0.113.${i}` })),
  );
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(env.mailer.sent.length - before, 1);
});

test("email failure returns a clear error and does not start the cooldown", async () => {
  const email = freshEmail();
  env.mailer.failNext = true;
  await rejectsWith(requestOtp(env.ctx, { email, ip: ip() }), "EMAIL_FAILED");
  const r = await requestOtp(env.ctx, { email, ip: ip() });
  assert.equal(r.sent, true);
});

test("submitting the correct code twice at the same moment creates one session", async () => {
  const email = freshEmail();
  await requestOtp(env.ctx, { email, ip: ip() });
  const code = env.mailer.lastCodeFor(email);
  const results = await Promise.allSettled(
    Array.from({ length: 5 }, (_, i) => verifyOtp(env.ctx, { email, code, ip: i % 2 ? null : `203.0.114.${i}`, userAgent: null })),
  );
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  const sessions = await env.ctx.db.query("SELECT 1 FROM sessions s JOIN users u ON u.id = s.user_id WHERE u.email = $1", [email]);
  assert.equal(sessions.rowCount, 1);
});

test("deactivated accounts cannot sign in", async () => {
  const u = await makeUser(env, "STOREKEEPER", { active: false });
  env.clock.advance(61_000);
  await requestOtp(env.ctx, { email: u.email, ip: ip() });
  await rejectsWith(verifyOtp(env.ctx, { email: u.email, code: env.mailer.lastCodeFor(u.email), ip: ip(), userAgent: null }), "ACCOUNT_DISABLED");
  assert.equal(await getSessionUser(env.ctx, u.token), null, "existing sessions of inactive users are refused");
});

test("idle timeouts: staff 12 hours, recipients 7 days; logout revokes", async () => {
  const staff = await makeUser(env, "ASO");
  const student = await makeUser(env, "RECIPIENT");
  env.clock.advance(11 * 3600_000);
  assert.ok(await getSessionUser(env.ctx, staff.token), "staff still signed in after 11 h");
  env.clock.advance(12 * 3600_000 + 1000);
  assert.equal(await getSessionUser(env.ctx, staff.token), null, "staff signed out after 12 idle hours");
  assert.ok(await getSessionUser(env.ctx, student.token), "recipient still signed in after ~23 h");
  env.clock.advance(7 * 24 * 3600_000 + 1000);
  assert.equal(await getSessionUser(env.ctx, student.token), null, "recipient signed out after 7 idle days");

  const other = await makeUser(env, "RECIPIENT");
  await revokeSession(env.ctx.db, other.token);
  assert.equal(await getSessionUser(env.ctx, other.token), null);
  assert.equal(await getSessionUser(env.ctx, "forged-token"), null);
});

test("sessions end after 30 days even when used daily", async () => {
  const u = await makeUser(env, "RECIPIENT");
  for (let d = 0; d < 29; d++) {
    env.clock.advance(24 * 3600_000);
    assert.ok(await getSessionUser(env.ctx, u.token), `day ${d + 1}`);
  }
  env.clock.advance(24 * 3600_000 + 1000);
  assert.equal(await getSessionUser(env.ctx, u.token), null);
});

test("housekeeping removes expired sessions and old rate-limit windows", async () => {
  env.clock.advance(40 * 24 * 3600_000);
  const result = await purgeExpired(env.ctx);
  assert.ok(result.sessions > 0);
  assert.ok(result.rateLimitWindows > 0);
});
