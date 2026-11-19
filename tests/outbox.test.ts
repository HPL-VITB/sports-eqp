import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { findUserById, type User } from "../src/server/auth/users";
import { AppError } from "../src/server/errors";
import { dispatchCronHandler, listEmailsHandler } from "../src/server/http/request-handlers";
import { createItem } from "../src/server/inventory/items";
import { createCategory, listSports } from "../src/server/inventory/masterdata";
import { dispatch, enqueue, MAX_ATTEMPTS, resendNotification } from "../src/server/notify/outbox";
import { approveAndIssue, createRequest } from "../src/server/requests/requests";
import { makeUser, req, setupTestEnv, type TestEnv } from "./support/harness";

let env: TestEnv;
let fr: User, aso: User, rc: User;
let frToken: string, asoToken: string;
let ball: string;

before(async () => {
  env = await setupTestEnv();
  const a = await makeUser(env, "FR_SPORTS");
  const b = await makeUser(env, "ASO");
  const c = await makeUser(env, "RECIPIENT");
  frToken = a.token;
  asoToken = b.token;
  [fr, aso, rc] = (await Promise.all([a, b, c].map(async (x) => (await findUserById(env.ctx.db, x.id))!))) as [User, User, User];
  const cri = (await listSports(env.ctx, fr)).find((s) => s.code === "CRI")!.id;
  const cat = (await createCategory(env.ctx, fr, { sportId: cri, name: "Balls" }, null)).id;
  const loc = (await env.ctx.db.query<{ id: string }>("SELECT id FROM locations LIMIT 1")).rows[0]!.id;
  ball = (await createItem(env.ctx, fr, { sportId: cri, categoryId: cat, name: "Ball", unit: "piece", locationId: loc, openingQty: 100 }, null)).id;
});
after(async () => env.close());

const status = async (id: string) =>
  (await env.ctx.db.query<{ status: string; attempts: number; next_attempt_at: Date }>("SELECT status, attempts, next_attempt_at FROM notifications WHERE id = $1", [id])).rows[0]!;

test("email failure after issuing: the issue stands, emails retry with backoff and are delivered later", async () => {
  const r = await createRequest(env.ctx, rc, { lines: [{ itemId: ball, qty: 2 }], purpose: "Practice", expectedReturn: "2026-11-20" }, null);
  env.mailer.failNext = true; // first send (recipient email) fails
  const res = await approveAndIssue(env.ctx, aso, r.id, { lines: [{ itemId: ball, qty: 2 }], dueDate: "2026-11-20" }, null);
  assert.ok(res.issueRef);
  assert.equal((await env.ctx.db.query("SELECT 1 FROM issues WHERE id = $1", [res.issueId])).rowCount, 1);
  const [recipientMail, issuerMail] = res.emailIds as string[];
  const s1 = await status(recipientMail!);
  assert.equal(s1.status, "QUEUED");
  assert.equal(s1.attempts, 1);
  assert.equal(s1.next_attempt_at.getTime() - env.clock.now.getTime(), 60_000, "first retry after 1 minute");
  assert.equal((await status(issuerMail!)).status, "SENT", "the other email was unaffected");

  assert.equal((await dispatch(env.ctx)).sent, 0, "not due yet");
  env.clock.advance(61_000);
  assert.equal((await dispatch(env.ctx)).sent, 1);
  assert.equal((await status(recipientMail!)).status, "SENT");
});

