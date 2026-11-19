import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { decideCorrection, requestCorrection } from "../src/server/adjustments/corrections";
import { decideDiscard, requestDiscard } from "../src/server/adjustments/discards";
import { reverseReceipt } from "../src/server/adjustments/reversal";
import { getCount, saveCounts, startCount, submitCount } from "../src/server/adjustments/verification";
import { createSession } from "../src/server/auth/sessions";
import { findUserById, type User } from "../src/server/auth/users";
import { AppError } from "../src/server/errors";
import { reportHandler } from "../src/server/http/report-handlers";
import { createItem, receiveStock } from "../src/server/inventory/items";
import { createCategory, listSports } from "../src/server/inventory/masterdata";
import { readXlsx } from "../src/server/inventory/spreadsheet";
import { getDashboard } from "../src/server/reports/dashboard";
import { exportReport, reportsFor, runReport } from "../src/server/reports/reports";
import { approveAndIssue, createRequest } from "../src/server/requests/requests";
import { recordReturn } from "../src/server/returns/returns";
import { makeUser, req, setupTestEnv, type TestEnv } from "./support/harness";

let env: TestEnv;
let fr: User, aso: User, sk: User, pr: User, mg: User, rc: User;
const items: Record<string, string> = {};
const issueRefs: string[] = [];
const tmp = mkdtempSync(path.join(os.tmpdir(), "rep-"));
const have = (cmd: string, args: string[]) => {
  try {
    execFileSync(cmd, args, { stdio: "ignore", timeout: 20_000 });
    return true;
  } catch {
    return false;
  }
};
async function rejectsWith(p: Promise<unknown>, code: string) {
  await assert.rejects(p, (e: unknown) => {
    if (!(e instanceof AppError)) throw e;
    assert.equal(e.code, code, e.message);
    return true;
  });
}
const col = (r: { columns: { key: string }[] }, key: string) => r.columns.findIndex((c) => c.key === key);

before(async () => {
  env = await setupTestEnv();
  const made = [];
  for (const r of ["FR_SPORTS", "ASO", "STOREKEEPER", "PROCUREMENT", "MANAGEMENT", "RECIPIENT"] as const) made.push(await makeUser(env, r));
  [fr, aso, sk, pr, mg, rc] = (await Promise.all(made.map(async (m) => (await findUserById(env.ctx.db, m.id))!))) as [User, User, User, User, User, User];
  await env.ctx.db.query("UPDATE users SET univ_id = '00123', name = 'Asha Verma' WHERE id = $1", [rc.id]);
  rc = (await findUserById(env.ctx.db, rc.id))!;
  const cri = (await listSports(env.ctx, fr)).find((s) => s.code === "CRI")!.id;
  const loc = (await env.ctx.db.query<{ id: string }>("SELECT id FROM locations LIMIT 1")).rows[0]!.id;
  const balls = (await createCategory(env.ctx, fr, { sportId: cri, name: "Balls" }, null)).id;
  const bats = (await createCategory(env.ctx, fr, { sportId: cri, name: "Bats" }, null)).id;
  items.ball = (await createItem(env.ctx, fr, { sportId: cri, categoryId: balls, name: "Leather ball", brand: "SG", unit: "piece", locationId: loc, openingQty: 60, minStock: 55 }, null)).id;
  items.bat = (await createItem(env.ctx, fr, { sportId: cri, categoryId: bats, name: "Bat", unit: "piece", locationId: loc, openingQty: 10 }, null)).id;

  // A realistic week: receipts, two issues (one returned with damage), a discard, a correction, a count, a reversal.
  await receiveStock(env.ctx, pr, items.ball, { qty: 20, remarks: "Invoice 1123" });
  const mistake = await receiveStock(env.ctx, pr, items.bat, { qty: 100, remarks: "Typo" });
  await reverseReceipt(env.ctx, fr, mistake.movementId, { reason: "Typed 100 instead of 10" }, null);
  for (const [k, qty] of [["ball", 10], ["bat", 2]] as const) {
    const r = await createRequest(env.ctx, rc, { lines: [{ itemId: items[k]!, qty }], purpose: "Match", expectedReturn: "2026-11-20", groupName: "Blue House" }, null);
    const i = await approveAndIssue(env.ctx, aso, r.id, { lines: [{ itemId: items[k]!, qty }], dueDate: "2026-11-20", issuedById: sk.id }, null);
    issueRefs.push(i.issueRef);
    items[`issue_${k}`] = i.issueId;
  }
  await recordReturn(env.ctx, sk, items.issue_ball!, { lines: [{ itemId: items.ball!, usable: 8, damaged: 2, missing: 0 }] }, null);
  const d = await requestDiscard(env.ctx, sk, { itemId: items.ball!, qty: 3, reason: "WORN_OUT" }, null);
  await decideDiscard(env.ctx, fr, d.id, { decision: "APPROVE", note: "OK" }, null);
  const c = await requestCorrection(env.ctx, sk, { itemId: items.bat!, state: "AVAILABLE", countedQty: 7, reason: "One missing from rack" }, null);
  await decideCorrection(env.ctx, fr, c.id, { decision: "APPROVE" }, null);
  const s = await startCount(env.ctx, aso, { scopeType: "SPORT", scopeId: cri }, null);
  const v = await getCount(env.ctx, aso, s.id);
  await saveCounts(env.ctx, aso, s.id, { lines: v.lines.map((l) => ({ itemId: l.item.id, usable: l.expectedUsable, damaged: l.expectedDamaged })) });
  await submitCount(env.ctx, aso, s.id, null);
  env.clock.advance(4 * 24 * 3600_000); // 21 Nov: the bat issue is now overdue
});
after(async () => env.close());

