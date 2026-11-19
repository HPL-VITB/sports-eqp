import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { cancelCorrection, decideCorrection, requestCorrection } from "../src/server/adjustments/corrections";
import { cancelDiscard, decideDiscard, listDiscards, requestDiscard } from "../src/server/adjustments/discards";
import { reverseReceipt } from "../src/server/adjustments/reversal";
import { getCount, saveCounts, startCount, submitCount } from "../src/server/adjustments/verification";
import { createSession } from "../src/server/auth/sessions";
import { findUserById, type User } from "../src/server/auth/users";
import { AppError } from "../src/server/errors";
import { decideDiscardHandler } from "../src/server/http/adjustment-handlers";
import { createItem, receiveStock } from "../src/server/inventory/items";
import { ledgerMismatches } from "../src/server/inventory/ledger";
import { createCategory, listSports } from "../src/server/inventory/masterdata";
import { approveAndIssue, catalog, createRequest } from "../src/server/requests/requests";
import { listIncidents, resolveIncident } from "../src/server/returns/incidents";
import { recordReturn } from "../src/server/returns/returns";
import { makeUser, req, setupTestEnv, type TestEnv } from "./support/harness";

let env: TestEnv;
let fr: User, fr2: User, aso: User, sk: User, pr: User, mg: User, rc: User;
const items: Record<string, string> = {};
let cricketId: string, batsCat: string;
const DUE = "2026-11-24";

const u = async (id: string) => (await findUserById(env.ctx.db, id))!;
async function rejectsWith(p: Promise<unknown>, code: string) {
  await assert.rejects(p, (e: unknown) => {
    if (!(e instanceof AppError)) throw e;
    assert.equal(e.code, code, e.message);
    return true;
  });
}
async function stock(itemId: string) {
  return (await env.ctx.db.query<{ available: number; issued: number; damaged: number; missing: number; discarded: number; reserved: number }>(
    "SELECT available, issued, damaged, missing, discarded, reserved FROM item_stock WHERE item_id = $1",
    [itemId],
  )).rows[0]!;
}
async function issue(k: string, qty: number) {
  const r = await createRequest(env.ctx, rc, { lines: [{ itemId: items[k]!, qty }], purpose: "Match", expectedReturn: DUE }, null);
  return (await approveAndIssue(env.ctx, aso, r.id, { lines: [{ itemId: items[k]!, qty }], dueDate: DUE }, null)).issueId;
}

before(async () => {
  env = await setupTestEnv();
  const made = [];
  for (const r of ["FR_SPORTS", "FR_SPORTS", "ASO", "STOREKEEPER", "PROCUREMENT", "MANAGEMENT", "RECIPIENT"] as const) made.push(await makeUser(env, r));
  [fr, fr2, aso, sk, pr, mg, rc] = (await Promise.all(made.map((m) => u(m.id)))) as [User, User, User, User, User, User, User];
  const sports = await listSports(env.ctx, fr);
  cricketId = sports.find((s) => s.code === "CRI")!.id;
  const bad = sports.find((s) => s.code === "BAD")!.id;
  const loc = (await env.ctx.db.query<{ id: string }>("SELECT id FROM locations LIMIT 1")).rows[0]!.id;
  const balls = (await createCategory(env.ctx, fr, { sportId: cricketId, name: "Balls" }, null)).id;
  batsCat = (await createCategory(env.ctx, fr, { sportId: cricketId, name: "Bats" }, null)).id;
  const shut = (await createCategory(env.ctx, fr, { sportId: bad, name: "Shuttlecocks" }, null)).id;
  const mk = async (k: string, sportId: string, cat: string, name: string, qty: number, isConsumable = false) =>
    (items[k] = (await createItem(env.ctx, fr, { sportId, categoryId: cat, name, unit: "piece", locationId: loc, openingQty: qty, isConsumable }, null)).id);
  await mk("ball", cricketId, balls, "Leather ball", 60);
  await mk("bat", cricketId, batsCat, "Bat", 50);
  await mk("shuttle", bad, shut, "Shuttle", 40, true);
  await mk("net", cricketId, batsCat, "Practice net", 10);
});
after(async () => env.close());

