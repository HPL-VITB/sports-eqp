import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, test } from "node:test";
import { createSession } from "../src/server/auth/sessions";
import { findUserById, type User } from "../src/server/auth/users";
import { AppError } from "../src/server/errors";
import { dailyHandler, getPhotoHandler, returnIssueHandler } from "../src/server/http/return-handlers";
import { createItem } from "../src/server/inventory/items";
import { ledgerMismatches } from "../src/server/inventory/ledger";
import { createCategory, listSports } from "../src/server/inventory/masterdata";
import { purgeUnlinkedPhotos, savePhoto } from "../src/server/photos";
import { catalog, approveAndIssue, createRequest, getRequest } from "../src/server/requests/requests";
import { listIncidents, reportStoreDamage, resolveIncident } from "../src/server/returns/incidents";
import { getIssue, recordReturn } from "../src/server/returns/returns";
import { makeUser, req, setupTestEnv, type TestEnv } from "./support/harness";

let env: TestEnv;
let fr: User, aso: User, sk: User, pr: User, mg: User, rc: User;
const items: Record<string, string> = {};
const key = () => randomBytes(12).toString("hex");
const DUE = "2026-11-24";
const JPEG = () => new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...randomBytes(500)]);

const u = async (id: string) => (await findUserById(env.ctx.db, id))!;
async function rejectsWith(p: Promise<unknown>, code: string) {
  await assert.rejects(p, (e: unknown) => {
    if (!(e instanceof AppError)) throw e;
    assert.equal(e.code, code, e.message);
    return true;
  });
}
async function stock(itemId: string) {
  return (await env.ctx.db.query<{ available: number; issued: number; damaged: number; missing: number }>(
    "SELECT available, issued, damaged, missing FROM item_stock WHERE item_id = $1",
    [itemId],
  )).rows[0]!;
}
/** Recipient requests, ASO approves and hands over. Returns the issue id. */
async function issue(lines: [string, number][], due = DUE, who: User = rc): Promise<string> {
  const r = await createRequest(env.ctx, who, { lines: lines.map(([k, qty]) => ({ itemId: items[k]!, qty })), purpose: "Practice match", expectedReturn: due }, null);
  return (await approveAndIssue(env.ctx, aso, r.id, { lines: lines.map(([k, qty]) => ({ itemId: items[k]!, qty })), dueDate: due, issuedById: sk.id }, null)).issueId;
}
const line = (k: string, usable: number, damaged = 0, missing = 0, consumed = 0, note?: string) => ({ itemId: items[k]!, usable, damaged, missing, consumed, note });

before(async () => {
  env = await setupTestEnv();
  const made = [];
  for (const r of ["FR_SPORTS", "ASO", "STOREKEEPER", "PROCUREMENT", "MANAGEMENT", "RECIPIENT"] as const) made.push(await makeUser(env, r));
  [fr, aso, sk, pr, mg, rc] = (await Promise.all(made.map((m) => u(m.id)))) as [User, User, User, User, User, User];
  const sports = await listSports(env.ctx, fr);
  const cri = sports.find((s) => s.code === "CRI")!.id;
  const bad = sports.find((s) => s.code === "BAD")!.id;
  const loc = (await env.ctx.db.query<{ id: string }>("SELECT id FROM locations LIMIT 1")).rows[0]!.id;
  const balls = (await createCategory(env.ctx, fr, { sportId: cri, name: "Balls" }, null)).id;
  const bats = (await createCategory(env.ctx, fr, { sportId: cri, name: "Bats" }, null)).id;
  const shuttles = (await createCategory(env.ctx, fr, { sportId: bad, name: "Shuttlecocks" }, null)).id;
  const mk = async (k: string, sportId: string, categoryId: string, name: string, qty: number, isConsumable = false) =>
    (items[k] = (await createItem(env.ctx, fr, { sportId, categoryId, name, unit: "piece", locationId: loc, openingQty: qty, isConsumable }, null)).id);
  await mk("ball", cri, balls, "Leather ball", 60);
  await mk("bat", cri, bats, "Bat", 10);
  await mk("shuttle", bad, shuttles, "Feather shuttle", 50, true);
});
after(async () => env.close());