test("after 6 failed attempts an email is FAILED, visible to FR Sports, and can be resent", async () => {
  const id = (await enqueue(env.ctx.db, { dedupeKey: "test:fail", kind: "test", to: "nobody@vitbhopal.ac.in", subject: "s", text: "t" }, env.clock.now))!;
  const realSend = env.mailer.send.bind(env.mailer);
  env.mailer.send = async () => { throw new Error("550 mailbox unavailable"); };
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    await dispatch(env.ctx);
    env.clock.advance(5 * 3600_000);
  }
  env.mailer.send = realSend;
  // The clock moved 30 hours: sign the staff in again.
  const { createSession } = await import("../src/server/auth/sessions");
  frToken = await createSession(env.ctx.db, fr.id, { ip: null, userAgent: null }, env.clock.now);
  asoToken = await createSession(env.ctx.db, aso.id, { ip: null, userAgent: null }, env.clock.now);
  const s = await status(id);
  assert.equal(s.status, "FAILED");
  assert.equal(s.attempts, MAX_ATTEMPTS);

  const list = await listEmailsHandler(env.ctx, req("GET", "/api/admin/emails?status=FAILED", { token: frToken }));
  const body = (await list.json()) as { emails: { id: string; lastError: string }[]; counts: Record<string, number> };
  assert.ok(body.emails.some((e) => e.id === id && e.lastError.includes("550")));
  assert.ok(body.counts.FAILED! >= 1);
  assert.equal((await listEmailsHandler(env.ctx, req("GET", "/api/admin/emails", { token: asoToken }))).status, 403);

  const again = await resendNotification(env.ctx, fr, id, null);
  assert.equal(again.status, "SENT");
  await assert.rejects(resendNotification(env.ctx, fr, id, null), (e: unknown) => e instanceof AppError && e.code === "ALREADY_SENT");
});

test("each email is sent exactly once even with several dispatchers running at the same time", async () => {
  const ids = [];
  for (let i = 0; i < 20; i++) ids.push(await enqueue(env.ctx.db, { dedupeKey: `bulk:${i}`, kind: "test", to: `p${i}@vitbhopal.ac.in`, subject: `m${i}`, text: "x" }, env.clock.now));
  const before = env.mailer.sent.length;
  await Promise.all(Array.from({ length: 5 }, () => dispatch(env.ctx, { limit: 50 })));
  const sent = env.mailer.sent.slice(before);
  assert.equal(sent.length, 20);
  assert.equal(new Set(sent.map((m) => m.to)).size, 20);
});

test("the same email cannot be queued twice", async () => {
  const a = await enqueue(env.ctx.db, { dedupeKey: "issue:999:recipient", kind: "x", to: "a@vitbhopal.ac.in", subject: "s", text: "t" }, env.clock.now);
  const b = await enqueue(env.ctx.db, { dedupeKey: "issue:999:recipient", kind: "x", to: "a@vitbhopal.ac.in", subject: "s", text: "t" }, env.clock.now);
  assert.ok(a);
  assert.equal(b, null);
});

test("daily ceiling: sending stops at the limit and resumes the next day", async () => {
  await env.ctx.db.query(
    `INSERT INTO notifications (dedupe_key, kind, to_email, subject, text_body, status, sent_at, next_attempt_at, created_at)
     SELECT 'old:' || g, 'x', 'a@vitbhopal.ac.in', 's', 't', 'SENT', $1, $1, $1 FROM generate_series(1, 1500) g`,
    [env.clock.now],
  );
  const late = (await enqueue(env.ctx.db, { dedupeKey: "ceiling:1", kind: "x", to: "late@vitbhopal.ac.in", subject: "s", text: "t" }, env.clock.now))!;
  assert.equal((await dispatch(env.ctx)).deferred, true);
  assert.equal((await status(late)).status, "QUEUED", "held back, not lost");
  env.clock.advance(24 * 3600_000 + 1000);
  assert.ok((await dispatch(env.ctx)).sent >= 1);
  assert.equal((await status(late)).status, "SENT");
});

test("cron dispatch endpoint requires the secret", async () => {
  assert.equal((await dispatchCronHandler(env.ctx, req("GET", "/api/cron/dispatch"))).status, 401);
  assert.equal((await dispatchCronHandler(env.ctx, req("GET", "/api/cron/dispatch", { headers: { authorization: "Bearer cron-test-secret" } }))).status, 200);
});
