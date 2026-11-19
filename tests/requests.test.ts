import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, test } from "node:test";
import { findUserById, type User } from "../src/server/auth/users";
import { AppError } from "../src/server/errors";
import { issueRequestHandler } from "../src/server/http/request-handlers";
import { createItem } from "../src/server/inventory/items";
import { ledgerMismatches } from "../src/server/inventory/ledger";
import { createCategory, listSports } from "../src/server/inventory/masterdata";
import {
  approveAndIssue,
  cancelRequest,
  catalog,
  createRequest,
  getRequest,
  listRequests,
  rejectRequest,
  setReady,
} from "../src/server/requests/requests";
import { makeUser, req, setupTestEnv, type TestEnv } from "./support/harness";

let env: TestEnv;
let fr: User, aso: User, aso2: User, sk: User, pr: User, mg: User, rc: User, rc2: User;
let tokens: Record<string, string> = {};
const items: Record<string, string> = {};
const DUE = "2026-11-24"; // clock starts 17 Nov 2026 IST
const key = () => randomBytes(12).toString("hex");

const u = async (id: string) => (await findUserById(env.ctx.db, id))!;
async function rejectsWith(p: Promise<unknown>, code: string) {
  await assert.rejects(p, (e: unknown) => {
    if (!(e instanceof AppError)) throw e;
    assert.equal(e.code, code, e.message);
    return true;
  });
}
async function stock(itemId: string) {
  return (await env.ctx.db.query<{ available: number; issued: number }>("SELECT available, issued FROM item_stock WHERE item_id = $1", [itemId])).rows[0]!;
}
const request = (who: User, lines: [string, number][], over: Record<string, unknown> = {}) =>
  createRequest(env.ctx, who, { lines: lines.map(([k, qty]) => ({ itemId: items[k]!, qty })), purpose: "Inter-house cricket", expectedReturn: DUE, ...over }, null);
const issueAll = (who: User, r: { id: string; lines: { itemId: string; qtyRequested: number }[] }, over: Record<string, unknown> = {}) =>
  approveAndIssue(env.ctx, who, r.id, { lines: r.lines.map((l) => ({ itemId: l.itemId, qty: l.qtyRequested })), dueDate: DUE, ...over }, null);

before(async () => {
  env = await setupTestEnv();
  const roles = ["FR_SPORTS", "ASO", "ASO", "STOREKEEPER", "PROCUREMENT", "MANAGEMENT", "RECIPIENT", "RECIPIENT"] as const;
  const made = [];
  for (const r of roles) made.push(await makeUser(env, r));
  [fr, aso, aso2, sk, pr, mg, rc, rc2] = (await Promise.all(made.map((m) => u(m.id)))) as [User, User, User, User, User, User, User, User];
  tokens = { aso: made[1]!.token, sk: made[3]!.token, rc: made[6]!.token };
  const cri = (await listSports(env.ctx, fr)).find((s) => s.code === "CRI")!.id;
  const loc = (await env.ctx.db.query<{ id: string }>("SELECT id FROM locations LIMIT 1")).rows[0]!.id;
  const cat = async (name: string) => (await createCategory(env.ctx, fr, { sportId: cri, name }, null)).id;
  const [bats, balls, stumps] = [await cat("Bats"), await cat("Balls"), await cat("Stumps")];
  const mk = async (k: string, categoryId: string, name: string, qty: number, unit = "piece") =>
    (items[k] = (await createItem(env.ctx, fr, { sportId: cri, categoryId, name, unit, locationId: loc, openingQty: qty }, null)).id);
  await mk("bat", bats, "English willow bat", 10);
  await mk("ball", balls, "Leather ball", 60);
  await mk("stumps", stumps, "Stumps", 5, "set");
  await mk("last", balls, "Last five balls", 5);
  await mk("spare", balls, "Spare ball", 30);
});
after(async () => env.close());

test("catalog shows only equipment that can be issued now", async () => {
  const list = await catalog(env.ctx, rc, {});
  assert.ok(list.some((i) => i.id === items.ball && i.available === 60));
  await env.ctx.db.query("UPDATE items SET is_active = false WHERE id = $1", [items.spare]);
  assert.ok(!(await catalog(env.ctx, rc, {})).some((i) => i.id === items.spare));
  await env.ctx.db.query("UPDATE items SET is_active = true WHERE id = $1", [items.spare]);
});