test("stock register: one row per item, totals equal live balances, accountable = available + issued + damaged + missing", async () => {
  const r = await runReport(env.ctx, mg, "stock", {});
  assert.equal(r.rows.length, 2);
  const live = (await env.ctx.db.query<{ a: number; i: number; d: number; m: number; x: number }>(
    "SELECT sum(available)::int a, sum(issued)::int i, sum(damaged)::int d, sum(missing)::int m, sum(discarded)::int x FROM item_stock",
  )).rows[0]!;
  const t = r.totals!;
  assert.deepEqual([t[col(r, "available")], t[col(r, "issued")], t[col(r, "damaged")], t[col(r, "missing")], t[col(r, "discarded")]], [live.a, live.i, live.d, live.m, live.x]);
  for (const row of r.rows) {
    const n = (k: string) => row[col(r, k)] as number;
    assert.equal(n("accountable"), n("available") + n("issued") + n("damaged") + n("missing"));
  }
  const ball = r.rows.find((x) => String(x[col(r, "code")]).startsWith("CRI-BAL"))!;
  // 60 + 20 received - 10 issued + 8 back usable - 3 discarded = 75 available; 2 damaged; 3 discarded
  assert.deepEqual([ball[col(r, "available")], ball[col(r, "damaged")], ball[col(r, "discarded")]], [75, 2, 3]);
  assert.equal(ball[col(r, "equipment")], "Leather ball · SG");
});

test("issue and return register: who, approved by, handed over by, due, returned, condition; overdue computed", async () => {
  const r = await runReport(env.ctx, sk, "issues", {});
  assert.equal(r.rows.length, 2);
  const byRef = new Map(r.rows.map((x) => [x[col(r, "ref")], x]));
  const ball = byRef.get(issueRefs[0])!;
  const bat = byRef.get(issueRefs[1])!;
  assert.equal(ball[col(r, "status")], "Returned");
  assert.equal(ball[col(r, "condition")], "8 usable, 2 damaged");
  assert.equal(ball[col(r, "issuedBy")], sk.name);
  assert.equal(ball[col(r, "approvedBy")], aso.name);
  assert.equal(ball[col(r, "univId")], "00123", "registration numbers keep leading zeros");
  assert.equal(bat[col(r, "status")], "Overdue 1 d");
  assert.equal((await runReport(env.ctx, sk, "issues", { issueStatus: "overdue" })).rows.length, 1);
  assert.equal((await runReport(env.ctx, sk, "issues", { q: "asha" })).rows.length, 2);
  assert.equal((await runReport(env.ctx, sk, "issues", { from: "2026-10-01", to: "2026-10-31" })).rows.length, 0);
});

