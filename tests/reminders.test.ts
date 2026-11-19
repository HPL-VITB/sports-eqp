import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { findUserById, type User } from "../src/server/auth/users";
import { AppError } from "../src/server/errors";
import { createItem } from "../src/server/inventory/items";
import { createCategory, listSports } from "../src/server/inventory/masterdata";
import { approveAndIssue, createRequest } from "../src/server/requests/requests";
import { getReminderSettings, reminderNumberFor, runOverdueReminders, updateReminderSettings } from "../src/server/returns/reminders";
import { recordReturn } from "../src/server/returns/returns";
import { makeUser, setupTestEnv, type TestEnv } from "./support/harness";

let env: TestEnv;
let fr: User, aso: User, sk: User, rc: User;
let ball: string;
const DAY = 24 * 3600_000;

before(async () => {
  env = await setupTestEnv();
  const made = [];
  for (const r of ["FR_SPORTS", "ASO", "STOREKEEPER", "RECIPIENT"] as const) made.push(await makeUser(env, r));
  [fr, aso, sk, rc] = (await Promise.all(made.map(async (m) => (await findUserById(env.ctx.db, m.id))!))) as [User, User, User, User];
  const cri = (await listSports(env.ctx, fr)).find((s) => s.code === "CRI")!.id;
  const cat = (await createCategory(env.ctx, fr, { sportId: cri, name: "Balls" }, null)).id;
  const loc = (await env.ctx.db.query<{ id: string }>("SELECT id FROM locations LIMIT 1")).rows[0]!.id;
  ball = (await createItem(env.ctx, fr, { sportId: cri, categoryId: cat, name: "Ball", unit: "piece", locationId: loc, openingQty: 100 }, null)).id;
});
after(async () => env.close());

async function issue(due: string, qty = 2) {
  const r = await createRequest(env.ctx, rc, { lines: [{ itemId: ball, qty }], purpose: "Nets", expectedReturn: due }, null);
  return (await approveAndIssue(env.ctx, aso, r.id, { lines: [{ itemId: ball, qty }], dueDate: due, issuedById: sk.id }, null)).issueRef;
}
const remindersFor = (ref: string, to: string) => env.mailer.sent.filter((m) => m.to === to && m.subject.includes(ref) && /overdue/i.test(m.subject));

test("schedule arithmetic: days 1, 4, 7, 10 with the defaults; never more than the maximum", () => {
  const s = { firstAfterDays: 1, everyDays: 3, max: 4 };
  assert.deepEqual([0, 1, 2, 3, 4, 6, 7, 10, 30].map((d) => reminderNumberFor(d, s)), [0, 1, 1, 1, 2, 2, 3, 4, 4]);
  assert.equal(reminderNumberFor(20, { ...s, max: 0 }), 0, "max 0 turns reminders off");
});

test("15 days of daily runs: 4 reminders to the recipient, the last also to the issuing staff, no duplicates", async () => {
  const ref = await issue("2026-11-18"); // clock: 17 Nov 10:00 IST
  for (let d = 0; d < 15; d++) {
    await runOverdueReminders(env.ctx);
    await runOverdueReminders(env.ctx); // a second run the same day sends nothing extra
    env.clock.advance(DAY);
  }
  const toRc = remindersFor(ref, rc.email);
  assert.equal(toRc.length, 4);
  assert.ok(toRc[0]!.text.includes("1 day overdue"));
  assert.ok(toRc[3]!.subject.startsWith("Final reminder"));
  assert.equal(remindersFor(ref, sk.email).length, 1, "issuer copied on the final reminder only");
});

test("a missed day is caught up with the current reminder only; returned equipment gets no more reminders", async () => {
  const start = env.clock.now;
  const ref = await issue("2026-12-03");
  env.clock.now = new Date(Date.parse("2026-12-10T04:00:00Z")); // 7 days overdue, job never ran before
  const r = await runOverdueReminders(env.ctx);
  assert.ok(r.remindersQueued >= 1);
  const got = remindersFor(ref, rc.email);
  assert.equal(got.length, 1, "one reminder, not three");
  assert.ok(got[0]!.text.includes("7 days overdue"));
  const issueId = (await env.ctx.db.query<{ id: string }>("SELECT id FROM issues WHERE ref = $1", [ref])).rows[0]!.id;
  await recordReturn(env.ctx, sk, issueId, { lines: [{ itemId: ball, usable: 2, damaged: 0, missing: 0 }] }, null);
  env.clock.advance(3 * DAY);
  await runOverdueReminders(env.ctx);
  assert.equal(remindersFor(ref, rc.email).length, 1);
  env.clock.now = start;
});

test("FR Sports sets the schedule; others cannot; invalid values refused; 0 turns reminders off", async () => {
  await assert.rejects(updateReminderSettings(env.ctx, aso, { firstAfterDays: 2, everyDays: 2, max: 3 }, null), (e: unknown) => e instanceof AppError && e.code === "FORBIDDEN");
  await assert.rejects(updateReminderSettings(env.ctx, fr, { firstAfterDays: 2, everyDays: 0, max: 3 }, null), (e: unknown) => e instanceof AppError && e.code === "VALIDATION");
  await updateReminderSettings(env.ctx, fr, { firstAfterDays: 2, everyDays: 2, max: 0 }, null);
  assert.deepEqual(await getReminderSettings(env.ctx.db), { firstAfterDays: 2, everyDays: 2, max: 0 });
  const t = env.clock.now;
  env.clock.now = new Date(Date.parse("2026-11-18T04:30:00Z"));
  const ref = await issue("2026-11-20");
  env.clock.now = new Date(Date.parse("2026-11-28T04:00:00Z"));
  await runOverdueReminders(env.ctx);
  assert.equal(remindersFor(ref, rc.email).length, 0);
  env.clock.now = t;
  const audit = await env.ctx.db.query("SELECT 1 FROM audit_log WHERE action = 'settings.overdue_reminders'");
  assert.equal(audit.rowCount, 1);
});