test("a multi-item request moves no stock and is visible to staff, not to other recipients", async () => {
  const r = await request(rc, [["bat", 4], ["ball", 6], ["stumps", 2]], { groupName: "Blue House" });
  assert.match(r.ref, /^REQ-2026-\d{6}$/);
  assert.equal(r.status, "PENDING");
  assert.equal(r.lines.length, 3);
  assert.equal((await stock(items.ball!)).available, 60);
  assert.ok((await listRequests(env.ctx, sk, { status: "PENDING" })).some((x) => x.id === r.id));
  assert.ok(!(await listRequests(env.ctx, rc2, {})).some((x) => x.id === r.id));
  await rejectsWith(getRequest(env.ctx, rc2, r.id), "NOT_FOUND");
  await cancelRequest(env.ctx, rc, r.id, null);
});

test("request validation: availability, dates, duplicates, pending limit, management cannot request", async () => {
  await rejectsWith(request(rc, [["stumps", 6]]), "NOT_AVAILABLE");
  await rejectsWith(request(rc, [["ball", 1]], { expectedReturn: "2026-11-16" }), "DUE_DATE");
  await rejectsWith(request(rc, [["ball", 1]], { expectedReturn: "2026-12-18" }), "DUE_DATE");
  await rejectsWith(request(rc, [["ball", 1]], { expectedReturn: "2026-02-30" }), "VALIDATION");
  await rejectsWith(request(rc, [["ball", 1], ["ball", 2]]), "VALIDATION");
  await rejectsWith(request(rc, []), "VALIDATION");
  await rejectsWith(request(mg, [["ball", 1]]), "FORBIDDEN");
  const made = [];
  for (let i = 0; i < 5; i++) made.push(await request(rc2, [["ball", 1]]));
  await rejectsWith(request(rc2, [["ball", 1]]), "TOO_MANY_PENDING");
  for (const m of made) await cancelRequest(env.ctx, rc2, m.id, null);
});

test("blueprint example: approve & hand over 10 of 60 -> available 50, issued 10; issue record, movements and emails", async () => {
  const r = await request(rc, [["ball", 10]]);
  await rejectsWith(issueAll(sk, r), "FORBIDDEN");
  await rejectsWith(issueAll(rc2, r), "FORBIDDEN");
  const res = await issueAll(aso, r, { issuedById: sk.id });
  assert.match(res.issueRef, /^ISS-2026-\d{6}$/);
  assert.deepEqual(await stock(items.ball!), { available: 50, issued: 10 });
  const view = await getRequest(env.ctx, rc, r.id);
  assert.equal(view.status, "ISSUED");
  assert.equal(view.issue!.issuedBy, sk.name);
  assert.equal(view.issue!.approvedBy, aso.name);
  assert.equal(view.lines[0]!.qtyIssued, 10);
  const mv = (await env.ctx.db.query<{ type: string; from_state: string; to_state: string; qty: number; source_id: string; approved_by: string }>(
    "SELECT type, from_state, to_state, qty, source_id, approved_by FROM stock_movements WHERE source_table = 'issues' AND source_id = $1",
    [res.issueId],
  )).rows;
  assert.deepEqual(mv.map((m) => [m.type, m.from_state, m.to_state, m.qty, String(m.approved_by)]), [["ISSUE", "AVAILABLE", "ISSUED", 10, aso.id]]);
  const toRc = env.mailer.sent.find((m) => m.to === rc.email && m.subject.includes(res.issueRef))!;
  const toSk = env.mailer.sent.find((m) => m.to === sk.email && m.subject.includes(res.issueRef))!;
  for (const text of [toRc.text, toSk.text]) {
    for (const part of [res.issueRef, "Leather ball", "10 pieces", "24 Nov 2026", `Issued by: ${sk.name}`, `Approved by: ${aso.name}`]) assert.ok(text.includes(part), part);
  }
  assert.equal((await env.ctx.db.query("SELECT 1 FROM notifications WHERE entity_id = $1 AND status = 'SENT'", [res.issueId])).rowCount, 2);
});

test("approver may issue fewer or drop a line; recipient is told the actual quantities", async () => {
  const r = await request(rc, [["bat", 4], ["stumps", 2]]);
  const res = await approveAndIssue(env.ctx, aso, r.id, {
    lines: [{ itemId: items.bat!, qty: 3 }, { itemId: items.stumps!, qty: 0 }],
    dueDate: "2026-11-20",
  }, null);
  assert.equal(res.lines.length, 1);
  const view = await getRequest(env.ctx, rc, r.id);
  assert.deepEqual(view.lines.map((l) => [l.code.split("-")[1], l.qtyRequested, l.qtyIssued]), [["BAT", 4, 3], ["STU", 2, 0]]);
  assert.equal((await stock(items.stumps!)).available, 5);
  const mail = env.mailer.sent.find((m) => m.to === rc.email && m.subject.includes(res.issueRef))!;
  assert.ok(mail.text.includes("3 pieces") && !mail.text.includes("Stumps"));
  await rejectsWith(
    approveAndIssue(env.ctx, aso, (await request(rc, [["bat", 1]])).id, { lines: [{ itemId: items.bat!, qty: 2 }], dueDate: DUE }, null),
    "VALIDATION",
  );
});

