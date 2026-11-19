import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { findUserById, type User } from "../src/server/auth/users";
import { AppError } from "../src/server/errors";
import { buildTemplate, COLUMNS, commitImport, previewImport } from "../src/server/inventory/import";
import { createItem, listItems } from "../src/server/inventory/items";
import { ledgerMismatches } from "../src/server/inventory/ledger";
import { createCategory, listSports } from "../src/server/inventory/masterdata";
import { readCsv, readSpreadsheet, readXlsx, writeXlsx } from "../src/server/inventory/spreadsheet";
import { importPreviewHandler, importTemplateHandler } from "../src/server/http/inventory-handlers";
import { makeUser, ORIGIN, setupTestEnv, type TestEnv } from "./support/harness";

let env: TestEnv;
let fr: User, aso: User, pr: User, sk: User;
let frToken: string, skToken: string;
let cricketId: string, ballsCatId: string, storeId: string;
const tmp = mkdtempSync(path.join(os.tmpdir(), "imp-"));

const u = async (id: string) => (await findUserById(env.ctx.db, id))!;
async function rejectsWith(p: Promise<unknown>, code: string) {
  await assert.rejects(p, (e: unknown) => {
    if (!(e instanceof AppError)) throw e;
    assert.equal(e.code, code, e.message);
    return true;
  });
}
const HEADER = ["Item code", "Sport", "Category", "Equipment name", "Brand", "Model", "Size", "Specification", "Unit", "Location", "Quantity", "Minimum stock", "Consumable (Y/N)", "Remarks"];
const csv = (rows: string[][]) => new TextEncoder().encode([HEADER, ...rows].map((r) => r.map((c) => (/[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(",")).join("\n"));
const row = (o: Partial<Record<"code" | "sport" | "category" | "name" | "brand" | "unit" | "location" | "qty" | "min" | "cons" | "remarks", string>>) => [
  o.code ?? "", o.sport ?? "", o.category ?? "", o.name ?? "", o.brand ?? "", "", "", "", o.unit ?? "", o.location ?? "", o.qty ?? "", o.min ?? "", o.cons ?? "", o.remarks ?? "",
];
async function countMovements() {
  return Number((await env.ctx.db.query<{ n: string }>("SELECT count(*) AS n FROM stock_movements")).rows[0]!.n);
}
function have(cmd: string, args: string[]): boolean {
  try {
    execFileSync(cmd, args, { stdio: "ignore", timeout: 20_000 });
    return true;
  } catch {
    return false;
  }
}

before(async () => {
  env = await setupTestEnv();
  const a = await makeUser(env, "FR_SPORTS");
  const b = await makeUser(env, "ASO");
  const c = await makeUser(env, "PROCUREMENT");
  const d = await makeUser(env, "STOREKEEPER");
  [fr, aso, pr, sk] = (await Promise.all([a, b, c, d].map((x) => u(x.id)))) as [User, User, User, User];
  frToken = a.token;
  skToken = d.token;
  cricketId = (await listSports(env.ctx, fr)).find((s) => s.code === "CRI")!.id;
  ballsCatId = (await createCategory(env.ctx, fr, { sportId: cricketId, name: "Balls" }, null)).id;
  storeId = (await env.ctx.db.query<{ id: string }>("SELECT id FROM locations LIMIT 1")).rows[0]!.id;
});
after(async () => env.close());

test("template: three sheets, the expected header row, readable back", async () => {
  const bytes = await buildTemplate(env.ctx, fr);
  const rows = await readXlsx(bytes);
  assert.deepEqual(rows[0], COLUMNS.map((c) => c.header));
  assert.deepEqual(rows[0], HEADER);
  writeFileSync(path.join(tmp, "template.xlsx"), bytes);
});

test("template opens in LibreOffice (real spreadsheet software)", { skip: !have("soffice", ["--version"]) && "LibreOffice not installed" }, () => {
  execFileSync("soffice", ["--headless", "--convert-to", "csv", "--outdir", tmp, path.join(tmp, "template.xlsx")], { timeout: 60_000, stdio: "ignore" });
  const out = readFileSync(path.join(tmp, "template.csv"), "utf8");
  assert.ok(out.startsWith("Item code,Sport,Category,Equipment name"), out.slice(0, 80));
});

test("reads .xlsx files saved by openpyxl (shared strings, numeric cells, gaps)", { skip: !have("python3", ["-c", "import openpyxl"]) && "openpyxl not installed" }, async () => {
  const file = path.join(tmp, "openpyxl.xlsx");
  execFileSync("python3", ["-c", `
import openpyxl, sys
wb = openpyxl.Workbook(); ws = wb.active; ws.title = "Stock"
ws.append(${JSON.stringify(HEADER)})
ws.append(["", "Cricket", "Balls", "Ball & <stump> \\"special\\"", "SG", None, None, None, "pcs", None, 12, 3, "N", "Inv 9"])
ws.append([])
ws.append(["", "Cricket", "Balls", "Ünïcödé ball", None, None, None, None, None, None, 7.0, None, "Y", None])
wb.save(sys.argv[1])
`, file]);
  const rows = await readXlsx(readFileSync(file));
  assert.deepEqual(rows[1], ["", "Cricket", "Balls", 'Ball & <stump> "special"', "SG", "", "", "", "pcs", "", "12", "3", "N", "Inv 9"]);
  assert.equal(rows[3]![3], "Ünïcödé ball");
  assert.equal(rows[3]![10], "7");
});

test("reads .xlsx files converted by LibreOffice from CSV", { skip: !have("soffice", ["--version"]) && "LibreOffice not installed" }, async () => {
  const src = path.join(tmp, "lo-source.csv");
  writeFileSync(src, Buffer.from(csv([row({ sport: "Cricket", category: "Balls", name: "LO ball", qty: "15" })])));
  execFileSync("soffice", ["--headless", "--convert-to", "xlsx", "--outdir", tmp, src], { timeout: 60_000, stdio: "ignore" });
  const rows = await readXlsx(readFileSync(path.join(tmp, "lo-source.xlsx")));
  assert.equal(rows[1]![3], "LO ball");
  assert.equal(rows[1]![10], "15");
});

test("CSV reader: quotes, commas, semicolons, BOM, CRLF", () => {
  assert.deepEqual(readCsv('﻿a,"b, c","d ""e"""\r\n1,2,3\r\n'), [["a", "b, c", 'd "e"'], ["1", "2", "3"]]);
  assert.deepEqual(readCsv("a;b;c\n1;2;3"), [["a", "b", "c"], ["1", "2", "3"]]);
});

test("unreadable, old-format and incomplete files give clear messages", async () => {
  await rejectsWith(readSpreadsheet("x.xlsx", new TextEncoder().encode("not a zip")), "FILE_UNREADABLE");
  await rejectsWith(readSpreadsheet("x.xls", new Uint8Array([1, 2, 3])), "FILE_OLD_FORMAT");
  await rejectsWith(previewImport(env.ctx, fr, { name: "x.csv", bytes: new TextEncoder().encode("Sport,Name\nCricket,Ball") }), "MISSING_COLUMNS");
  await rejectsWith(previewImport(env.ctx, fr, { name: "x.csv", bytes: csv([]) }), "EMPTY_FILE");
});

test("preview shows what each row will do and changes nothing", async () => {
  const existing = await createItem(env.ctx, fr, { sportId: cricketId, categoryId: ballsCatId, name: "Leather ball", brand: "SG", unit: "piece", locationId: storeId, openingQty: 40 }, null);
  const before = await countMovements();
  const file = csv([
    row({ sport: "Cricket", category: "Balls", name: "Tennis ball", unit: "pcs", qty: "30", min: "5" }), // 2 new
    row({ code: existing.code.toLowerCase(), qty: "20", remarks: "Invoice 77" }), // 3 add by code
    row({ sport: "cri", category: "balls", name: "LEATHER BALL", brand: "sg", qty: "5" }), // 4 matches existing -> merged into row 3
    row({ sport: "Cricket", category: "Balls", name: "Tennis ball", qty: "10" }), // 5 merged into 2
    row({ sport: "Cricket", category: "Stumps", name: "Wooden stumps", unit: "set", qty: "4" }), // 6 new category (FR)
    row({ sport: "Curling", category: "Stones", name: "Stone", qty: "2" }), // 7 unknown sport
    row({ sport: "Cricket", category: "Balls", name: "Half ball", qty: "2.5" }), // 8 bad qty
    row({ code: "CRI-XXX-9999", qty: "1" }), // 9 unknown code
    row({ sport: "Cricket", category: "Balls", name: "Odd unit", unit: "kg", qty: "1" }), // 10 bad unit
  ]);
  const p = await previewImport(env.ctx, fr, { name: "stock.csv", bytes: file });
  const byRow = new Map(p.plan.map((r) => [r.row, r]));
  assert.equal(byRow.get(2)!.action, "NEW_ITEM");
  assert.equal(byRow.get(2)!.qty, 40, "row 5 merged into row 2: 30 + 10");
  assert.equal(byRow.get(2)!.unit, "piece");
  assert.equal(byRow.get(3)!.action, "ADD_STOCK");
  assert.equal(byRow.get(3)!.qty, 25, "row 4 merged into row 3: 20 + 5");
  assert.equal(byRow.get(4)!.action, "MERGED");
  assert.equal(byRow.get(4)!.mergedInto, 3);
  assert.equal(byRow.get(5)!.mergedInto, 2);
  assert.equal(byRow.get(6)!.action, "NEW_ITEM");
  assert.equal(byRow.get(6)!.categoryId, null);
  assert.deepEqual(p.summary.newCategories, ["Cricket › Stumps"]);
  for (const r of [7, 8, 9, 10]) assert.equal(byRow.get(r)!.action, "ERROR", `row ${r}`);
  assert.match(byRow.get(7)!.errors[0]!, /Sport "Curling" not found/);
  assert.match(byRow.get(8)!.errors[0]!, /not a whole number/);
  assert.equal(p.summary.errors, 4);
  assert.equal(p.canCommit, false);
  assert.equal(await countMovements(), before, "preview changed nothing");
  await rejectsWith(commitImport(env.ctx, fr, p.batchId, null), "IMPORT_HAS_ERRORS");
  assert.equal(await countMovements(), before, "refused import changed nothing");
});

test("clean import commits everything in one go; repeated or simultaneous confirmation imports once", async () => {
  const start = await listItems(env.ctx, fr, { q: "Leather ball" });
  const leather = start.items[0]!;
  const file = csv([
    row({ sport: "Cricket", category: "Balls", name: "Tennis ball", unit: "pcs", qty: "30", min: "5" }),
    row({ code: leather.code, qty: "20", remarks: "Invoice 77" }),
    row({ sport: "Cricket", category: "Balls", name: "Tennis ball", qty: "10" }),
    row({ sport: "Cricket", category: "Stumps", name: "Wooden stumps", unit: "set", qty: "4" }),
    row({ sport: "Cricket", category: "Stumps", name: "Bails", unit: "pair", qty: "0", cons: "Y" }),
  ]);
  const p = await previewImport(env.ctx, fr, { name: "clean.csv", bytes: file });
  assert.equal(p.canCommit, true);
  const results = await Promise.allSettled([commitImport(env.ctx, fr, p.batchId, null), commitImport(env.ctx, fr, p.batchId, null)]);
  const ok = results.filter((r) => r.status === "fulfilled");
  assert.equal(ok.length, 1);
  const failed = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
  assert.equal((failed.reason as AppError).code, "ALREADY_IMPORTED");
  const res = (ok[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof commitImport>>>).value;
  assert.equal(res.createdItems.length, 3);
  assert.deepEqual(res.createdCategories.length, 1);
  assert.equal(res.stockAdded[0]!.availableAfter, leather.stock.available + 20);
  const tennis = (await listItems(env.ctx, fr, { q: "Tennis ball" })).items[0]!;
  assert.equal(tennis.stock.available, 40);
  assert.equal(tennis.minStock, 5);
  const stumps = (await listItems(env.ctx, fr, { q: "Wooden stumps" })).items[0]!;
  assert.match(stumps.code, /^CRI-STU-0001$/);
  const bails = (await listItems(env.ctx, fr, { q: "Bails" })).items[0]!;
  assert.equal(bails.stock.available, 0);
  assert.equal(bails.isConsumable, true);
  assert.equal(bails.unit, "pair");
  const mv = await env.ctx.db.query("SELECT 1 FROM stock_movements WHERE source_table = 'import_batches' AND source_id = $1", [p.batchId]);
  assert.equal(mv.rowCount, 3, "tennis opening, leather receipt, stumps opening (bails had 0)");
  assert.deepEqual(await ledgerMismatches(env.ctx.db), []);
  await rejectsWith(commitImport(env.ctx, fr, p.batchId, null), "ALREADY_IMPORTED");
});

test("if records change after the preview, confirmation is refused and nothing is imported", async () => {
  const file = csv([
    row({ sport: "Cricket", category: "Balls", name: "Racing ball", qty: "8" }),
    row({ sport: "Cricket", category: "Balls", name: "Tennis ball", qty: "1" }),
  ]);
  const p = await previewImport(env.ctx, fr, { name: "race.csv", bytes: file });
  assert.equal(p.plan[0]!.action, "NEW_ITEM");
  await createItem(env.ctx, aso, { sportId: cricketId, categoryId: ballsCatId, name: "Racing ball", unit: "piece", locationId: storeId, openingQty: 0 }, null);
  const tennisBefore = (await listItems(env.ctx, fr, { q: "Tennis ball" })).items[0]!.stock.available;
  await rejectsWith(commitImport(env.ctx, fr, p.batchId, null), "PREVIEW_OUTDATED");
  assert.equal((await listItems(env.ctx, fr, { q: "Tennis ball" })).items[0]!.stock.available, tennisBefore, "no partial import");
});

test("previews expire after 30 minutes and belong to the person who uploaded them", async () => {
  const file = csv([row({ sport: "Cricket", category: "Balls", name: "Tennis ball", qty: "1" })]);
  const p = await previewImport(env.ctx, fr, { name: "late.csv", bytes: file });
  await rejectsWith(commitImport(env.ctx, aso, p.batchId, null), "NOT_FOUND");
  env.clock.advance(31 * 60_000);
  await rejectsWith(commitImport(env.ctx, fr, p.batchId, null), "PREVIEW_EXPIRED");
});

test("role limits: procurement may only add stock; storekeepers cannot import; ASO cannot create categories", async () => {
  const tennis = (await listItems(env.ctx, fr, { q: "Tennis ball" })).items[0]!;
  const prPlan = await previewImport(env.ctx, pr, {
    name: "pr.csv",
    bytes: csv([row({ code: tennis.code, qty: "6" }), row({ sport: "Cricket", category: "Balls", name: "Brand new ball", qty: "2" })]),
  });
  assert.equal(prPlan.plan[0]!.action, "ADD_STOCK");
  assert.equal(prPlan.plan[1]!.action, "ERROR");
  assert.match(prPlan.plan[1]!.errors.join(" "), /only be created by FR Sports or the Assistant Sports Officer/);
  const prOk = await previewImport(env.ctx, pr, { name: "pr2.csv", bytes: csv([row({ code: tennis.code, qty: "6" })]) });
  await commitImport(env.ctx, pr, prOk.batchId, null);
  assert.equal((await listItems(env.ctx, fr, { q: "Tennis ball" })).items[0]!.stock.available, tennis.stock.available + 6);

  const asoPlan = await previewImport(env.ctx, aso, { name: "aso.csv", bytes: csv([row({ sport: "Cricket", category: "Helmets", name: "Helmet", qty: "2" })]) });
  assert.match(asoPlan.plan[0]!.errors.join(" "), /Ask FR Sports to add it/);
  await rejectsWith(previewImport(env.ctx, sk, { name: "sk.csv", bytes: csv([row({ code: tennis.code, qty: "1" })]) }), "FORBIDDEN");
});

test("HTTP: template download and multipart upload; storekeeper refused", async () => {
  const t = await importTemplateHandler(env.ctx, new Request(`${ORIGIN}/api/import/template`, { headers: { cookie: `__Host-sei_session=${frToken}` } }));
  assert.equal(t.status, 200);
  assert.match(t.headers.get("content-type")!, /spreadsheetml/);
  const rows = await readXlsx(new Uint8Array(await t.arrayBuffer()));
  assert.equal(rows[0]![0], "Item code");

  const xlsx = await writeXlsx([{ name: "Stock", rows: [HEADER, row({ sport: "Cricket", category: "Balls", name: "Upload ball", qty: "3" })] }]);
  const form = new FormData();
  form.append("file", new Blob([xlsx as Uint8Array<ArrayBuffer>]), "upload.xlsx");
  const mk = (token: string) =>
    new Request(`${ORIGIN}/api/import/preview`, { method: "POST", headers: { cookie: `__Host-sei_session=${token}`, origin: ORIGIN }, body: form });
  const ok = await importPreviewHandler(env.ctx, mk(frToken));
  assert.equal(ok.status, 200);
  const body = (await ok.json()) as { plan: { action: string }[]; canCommit: boolean };
  assert.equal(body.plan[0]!.action, "NEW_ITEM");
  assert.equal(body.canCommit, true);
  assert.equal((await importPreviewHandler(env.ctx, mk(skToken))).status, 403);
});