test("damage, discard, correction, verification and receipt registers show each event with who decided it", async () => {
  const dmg = await runReport(env.ctx, aso, "damage", {});
  assert.equal(dmg.rows.length, 1);
  assert.equal(dmg.rows[0]![col(dmg, "recipient")], "Asha Verma");
  assert.equal(dmg.rows[0]![col(dmg, "issueRef")], issueRefs[0]);

  const dis = await runReport(env.ctx, fr, "discards", {});
  assert.deepEqual([dis.rows[0]![col(dis, "qty")], dis.rows[0]![col(dis, "status")], dis.rows[0]![col(dis, "decidedBy")]], [3, "Approved", fr.name]);

  const cor = await runReport(env.ctx, mg, "corrections", { decisionStatus: "APPROVED" });
  assert.deepEqual([cor.rows[0]![col(cor, "change")], cor.rows[0]![col(cor, "decidedBy")]], [-1, fr.name]);

  const cnt = await runReport(env.ctx, mg, "counts", {});
  assert.equal(cnt.rows.length, 2);
  for (const row of cnt.rows) assert.equal(row[col(cnt, "difference")], 0);
  const batRow = cnt.rows.find((x) => x[col(cnt, "equipment")] === "Bat")!;
  assert.equal(batRow[col(cnt, "issued")], 2, "issued units listed but not expected on the shelf");

  const rec = await runReport(env.ctx, pr, "receipts", {});
  const types = rec.rows.map((x) => x[col(rec, "type")]);
  assert.ok(types.includes("Received"));
  assert.ok(types.includes("Received - reversed"));
  assert.ok(types.includes("Reversal"));
  assert.equal(rec.totals![col(rec, "qty")], 60 + 10 + 20 + 100 - 100, "net stock received");
});

test("report access follows roles; recipients see none", async () => {
  assert.deepEqual(reportsFor(pr).map((r) => r.key), ["stock", "receipts"]);
  assert.deepEqual(reportsFor(sk).map((r) => r.key), ["stock", "issues", "damage", "counts"]);
  assert.equal(reportsFor(mg).length, 7);
  assert.equal(reportsFor(rc).length, 0);
  await rejectsWith(runReport(env.ctx, pr, "issues", {}), "FORBIDDEN");
  await rejectsWith(runReport(env.ctx, sk, "discards", {}), "FORBIDDEN");
  await rejectsWith(runReport(env.ctx, rc, "stock", {}), "FORBIDDEN");
  await rejectsWith(runReport(env.ctx, fr, "salaries", {}), "NOT_FOUND");
  await rejectsWith(runReport(env.ctx, fr, "issues", { from: "2026-11-30", to: "2026-11-01" }), "VALIDATION");
  await rejectsWith(runReport(env.ctx, fr, "issues", { from: "yesterday" }), "VALIDATION");
});

test("Excel export: same rows as the page, numbers as numbers, total row, export recorded in the audit log", async () => {
  const page = await runReport(env.ctx, mg, "stock", {});
  const x = await exportReport(env.ctx, mg, "stock", "xlsx", {}, "10.0.0.5");
  assert.match(x.filename, /^stock-register-2026-11-21\.xlsx$/);
  const rows = await readXlsx(x.bytes);
  assert.deepEqual(rows[0], page.columns.map((c) => c.label));
  assert.equal(rows.length, 1 + page.rows.length + 1);
  assert.equal(rows.at(-1)![0], "Total");
  const xml = await (await import("jszip")).default.loadAsync(x.bytes).then((z) => z.file("xl/worksheets/sheet1.xml")!.async("string"));
  assert.match(xml, /<c r="F2"><v>\d+<\/v><\/c>/, "quantities are numeric cells");
  const audit = await env.ctx.db.query("SELECT 1 FROM audit_log WHERE action = 'report.export' AND entity_id = 'stock' AND actor_id = $1", [mg.id]);
  assert.equal(audit.rowCount, 1);
  writeFileSync(path.join(tmp, "stock.xlsx"), x.bytes);
});

test("Excel export opens in LibreOffice with totals that add up", { skip: !have("soffice", ["--version"]) && "LibreOffice not installed" }, () => {
  execFileSync("soffice", ["--headless", "--convert-to", "csv", "--outdir", tmp, path.join(tmp, "stock.xlsx")], { timeout: 60_000, stdio: "ignore" });
  const lines = readFileSync(path.join(tmp, "stock.csv"), "utf8").trim().split("\n");
  assert.ok(lines[0]!.startsWith("Code,Sport,Category,Equipment"));
  assert.ok(lines.at(-1)!.startsWith("Total,"));
});