test("blueprint normal return: 50 available + 10 issued, all 10 back usable -> 60 available, 0 issued; issue and request closed", async () => {
  const id = await issue([["ball", 10]]);
  assert.deepEqual(await stock(items.ball!), { available: 50, issued: 10, damaged: 0, missing: 0 });
  const r = await recordReturn(env.ctx, sk, id, { lines: [line("ball", 10)] }, null);
  assert.deepEqual(r.totals, { usable: 10, damaged: 0, missing: 0, consumed: 0 });
  assert.deepEqual(await stock(items.ball!), { available: 60, issued: 0, damaged: 0, missing: 0 });
  const v = await getIssue(env.ctx, aso, id);
  assert.equal(v.status, "RETURNED");
  assert.equal(v.receivedBy, sk.name);
  assert.equal((await getRequest(env.ctx, rc, v.requestId)).status, "RETURNED");
  for (const to of [rc.email, sk.email]) {
    const m = env.mailer.sent.find((x) => x.to === to && x.text.includes(v.ref) && /return/i.test(x.subject))!;
    assert.ok(m, `return email to ${to}`);
    for (const part of ["Leather ball", "10 returned in good condition", `Received by: ${sk.name}`, `by ${sk.name}`]) assert.ok(m.text.includes(part), part);
  }
});

test("blueprint damaged return: 8 usable + 2 damaged -> 58 available, 2 damaged; damaged units cannot be requested", async () => {
  const id = await issue([["ball", 10]]);
  await recordReturn(env.ctx, aso, id, { lines: [line("ball", 8, 2, 0, 0, "Seams split")] }, null);
  assert.deepEqual(await stock(items.ball!), { available: 58, issued: 0, damaged: 2, missing: 0 });
  const inc = (await listIncidents(env.ctx, fr, { type: "DAMAGED" }))[0]!;
  assert.equal(inc.qty, 2);
  assert.equal(inc.issue!.id, id);
  assert.equal(inc.recipient!.id, rc.id);
  assert.equal(inc.description, "Seams split");
  assert.equal((await catalog(env.ctx, rc, {})).find((i) => i.id === items.ball)!.available, 58);
  const mail = env.mailer.sent.find((x) => x.to === rc.email && x.subject.includes("damaged or missing"))!;
  assert.ok(mail.text.includes("8 returned in good condition, 2 returned damaged"));
});

test("missing items: recorded with a note, moved to Missing, incident against the accountable recipient", async () => {
  const id = await issue([["bat", 4], ["ball", 2]]);
  await rejectsWith(recordReturn(env.ctx, sk, id, { lines: [line("bat", 3, 0, 1), line("ball", 2)] }, null), "RETURN_INCOMPLETE");
  await recordReturn(env.ctx, sk, id, { lines: [line("bat", 3, 0, 1, 0, "Left at the ground after the match"), line("ball", 2)] }, null);
  assert.deepEqual(await stock(items.bat!), { available: 9, issued: 0, damaged: 0, missing: 1 });
  const inc = (await listIncidents(env.ctx, fr, { type: "MISSING" }))[0]!;
  assert.equal(inc.qty, 1);
  assert.equal(inc.recipient!.id, rc.id);
});

test("full returns only: wrong totals, a missing line, extra lines or partial returns record nothing", async () => {
  const id = await issue([["ball", 5], ["bat", 2]]);
  const before = [await stock(items.ball!), await stock(items.bat!)];
  const tries = [
    [line("ball", 4), line("bat", 2)], // short
    [line("ball", 6), line("bat", 2)], // over
    [line("ball", 5)], // a line missing (partial return)
    [line("ball", 5), line("bat", 2), line("shuttle", 1)], // extra item
    [line("ball", 3, 0, 0, 2, "Lost"), line("bat", 2)], // consumed on a non-consumable item
  ];
  for (const lines of tries) await rejectsWith(recordReturn(env.ctx, sk, id, { lines }, null), "RETURN_INCOMPLETE");
  await rejectsWith(recordReturn(env.ctx, sk, id, { lines: [line("ball", -1, 6), line("bat", 2)] }, null), "VALIDATION");
  assert.deepEqual([await stock(items.ball!), await stock(items.bat!)], before);
  assert.equal((await getIssue(env.ctx, sk, id)).status, "ISSUED");
  for (const who of [rc, pr, mg]) await rejectsWith(recordReturn(env.ctx, who, id, { lines: [line("ball", 5), line("bat", 2)] }, null), "FORBIDDEN");
  await recordReturn(env.ctx, sk, id, { lines: [line("ball", 5), line("bat", 2)] }, null);
});