test("nobody approves or rejects their own request", async () => {
  const own = await request(aso, [["spare", 1]]);
  await rejectsWith(issueAll(aso, own), "SELF_DECISION");
  await rejectsWith(rejectRequest(env.ctx, aso, own.id, { reason: "Not needed" }, null), "SELF_DECISION");
  await issueAll(aso2, own);
});

test("two officers approving the same request at the same moment: exactly one issue", async () => {
  for (let round = 0; round < 10; round++) {
    const r = await request(rc2, [["spare", 1]]);
    const results = await Promise.allSettled([issueAll(aso, r), issueAll(fr, r), issueAll(aso2, r)]);
    assert.equal(results.filter((x) => x.status === "fulfilled").length, 1, `round ${round}`);
    for (const x of results) if (x.status === "rejected") assert.equal((x.reason as AppError).code, "ALREADY_PROCESSED");
    assert.equal((await env.ctx.db.query("SELECT 1 FROM issues WHERE request_id = $1", [r.id])).rowCount, 1);
  }
});

test("two officers issuing the last 5 units to different people at once: one succeeds, stock never negative", async () => {
  const a = await request(rc, [["last", 5]]);
  const b = await request(rc2, [["last", 5]]);
  const results = await Promise.allSettled([issueAll(aso, a), issueAll(fr, b)]);
  assert.equal(results.filter((x) => x.status === "fulfilled").length, 1);
  const failed = results.find((x) => x.status === "rejected") as PromiseRejectedResult;
  assert.equal((failed.reason as AppError).code, "INSUFFICIENT_STOCK");
  assert.match((failed.reason as AppError).message, /Nothing was issued/);
  assert.deepEqual(await stock(items.last!), { available: 0, issued: 5 });
  const loser = results[0]!.status === "rejected" ? a : b;
  assert.equal((await getRequest(env.ctx, fr, loser.id)).status, "PENDING", "the losing request stays pending for a decision");
});

test("all-or-nothing: if one line became unavailable while pending, no line is issued", async () => {
  const r = await request(rc, [["spare", 3], ["stumps", 5]]);
  await issueAll(aso, await request(rc2, [["stumps", 4]]));
  const before = [await stock(items.spare!), await stock(items.stumps!)];
  await rejectsWith(issueAll(fr, r), "INSUFFICIENT_STOCK");
  assert.deepEqual([await stock(items.spare!), await stock(items.stumps!)], before);
  assert.equal((await env.ctx.db.query("SELECT 1 FROM issues WHERE request_id = $1", [r.id])).rowCount, 0);
  await rejectRequest(env.ctx, fr, r.id, { reason: "Stumps are out on another issue." }, null);
});

test("rejection needs a reason, changes no stock, emails the requester and closes the request", async () => {
  const r = await request(rc, [["ball", 2]]);
  const before = await stock(items.ball!);
  await rejectsWith(rejectRequest(env.ctx, aso, r.id, { reason: "" }, null), "VALIDATION");
  await rejectsWith(rejectRequest(env.ctx, sk, r.id, { reason: "nope" }, null), "FORBIDDEN");
  const v = await rejectRequest(env.ctx, aso, r.id, { reason: "Ground closed this week" }, null);
  assert.equal(v.status, "REJECTED");
  assert.equal(v.rejectReason, "Ground closed this week");
  assert.deepEqual(await stock(items.ball!), before);
  assert.ok(env.mailer.sent.some((m) => m.to === rc.email && m.subject.includes(r.ref) && m.text.includes("Ground closed this week")));
  await rejectsWith(issueAll(fr, r), "ALREADY_PROCESSED");
  await rejectsWith(rejectRequest(env.ctx, fr, r.id, { reason: "again" }, null), "ALREADY_PROCESSED");
});

test("cancel: own pending requests only", async () => {
  const r = await request(rc, [["ball", 1]]);
  await rejectsWith(cancelRequest(env.ctx, rc2, r.id, null), "NOT_FOUND");
  assert.equal((await cancelRequest(env.ctx, rc, r.id, null)).status, "CANCELLED");
  await rejectsWith(cancelRequest(env.ctx, rc, r.id, null), "ALREADY_PROCESSED");
  const issued = await request(rc, [["ball", 1]]);
  await issueAll(aso, issued);
  await rejectsWith(cancelRequest(env.ctx, rc, issued.id, null), "ALREADY_PROCESSED");
});