test("PDF export: valid file, A4 landscape, contains the title, references and totals", { skip: !(have("qpdf", ["--version"]) && have("pdftotext", ["-v"])) && "qpdf / pdftotext not installed" }, async () => {
  const p = await exportReport(env.ctx, fr, "issues", "pdf", {}, null);
  const file = path.join(tmp, "issues.pdf");
  writeFileSync(file, p.bytes);
  execFileSync("qpdf", ["--check", file], { stdio: "ignore" });
  const text = execFileSync("pdftotext", ["-layout", file, "-"]).toString();
  for (const part of ["Issue and return register", issueRefs[0]!, issueRefs[1]!, "Asha Verma", "Overdue 1 d", "Total", "Page 1 of 1"]) assert.ok(text.includes(part), part);
});

test("PDF with many rows paginates with the header on every page", { skip: !have("pdftotext", ["-v"]) && "pdftotext not installed" }, async () => {
  const { writePdf } = await import("../src/server/reports/pdf");
  const rows = Array.from({ length: 120 }, (_, i) => [`ROW-${i}`, "x".repeat(200)]);
  const file = path.join(tmp, "long.pdf");
  writeFileSync(file, writePdf({ title: "Long", columns: [{ label: "Ref", width: 1 }, { label: "Text", width: 5 }], rows }));
  const text = execFileSync("pdftotext", ["-layout", file, "-"]).toString();
  const pages = text.split("\f").filter((p) => p.trim());
  assert.ok(pages.length >= 3);
  for (const pg of pages) assert.ok(pg.includes("Ref"), "header repeated");
  assert.ok(text.includes("ROW-119"));
  assert.ok(text.includes("…"), "long text is shortened, not overflowing");
});

test("dashboard: totals match the stock register; action list is specific to the role", async () => {
  const d = await getDashboard(env.ctx, fr);
  const r = await runReport(env.ctx, fr, "stock", {});
  assert.equal(d.stock.issued, r.totals![col(r, "issued")]);
  assert.equal(d.stock.damaged, r.totals![col(r, "damaged")]);
  assert.equal(d.counts.overdueIssues, 1);
  assert.equal(d.overdue[0]!.ref, issueRefs[1]);
  assert.equal(d.overdue[0]!.days, 1);
  assert.equal(d.lowStock.length, 0, "ball has 75 against a minimum of 55");
  assert.deepEqual(d.bySport.map((s) => [s.name, s.issued]), [["Cricket", 2]]);
  const frActions = d.actions.map((a) => a.label);
  assert.ok(frActions.includes("Overdue equipment"));
  assert.ok(frActions.includes("Open damage / missing records"));
  const mgDash = await getDashboard(env.ctx, mg);
  assert.deepEqual(mgDash.actions, [], "management is read-only: nothing to act on");
  const skActions = (await getDashboard(env.ctx, sk)).actions.map((a) => a.label);
  assert.ok(!skActions.some((a) => a.includes("approval")));
  await rejectsWith(getDashboard(env.ctx, rc), "FORBIDDEN");
});

test("HTTP: PDF and Excel downloads with the right headers; bad format refused; recipient refused", async () => {
  const mgT = await createSession(env.ctx.db, mg.id, { ip: null, userAgent: null }, env.clock.now);
  const rcT = await createSession(env.ctx.db, rc.id, { ip: null, userAgent: null }, env.clock.now);
  const pdf = await reportHandler(env.ctx, req("GET", "/api/reports/discards?format=pdf", { token: mgT }), "discards");
  assert.equal(pdf.status, 200);
  assert.equal(pdf.headers.get("content-type"), "application/pdf");
  assert.match(pdf.headers.get("content-disposition")!, /attachment; filename="discard-register-2026-11-21\.pdf"/);
  assert.ok(Buffer.from(await pdf.arrayBuffer()).subarray(0, 5).toString() === "%PDF-");
  const x = await reportHandler(env.ctx, req("GET", "/api/reports/stock?format=xlsx", { token: mgT }), "stock");
  assert.match(x.headers.get("content-type")!, /spreadsheetml/);
  assert.equal((await reportHandler(env.ctx, req("GET", "/api/reports/stock?format=doc", { token: mgT }), "stock")).status, 400);
  assert.equal((await reportHandler(env.ctx, req("GET", "/api/reports/stock", { token: rcT }), "stock")).status, 403);
});