test("duplicate returns are impossible, sequentially and when 5 staff confirm at the same moment", async () => {
  const id = await issue([["ball", 6]]);
  const results = await Promise.allSettled([fr, aso, sk, aso, sk].map((who) => recordReturn(env.ctx, who, id, { lines: [line("ball", 6)] }, null)));
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  for (const r of results) if (r.status === "rejected") assert.equal((r.reason as AppError).code, "ALREADY_RETURNED");
  await rejectsWith(recordReturn(env.ctx, sk, id, { lines: [line("ball", 6)] }, null), "ALREADY_RETURNED");
  assert.equal((await env.ctx.db.query("SELECT 1 FROM stock_movements WHERE source_table = 'issues' AND source_id = $1 AND type LIKE 'RETURN%'", [id])).rowCount, 1);
  assert.equal((await stock(items.ball!)).issued, 0);
});

test("consumables: used-up units need a note, go to Missing as a CONSUMED incident, and cannot be 'recovered'", async () => {
  const id = await issue([["shuttle", 12]]);
  await rejectsWith(recordReturn(env.ctx, sk, id, { lines: [line("shuttle", 6, 0, 0, 6)] }, null), "RETURN_INCOMPLETE");
  await recordReturn(env.ctx, sk, id, { lines: [line("shuttle", 6, 0, 0, 6, "Used in inter-hostel finals")] }, null);
  assert.deepEqual(await stock(items.shuttle!), { available: 44, issued: 0, damaged: 0, missing: 6 });
  const inc = (await listIncidents(env.ctx, fr, { type: "CONSUMED" }))[0]!;
  assert.equal(inc.qty, 6);
  await rejectsWith(resolveIncident(env.ctx, sk, inc.id, { action: "RECOVERED_USABLE", qty: 1 }, null), "VALIDATION");
  assert.ok(env.mailer.sent.some((m) => m.to === rc.email && m.text.includes("6 used up")));
});

test("mark damaged usable: FR Sports / ASO only, never more than is open; closes the incident", async () => {
  const id = await issue([["bat", 3]]);
  await recordReturn(env.ctx, sk, id, { lines: [line("bat", 1, 2, 0, 0, "Handle grip torn")] }, null);
  const inc = (await listIncidents(env.ctx, fr, { type: "DAMAGED", itemId: items.bat! }))[0]!;
  const before = await stock(items.bat!);
  await rejectsWith(resolveIncident(env.ctx, sk, inc.id, { action: "MARKED_USABLE", qty: 1 }, null), "FORBIDDEN");
  await rejectsWith(resolveIncident(env.ctx, aso, inc.id, { action: "MARKED_USABLE", qty: 3 }, null), "VALIDATION");
  await rejectsWith(resolveIncident(env.ctx, aso, inc.id, { action: "RECOVERED_USABLE", qty: 1 }, null), "VALIDATION");
  const r1 = await resolveIncident(env.ctx, aso, inc.id, { action: "MARKED_USABLE", qty: 1, remarks: "Re-gripped" }, null);
  assert.equal(r1.open, 1);
  assert.deepEqual(await stock(items.bat!), { ...before, available: before.available + 1, damaged: before.damaged - 1 });
  await resolveIncident(env.ctx, fr, inc.id, { action: "MARKED_USABLE", qty: 1 }, null);
  await rejectsWith(resolveIncident(env.ctx, fr, inc.id, { action: "MARKED_USABLE", qty: 1 }, null), "INCIDENT_CLOSED");
  const closed = (await listIncidents(env.ctx, fr, { status: "closed", itemId: items.bat! })).find((x) => x.id === inc.id)!;
  assert.equal(closed.resolutions.length, 2);
  assert.equal(closed.resolutions[0]!.remarks, "Re-gripped");
});