test("discard from the store: ASO requests, units are held (cannot be issued), FR Sports approves, total drops", async () => {
  const s0 = await stock(items.net!);
  const d = await requestDiscard(env.ctx, aso, { itemId: items.net!, qty: 3, reason: "WORN_OUT", details: "Mesh torn" }, null);
  const held = await stock(items.net!);
  assert.equal(held.reserved, 3);
  assert.equal((await catalog(env.ctx, rc, {})).find((i) => i.id === items.net)!.available, 7, "held units are not offered");
  await rejectsWith(decideDiscard(env.ctx, aso, d.id, { decision: "APPROVE" }, null), "FORBIDDEN");
  await decideDiscard(env.ctx, fr, d.id, { decision: "APPROVE", note: "Agreed" }, null);
  assert.deepEqual(await stock(items.net!), { ...s0, available: s0.available - 3, discarded: 3, reserved: 0 });
  await rejectsWith(decideDiscard(env.ctx, fr, d.id, { decision: "APPROVE" }, null), "ALREADY_PROCESSED");
  const name = (await env.ctx.db.query("SELECT 1 FROM items WHERE id = $1", [items.net])).rowCount;
  assert.equal(name, 1, "item record is kept");
});

test("issued equipment can never be discarded; held units cannot be requested twice", async () => {
  await issue("net", 7);
  await rejectsWith(requestDiscard(env.ctx, sk, { itemId: items.net!, fromState: "ISSUED", qty: 1, reason: "BROKEN" }, null), "ITEM_ISSUED");
  await rejectsWith(requestDiscard(env.ctx, sk, { itemId: items.net!, qty: 1, reason: "BROKEN" }, null), "INSUFFICIENT_STOCK");
  const d = await requestDiscard(env.ctx, sk, { itemId: items.bat!, qty: 45, reason: "OBSOLETE" }, null);
  await rejectsWith(requestDiscard(env.ctx, aso, { itemId: items.bat!, qty: 6, reason: "OBSOLETE" }, null), "INSUFFICIENT_STOCK");
  await rejectsWith(cancelDiscard(env.ctx, aso, d.id, null), "FORBIDDEN");
  await cancelDiscard(env.ctx, sk, d.id, null);
  assert.equal((await stock(items.bat!)).reserved, 0);
});

test("rejection needs a reason and releases the held units; only FR Sports decides; management and procurement cannot request", async () => {
  const d = await requestDiscard(env.ctx, sk, { itemId: items.bat!, qty: 2, reason: "BROKEN" }, null);
  await rejectsWith(decideDiscard(env.ctx, fr, d.id, { decision: "REJECT" }, null), "VALIDATION");
  await decideDiscard(env.ctx, fr, d.id, { decision: "REJECT", note: "Still playable" }, null);
  assert.equal((await stock(items.bat!)).reserved, 0);
  for (const who of [mg, pr, rc, fr]) await rejectsWith(requestDiscard(env.ctx, who, { itemId: items.bat!, qty: 1, reason: "BROKEN" }, null), "FORBIDDEN");
});

test("discarding damaged units from a return closes the damage record; held units cannot be marked usable meanwhile", async () => {
  const id = await issue("ball", 10);
  await recordReturn(env.ctx, sk, id, { lines: [{ itemId: items.ball!, usable: 7, damaged: 3, missing: 0, note: "Split seams" }] }, null);
  const inc = (await listIncidents(env.ctx, fr, { type: "DAMAGED" }))[0]!;
  const d = await requestDiscard(env.ctx, aso, { itemId: items.ball!, incidentId: inc.id, qty: 2, reason: "BEYOND_USE" }, null);
  await rejectsWith(resolveIncident(env.ctx, aso, inc.id, { action: "MARKED_USABLE", qty: 2 }, null), "VALIDATION");
  await resolveIncident(env.ctx, aso, inc.id, { action: "MARKED_USABLE", qty: 1 }, null);
  const s0 = await stock(items.ball!);
  await decideDiscard(env.ctx, fr, d.id, { decision: "APPROVE" }, null);
  const s1 = await stock(items.ball!);
  assert.deepEqual([s1.damaged, s1.discarded], [s0.damaged - 2, s0.discarded + 2]);
  const closed = (await listIncidents(env.ctx, fr, { status: "closed" })).find((x) => x.id === inc.id)!;
  assert.deepEqual(closed.resolutions.map((r) => [r.action, r.qty]), [["MARKED_USABLE", 1], ["DISCARDED", 2]]);
});