test("storekeeper marks a request ready for handover; no stock moves; recipients cannot", async () => {
  const r = await request(rc, [["ball", 2]]);
  const before = await stock(items.ball!);
  const v = await setReady(env.ctx, sk, r.id, { ready: true }, null);
  assert.equal(v.ready, true);
  assert.equal(v.readyBy, sk.name);
  assert.deepEqual(await stock(items.ball!), before);
  await rejectsWith(setReady(env.ctx, rc, r.id, { ready: false }, null), "FORBIDDEN");
  const pending = await listRequests(env.ctx, aso, { status: "PENDING" });
  assert.equal(pending[0]!.ready, true, "ready requests are listed first");
  await cancelRequest(env.ctx, rc, r.id, null);
});

test("due dates: issue due date can be set at handover; overdue appears without any scheduled job", async () => {
  const r = await request(rc2, [["spare", 2]]);
  await approveAndIssue(env.ctx, aso, r.id, { lines: [{ itemId: items.spare!, qty: 2 }], dueDate: "2026-11-18" }, null);
  assert.equal((await getRequest(env.ctx, rc2, r.id)).issue!.overdue, false);
  env.clock.advance(3 * 24 * 3600_000); // 20 Nov IST
  const v = await getRequest(env.ctx, rc2, r.id);
  assert.equal(v.issue!.overdue, true);
  assert.equal(v.issue!.daysOverdue, 2);
  assert.ok((await listRequests(env.ctx, fr, { status: "OVERDUE" })).some((x) => x.id === r.id));
  await rejectsWith(issueAll(aso, await request(rc, [["ball", 1]], { expectedReturn: "2026-11-25" }), { dueDate: "2026-11-19" }), "DUE_DATE");
});

test("issuing person must be active store staff", async () => {
  const r = await request(rc, [["ball", 1]], { expectedReturn: "2026-11-25" });
  await rejectsWith(issueAll(aso, r, { issuedById: pr.id, dueDate: "2026-11-25" }), "VALIDATION");
  await rejectsWith(issueAll(aso, r, { issuedById: rc2.id, dueDate: "2026-11-25" }), "VALIDATION");
  await cancelRequest(env.ctx, rc, r.id, null);
});

test("HTTP: storekeeper gets 403 on approve; ASO 201; repeat with the same key returns 200 and issues once", async () => {
  const { createSession } = await import("../src/server/auth/sessions");
  for (const [k, who] of [["aso", aso], ["sk", sk], ["rc", rc]] as const) {
    tokens[k] = await createSession(env.ctx.db, who.id, { ip: null, userAgent: null }, env.clock.now);
  }
  const r = await request(rc, [["ball", 3]], { expectedReturn: "2026-11-25" });
  const body = { lines: [{ itemId: items.ball!, qty: 3 }], dueDate: "2026-11-25", idempotencyKey: key() };
  assert.equal((await issueRequestHandler(env.ctx, req("POST", `/api/requests/${r.id}/issue`, { token: tokens.sk, body }), r.id)).status, 403);
  assert.equal((await issueRequestHandler(env.ctx, req("POST", `/api/requests/${r.id}/issue`, { token: tokens.rc, body }), r.id)).status, 403);
  const before = await stock(items.ball!);
  const first = await issueRequestHandler(env.ctx, req("POST", `/api/requests/${r.id}/issue`, { token: tokens.aso, body }), r.id);
  const again = await issueRequestHandler(env.ctx, req("POST", `/api/requests/${r.id}/issue`, { token: tokens.aso, body }), r.id);
  assert.equal(first.status, 201);
  assert.equal(again.status, 200);
  assert.equal((await stock(items.ball!)).available, before.available - 3);
});

test("ledger is consistent after all issuing", async () => {
  assert.deepEqual(await ledgerMismatches(env.ctx.db), []);
  const totals = (await env.ctx.db.query<{ issued: string; lines: string }>(
    `SELECT (SELECT sum(issued) FROM item_stock) AS issued,
            (SELECT sum(l.qty) FROM issue_lines l JOIN issues i ON i.id = l.issue_id WHERE i.status = 'ISSUED') AS lines`,
  )).rows[0]!;
  assert.equal(totals.issued, totals.lines, "Issued stock equals the sum of open issue lines");
});