test("missing equipment recovered: usable -> Available; damaged -> Damaged with a new damage incident", async () => {
  const id = await issue([["ball", 4]]);
  await recordReturn(env.ctx, sk, id, { lines: [line("ball", 2, 0, 2, 0, "Lost in the hostel")] }, null);
  const inc = (await listIncidents(env.ctx, fr, { type: "MISSING", itemId: items.ball! })).find((x) => x.issue?.id === id)!;
  const s0 = await stock(items.ball!);
  await resolveIncident(env.ctx, sk, inc.id, { action: "RECOVERED_USABLE", qty: 1 }, null);
  const r = await resolveIncident(env.ctx, sk, inc.id, { action: "RECOVERED_DAMAGED", qty: 1, remarks: "Found cracked" }, null);
  assert.deepEqual(await stock(items.ball!), { available: s0.available + 1, issued: 0, damaged: s0.damaged + 1, missing: s0.missing - 2 });
  const newInc = (await listIncidents(env.ctx, fr, { type: "DAMAGED" })).find((x) => x.id === r.newIncidentId)!;
  assert.equal(newInc.recipient!.id, rc.id);
  assert.equal(newInc.qty, 1);
});

test("damage found in the store: Available -> Damaged; only units actually in the store", async () => {
  const s0 = await stock(items.bat!);
  await rejectsWith(reportStoreDamage(env.ctx, rc, items.bat!, { qty: 1, description: "Cracked" }, null), "FORBIDDEN");
  await rejectsWith(reportStoreDamage(env.ctx, sk, items.bat!, { qty: s0.available + 1, description: "Cracked" }, null), "INSUFFICIENT_STOCK");
  const r = await reportStoreDamage(env.ctx, sk, items.bat!, { qty: 2, description: "Termite damage on rack" }, null);
  assert.equal(r.damagedAfter, s0.damaged + 2);
  const inc = (await listIncidents(env.ctx, mg, { type: "STORE_DAMAGE" }))[0]!;
  assert.equal(inc.issue, null);
  assert.equal(inc.reportedBy, sk.name);
});

test("photos: JPEG accepted by file signature, others refused; attached to damage; visible to staff, not recipients", async () => {
  await rejectsWith(savePhoto(env.ctx, sk, new TextEncoder().encode("<script>alert(1)</script>")), "PHOTO_TYPE");
  await rejectsWith(savePhoto(env.ctx, rc, JPEG()), "FORBIDDEN");
  await rejectsWith(savePhoto(env.ctx, sk, new Uint8Array(1_600_000).fill(0xff)), "PHOTO_TOO_LARGE");
  const photo = await savePhoto(env.ctx, sk, JPEG());
  const orphan = await savePhoto(env.ctx, sk, JPEG());
  const id = await issue([["ball", 3]]);
  await recordReturn(env.ctx, sk, id, { lines: [line("ball", 2, 1, 0, 0, "Torn")], photoId: photo.id }, null);
  const inc = (await listIncidents(env.ctx, fr, { type: "DAMAGED" })).find((x) => x.issue?.id === id)!;
  assert.equal(inc.photoId, photo.id);
  const mgToken = await createSession(env.ctx.db, mg.id, { ip: null, userAgent: null }, env.clock.now);
  const rcToken = await createSession(env.ctx.db, rc.id, { ip: null, userAgent: null }, env.clock.now);
  const ok = await getPhotoHandler(env.ctx, req("GET", `/api/photos/${photo.id}`, { token: mgToken }), photo.id);
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("content-type"), "image/jpeg");
  assert.equal(ok.headers.get("x-content-type-options"), "nosniff");
  assert.equal((await getPhotoHandler(env.ctx, req("GET", `/api/photos/${photo.id}`, { token: rcToken }), photo.id)).status, 403);
  env.clock.advance(25 * 3600_000);
  assert.equal(await purgeUnlinkedPhotos(env.ctx.db, env.clock.now), 1, "only the unattached photo is removed");
  assert.equal((await env.ctx.db.query("SELECT 1 FROM photos WHERE id = $1", [orphan.id])).rowCount, 0);
  assert.equal((await env.ctx.db.query("SELECT 1 FROM photos WHERE id = $1", [photo.id])).rowCount, 1);
});