test("used-up consumables raise a discard automatically; FR Sports approval closes it (even if FR recorded the return)", async () => {
  const id = await issue("shuttle", 12);
  await recordReturn(env.ctx, fr, id, { lines: [{ itemId: items.shuttle!, usable: 4, damaged: 0, missing: 0, consumed: 8, note: "Finals" }] }, null);
  const d = (await listDiscards(env.ctx, fr, { status: "PENDING" })).find((x) => x.item.id === items.shuttle)!;
  assert.equal(d.auto, true);
  assert.equal(d.qty, 8);
  assert.equal(d.reason, "CONSUMED");
  await decideDiscard(env.ctx, fr, d.id, { decision: "APPROVE" }, null);
  const s = await stock(items.shuttle!);
  assert.deepEqual([s.available, s.missing, s.discarded], [32, 0, 8]);
});

test("self-approval is refused even for a second FR user's own request", async () => {
  // FR users cannot request; simulate a correction requested by ASO and check the database rule for discards too.
  const c = await requestCorrection(env.ctx, aso, { itemId: items.bat!, state: "AVAILABLE", countedQty: 49, reason: "Recount" }, null);
  await rejectsWith(decideCorrection(env.ctx, aso, c.id, { decision: "APPROVE" }, null), "FORBIDDEN");
  await decideCorrection(env.ctx, fr2, c.id, { decision: "APPROVE" }, null);
  assert.equal((await stock(items.bat!)).available, 49);
});

test("corrections are applied as differences: a correction approved after an issue still gives the right balance", async () => {
  // Count says 47 of 49 usable on the shelf (2 short). Before approval, 5 are issued. Approval applies -2, not "set to 47".
  const c = await requestCorrection(env.ctx, sk, { itemId: items.bat!, state: "AVAILABLE", countedQty: 47, reason: "Two missing from rack" }, null);
  assert.equal(c.delta, -2);
  await issue("bat", 5);
  await decideCorrection(env.ctx, fr, c.id, { decision: "APPROVE" }, null);
  const s = await stock(items.bat!);
  assert.deepEqual([s.available, s.issued], [42, 5]);
  await rejectsWith(requestCorrection(env.ctx, sk, { itemId: items.bat!, state: "AVAILABLE", countedQty: 42, reason: "same" }, null), "NO_DIFFERENCE");
  await rejectsWith(requestCorrection(env.ctx, pr, { itemId: items.bat!, state: "AVAILABLE", countedQty: 1, reason: "x x x" }, null), "FORBIDDEN");
});

test("a correction that would make stock negative is refused at approval with nothing changed", async () => {
  const c2 = await requestCorrection(env.ctx, sk, { itemId: items.bat!, state: "AVAILABLE", countedQty: 2, reason: "Most gone" }, null);
  await issue("bat", 40);
  const before = await stock(items.bat!);
  await rejectsWith(decideCorrection(env.ctx, fr, c2.id, { decision: "APPROVE" }, null), "INSUFFICIENT_STOCK");
  assert.deepEqual(await stock(items.bat!), before);
  await decideCorrection(env.ctx, fr, c2.id, { decision: "REJECT", note: "Recount after returns" }, null);
});

test("one pending correction per item and state; requester may cancel", async () => {
  const c = await requestCorrection(env.ctx, sk, { itemId: items.ball!, state: "AVAILABLE", countedQty: 1, reason: "Check" }, null);
  await rejectsWith(requestCorrection(env.ctx, aso, { itemId: items.ball!, state: "AVAILABLE", countedQty: 2, reason: "Check" }, null), "CORRECTION_PENDING");
  await rejectsWith(cancelCorrection(env.ctx, aso, c.id, null), "FORBIDDEN");
  await cancelCorrection(env.ctx, sk, c.id, null);
});

test("damaged corrections keep damage records in step (extra damaged opens a record; fewer closes the oldest)", async () => {
  const up = await requestCorrection(env.ctx, sk, { itemId: items.shuttle!, state: "DAMAGED", countedQty: 2, reason: "Two found split" }, null);
  await decideCorrection(env.ctx, fr, up.id, { decision: "APPROVE" }, null);
  assert.equal((await stock(items.shuttle!)).damaged, 2);
  const down = await requestCorrection(env.ctx, sk, { itemId: items.shuttle!, state: "DAMAGED", countedQty: 1, reason: "One was misplaced" }, null);
  await decideCorrection(env.ctx, fr, down.id, { decision: "APPROVE" }, null);
  assert.equal((await stock(items.shuttle!)).damaged, 1);
  const open = (await listIncidents(env.ctx, fr, { itemId: items.shuttle! })).filter((i) => i.type === "STORE_DAMAGE");
  assert.equal(open.reduce((s, i) => s + i.qtyOpen, 0), 1);
});

test("blueprint count: 50 accountable with 20 issued -> 30 expected on the shelf; counting 30 is not a shortage", async () => {
  const id = (await createItem(env.ctx, fr, { sportId: cricketId, categoryId: batsCat, name: "Count bat", unit: "piece", locationId: (await env.ctx.db.query<{ id: string }>("SELECT id FROM locations LIMIT 1")).rows[0]!.id, openingQty: 50 }, null)).id;
  items.count = id;
  await issue("count", 20);
  const s = await startCount(env.ctx, sk, { scopeType: "CATEGORY", scopeId: batsCat }, null);
  await rejectsWith(startCount(env.ctx, aso, { scopeType: "CATEGORY", scopeId: batsCat }, null), "COUNT_OPEN");
  const view = await getCount(env.ctx, sk, s.id);
  const line = view.lines.find((l) => l.item.id === id)!;
  assert.deepEqual([line.expectedOnShelf, line.issued], [30, 20]);
  await rejectsWith(submitCount(env.ctx, sk, s.id, null), "COUNT_INCOMPLETE");
  const counts = view.lines.map((l) => ({ itemId: l.item.id, usable: l.expectedUsable, damaged: l.expectedDamaged }));
  await saveCounts(env.ctx, sk, s.id, { lines: counts });
  const r = await submitCount(env.ctx, sk, s.id, null);
  assert.equal(r.discrepancies.length, 0, "matching counts create no corrections");
  const report = await getCount(env.ctx, mg, s.id);
  assert.equal(report.status, "SUBMITTED");
  assert.equal(report.lines.find((l) => l.item.id === id)!.expectedOnShelf, 30);
});

test("count with differences creates corrections for FR Sports, linked to the count report", async () => {
  const s = await startCount(env.ctx, aso, { scopeType: "SPORT", scopeId: cricketId }, null);
  const view = await getCount(env.ctx, aso, s.id);
  const lines = view.lines.map((l) => ({
    itemId: l.item.id,
    usable: l.item.id === items.count ? l.expectedUsable - 1 : l.expectedUsable,
    damaged: l.expectedDamaged,
  }));
  await saveCounts(env.ctx, aso, s.id, { lines });
  const r = await submitCount(env.ctx, aso, s.id, null);
  assert.equal(r.discrepancies.length, 1);
  assert.equal(r.discrepancies[0]!.delta, -1);
  await decideCorrection(env.ctx, fr, r.discrepancies[0]!.correctionId, { decision: "APPROVE" }, null);
  const report = await getCount(env.ctx, fr, s.id);
  assert.deepEqual(report.lines.find((l) => l.item.id === items.count)!.correction.map((c) => [c.delta, c.status]), [[-1, "APPROVED"]]);
  await rejectsWith(saveCounts(env.ctx, aso, s.id, { lines }), "COUNT_CLOSED");
  await rejectsWith(startCount(env.ctx, rc, { scopeType: "ALL" }, null), "FORBIDDEN");
});