test("email failure after a return: the return stands and the email is retried", async () => {
  const id = await issue([["ball", 2]], "2026-12-05");
  env.mailer.failNext = true;
  const r = await recordReturn(env.ctx, sk, id, { lines: [line("ball", 2)] }, null);
  assert.equal((await getIssue(env.ctx, sk, id)).status, "RETURNED");
  const st = (await env.ctx.db.query<{ status: string }>("SELECT status FROM notifications WHERE id = $1", [r.emailIds[0]])).rows[0]!;
  assert.equal(st.status, "QUEUED");
});

test("HTTP: recipient gets 403; storekeeper 201; repeating with the same key returns 200 and records once", async () => {
  const id = await issue([["ball", 3]], "2026-12-05");
  const skToken = await createSession(env.ctx.db, sk.id, { ip: null, userAgent: null }, env.clock.now);
  const rcToken = await createSession(env.ctx.db, rc.id, { ip: null, userAgent: null }, env.clock.now);
  const body = { lines: [line("ball", 3)], idempotencyKey: key() };
  assert.equal((await returnIssueHandler(env.ctx, req("POST", `/api/issues/${id}/return`, { token: rcToken, body }), id)).status, 403);
  assert.equal((await returnIssueHandler(env.ctx, req("POST", `/api/issues/${id}/return`, { token: skToken, body }), id)).status, 201);
  assert.equal((await returnIssueHandler(env.ctx, req("POST", `/api/issues/${id}/return`, { token: skToken, body }), id)).status, 200);
  assert.equal((await env.ctx.db.query("SELECT 1 FROM return_lines WHERE issue_id = $1", [id])).rowCount, 1);
});

test("daily job runs reminders, housekeeping and the ledger check, and requires the secret", async () => {
  assert.equal((await dailyHandler(env.ctx, req("GET", "/api/cron/daily"))).status, 401);
  const res = await dailyHandler(env.ctx, req("GET", "/api/cron/daily", { headers: { authorization: "Bearer cron-test-secret" } }));
  assert.equal(res.status, 200);
  const body = (await res.json()) as Record<string, unknown>;
  assert.deepEqual(Object.keys(body).sort(), ["ledger", "photos", "purge", "reminders"]);
  assert.deepEqual(body.ledger, { mismatches: 0 });
});

test("books balance: ledger matches; open damage incidents = Damaged stock; open missing + used-up = Missing stock", async () => {
  assert.deepEqual(await ledgerMismatches(env.ctx.db), []);
  const rows = (await env.ctx.db.query<{ item_id: string; damaged: number; missing: number; inc_damaged: string; inc_missing: string }>(
    `SELECT s.item_id, s.damaged, s.missing,
            coalesce((SELECT sum(qty - qty_resolved) FROM incidents n WHERE n.item_id = s.item_id AND n.type IN ('DAMAGED','STORE_DAMAGE')), 0) AS inc_damaged,
            coalesce((SELECT sum(qty - qty_resolved) FROM incidents n WHERE n.item_id = s.item_id AND n.type IN ('MISSING','CONSUMED')), 0) AS inc_missing
       FROM item_stock s`,
  )).rows;
  for (const r of rows) {
    assert.equal(Number(r.inc_damaged), r.damaged, `item ${r.item_id} damaged`);
    assert.equal(Number(r.inc_missing), r.missing, `item ${r.item_id} missing`);
  }
  const issued = (await env.ctx.db.query<{ a: string; b: string }>(
    `SELECT (SELECT sum(issued) FROM item_stock) AS a,
            (SELECT coalesce(sum(l.qty), 0) FROM issue_lines l JOIN issues i ON i.id = l.issue_id WHERE i.status = 'ISSUED') AS b`,
  )).rows[0]!;
  assert.equal(Number(issued.a), Number(issued.b));
});