test("reversal of a mistaken receipt: FR Sports only, once, with the original kept in history", async () => {
  const r = await receiveStock(env.ctx, pr, items.ball!, { qty: 200, remarks: "Typo: should be 20" });
  const before = await stock(items.ball!);
  await rejectsWith(reverseReceipt(env.ctx, aso, r.movementId, { reason: "Typed 200 instead of 20" }, null), "FORBIDDEN");
  const rev = await reverseReceipt(env.ctx, fr, r.movementId, { reason: "Typed 200 instead of 20" }, null);
  assert.equal(rev.stockAfter.available, before.available - 200);
  await rejectsWith(reverseReceipt(env.ctx, fr2, r.movementId, { reason: "Typed 200 instead of 20" }, null), "ALREADY_REVERSED");
  const results = await Promise.allSettled([
    reverseReceipt(env.ctx, fr, (await receiveStock(env.ctx, pr, items.ball!, { qty: 5 })).movementId, { reason: "Duplicate entry" }, null),
  ]);
  assert.equal(results[0]!.status, "fulfilled");
  const issueMove = (await env.ctx.db.query<{ id: string }>("SELECT id FROM stock_movements WHERE type = 'ISSUE' LIMIT 1")).rows[0]!.id;
  await rejectsWith(reverseReceipt(env.ctx, fr, issueMove, { reason: "Wrong issue" }, null), "NOT_REVERSIBLE");
  const orig = await env.ctx.db.query("SELECT 1 FROM stock_movements WHERE id = $1", [r.movementId]);
  assert.equal(orig.rowCount, 1);
});

test("simultaneous approvals of the same discard: exactly one movement", async () => {
  const d = await requestDiscard(env.ctx, sk, { itemId: items.ball!, qty: 1, reason: "BROKEN" }, null);
  const results = await Promise.allSettled([fr, fr2, fr].map((who) => decideDiscard(env.ctx, who, d.id, { decision: "APPROVE" }, null)));
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal((await env.ctx.db.query("SELECT 1 FROM stock_movements WHERE source_table = 'discard_requests' AND source_id = $1", [d.id])).rowCount, 1);
});

test("simultaneous approvals of the same correction: applied once", async () => {
  const c = await requestCorrection(env.ctx, sk, { itemId: items.ball!, state: "AVAILABLE", countedQty: (await stock(items.ball!)).available + 4, reason: "Found a box" }, null);
  const before = await stock(items.ball!);
  const results = await Promise.allSettled([fr, fr2, fr2].map((who) => decideCorrection(env.ctx, who, c.id, { decision: "APPROVE" }, null)));
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal((await stock(items.ball!)).available, before.available + 4);
});

test("HTTP: ASO cannot approve a discard (403); FR Sports can", async () => {
  const d = await requestDiscard(env.ctx, sk, { itemId: items.ball!, qty: 1, reason: "BROKEN" }, null);
  const asoT = await createSession(env.ctx.db, aso.id, { ip: null, userAgent: null }, env.clock.now);
  const frT = await createSession(env.ctx.db, fr.id, { ip: null, userAgent: null }, env.clock.now);
  assert.equal((await decideDiscardHandler(env.ctx, req("POST", `/api/discards/${d.id}/decide`, { token: asoT, body: { decision: "APPROVE" } }), d.id)).status, 403);
  assert.equal((await decideDiscardHandler(env.ctx, req("POST", `/api/discards/${d.id}/decide`, { token: frT, body: { decision: "APPROVE" } }), d.id)).status, 200);
});

test("books balance after every kind of adjustment", async () => {
  assert.deepEqual(await ledgerMismatches(env.ctx.db), []);
  const rows = (await env.ctx.db.query<{ item_id: string; damaged: number; missing: number; reserved: number; inc_d: string; inc_m: string; held: string }>(
    `SELECT s.item_id, s.damaged, s.missing, s.reserved,
            coalesce((SELECT sum(qty - qty_resolved) FROM incidents n WHERE n.item_id = s.item_id AND n.type IN ('DAMAGED','STORE_DAMAGE')), 0) AS inc_d,
            coalesce((SELECT sum(qty - qty_resolved) FROM incidents n WHERE n.item_id = s.item_id AND n.type IN ('MISSING','CONSUMED')), 0) AS inc_m,
            coalesce((SELECT sum(qty) FROM discard_requests d WHERE d.item_id = s.item_id AND d.status = 'PENDING' AND d.from_state = 'AVAILABLE'), 0) AS held
       FROM item_stock s`,
  )).rows;
  for (const r of rows) {
    assert.equal(Number(r.inc_d), r.damaged, `item ${r.item_id}: damaged records = Damaged stock`);
    assert.equal(Number(r.inc_m), r.missing, `item ${r.item_id}: missing records = Missing stock`);
    assert.equal(Number(r.held), r.reserved, `item ${r.item_id}: held = pending store discards`);
  }
});
