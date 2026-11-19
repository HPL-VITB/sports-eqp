/**
 * Renders every page of the portal for every role against a seeded test database, writes the HTML, and records
 * which role can open which page. Screenshots are taken afterwards with headless Chrome (see run.sh).
 * This is a development check only; production pages are rendered by Next.js with real React.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { jsx } from "react/jsx-runtime";
import { NavigationSignal } from "next/navigation";
import { requestCorrection } from "../../src/server/adjustments/corrections";
import { requestDiscard } from "../../src/server/adjustments/discards";
import { startCount } from "../../src/server/adjustments/verification";
import type { Role } from "../../src/server/auth/permissions";
import { createSession } from "../../src/server/auth/sessions";
import { findUserById, type User } from "../../src/server/auth/users";
import { createItem, receiveStock } from "../../src/server/inventory/items";
import { createCategory, listSports } from "../../src/server/inventory/masterdata";
import { approveAndIssue, createRequest } from "../../src/server/requests/requests";
import { recordReturn } from "../../src/server/returns/returns";
import { makeUser, setupTestEnv } from "../../tests/support/harness";
import { render } from "./render";

import RootLayout from "../../src/app/layout";
import AppLayout from "../../src/app/(app)/layout";
import Home from "../../src/app/page";
import Login from "../../src/app/login/page";
import Profile from "../../src/app/profile/page";
import Forbidden from "../../src/app/forbidden/page";
import Dashboard from "../../src/app/(app)/dashboard/page";
import Inventory from "../../src/app/(app)/inventory/page";
import InventoryNew from "../../src/app/(app)/inventory/new/page";
import InventoryItem from "../../src/app/(app)/inventory/[id]/page";
import InventoryImport from "../../src/app/(app)/inventory/import/page";
import Browse from "../../src/app/(app)/browse/page";
import My from "../../src/app/(app)/my/page";
import Requests from "../../src/app/(app)/requests/page";
import RequestOne from "../../src/app/(app)/requests/[id]/page";
import Returns from "../../src/app/(app)/returns/page";
import ReturnOne from "../../src/app/(app)/returns/[id]/page";
import Adjustments from "../../src/app/(app)/adjustments/page";
import Discards from "../../src/app/(app)/adjustments/discards/page";
import Corrections from "../../src/app/(app)/adjustments/corrections/page";
import Counts from "../../src/app/(app)/adjustments/counts/page";
import CountOne from "../../src/app/(app)/adjustments/counts/[id]/page";
import Reports from "../../src/app/(app)/reports/page";
import ReportOne from "../../src/app/(app)/reports/[key]/page";
import Users from "../../src/app/(app)/admin/users/page";
import Master from "../../src/app/(app)/admin/master/page";
import Emails from "../../src/app/(app)/admin/emails/page";
import Audit from "../../src/app/(app)/admin/audit/page";

type Page = (p: { params: Promise<Record<string, string>>; searchParams: Promise<Record<string, string>> }) => unknown;
const OUT = path.resolve(process.argv[2] ?? "preview-out");
const g = globalThis as { __ctx?: unknown; __token?: string; __path?: string };

async function main() {
  const env = await setupTestEnv();
  g.__ctx = env.ctx;
  const roles: Role[] = ["FR_SPORTS", "ASO", "STOREKEEPER", "PROCUREMENT", "MANAGEMENT", "RECIPIENT"];
  const names = ["Dr. R. Sharma", "K. Iyer", "M. Khan", "P. Nair", "Dean (Student Welfare)", "Asha Verma"];
  const users: Record<string, { user: User; token: string }> = {};
  for (const [i, role] of roles.entries()) {
    const m = await makeUser(env, role);
    await env.ctx.db.query("UPDATE users SET name = $2, univ_id = $3, category = $4 WHERE id = $1", [m.id, names[i], role === "RECIPIENT" ? "24BCE10123" : `EMP${100 + i}`, role === "RECIPIENT" ? "STUDENT" : "STAFF"]);
    users[role] = { user: (await findUserById(env.ctx.db, m.id))!, token: m.token };
  }
  const fr = users.FR_SPORTS!.user, aso = users.ASO!.user, sk = users.STOREKEEPER!.user, pr = users.PROCUREMENT!.user, rc = users.RECIPIENT!.user;

  // Seed data: a few sports, a damaged return, an overdue issue, pending requests, a pending discard and correction, an open count.
  const sports = await listSports(env.ctx, fr);
  const sid = (c: string) => sports.find((s) => s.code === c)!.id;
  const loc = (await env.ctx.db.query<{ id: string }>("SELECT id FROM locations LIMIT 1")).rows[0]!.id;
  const ids: Record<string, string> = {};
  const catalog: [string, string, string, number, number][] = [
    ["CRI", "Balls", "Leather ball (season)", 60, 40], ["CRI", "Bats", "English willow bat", 12, 4], ["CRI", "Protective", "Batting pads (pair)", 16, 4],
    ["FTB", "Balls", "Football size 5", 30, 10], ["BSK", "Balls", "Basketball size 7", 20, 8], ["VOL", "Nets", "Volleyball net", 4, 2],
    ["BAD", "Shuttles", "Feather shuttle (tube of 10)", 25, 30], ["TT", "Bats", "Table tennis bat", 18, 6], ["CHS", "Sets", "Tournament chess set", 10, 2],
  ];
  const cats: Record<string, string> = {};
  for (const [sp, cat, name, qty, min] of catalog) {
    const k = `${sp}-${cat}`;
    cats[k] ??= (await createCategory(env.ctx, fr, { sportId: sid(sp), name: cat }, null)).id;
    ids[name] = (await createItem(env.ctx, fr, { sportId: sid(sp), categoryId: cats[k]!, name, unit: "piece", locationId: loc, openingQty: qty, minStock: min }, null)).id;
  }
  await receiveStock(env.ctx, pr, ids["Football size 5"]!, { qty: 10, remarks: "PO 2026/118" });
  const issue = async (item: string, qty: number, due: string, group: string) => {
    const r = await createRequest(env.ctx, rc, { lines: [{ itemId: ids[item]!, qty }], purpose: "Inter-house match", expectedReturn: due, groupName: group }, null);
    return approveAndIssue(env.ctx, aso, r.id, { lines: [{ itemId: ids[item]!, qty }], dueDate: due, issuedById: sk.id }, null);
  };
  const i1 = await issue("Leather ball (season)", 6, "2026-11-18", "Blue House");
  await recordReturn(env.ctx, sk, i1.issueId, { lines: [{ itemId: ids["Leather ball (season)"]!, usable: 5, damaged: 1, missing: 0 }], remarks: "One ball split at seam" }, null);
  const i2 = await issue("English willow bat", 2, "2026-11-18", "Red House");
  const i3 = await issue("Football size 5", 4, "2026-11-25", "CSE Dept team");
  ids.request = (await createRequest(env.ctx, rc, { lines: [{ itemId: ids["Basketball size 7"]!, qty: 3 }, { itemId: ids["Table tennis bat"]!, qty: 2 }], purpose: "Evening practice", expectedReturn: "2026-11-20" }, null)).id;
  await requestDiscard(env.ctx, sk, { itemId: ids["Feather shuttle (tube of 10)"]!, qty: 2, reason: "WORN_OUT", remarks: "Feathers broken" }, null);
  await requestCorrection(env.ctx, sk, { itemId: ids["Table tennis bat"]!, state: "AVAILABLE", countedQty: 17, reason: "One bat not found on rack" }, null);
  ids.count = (await startCount(env.ctx, aso, { scopeType: "SPORT", scopeId: sid("BSK") }, null)).id;
  ids.item = ids["Leather ball (season)"]!;
  ids.issue = i3.issueId;
  void i2;
  // Move to 20 Nov so the bat issue is overdue; sign everyone in again at the new time.
  env.clock.advance(3 * 24 * 3600_000);
  for (const role of roles) users[role]!.token = await createSession(env.ctx.db, users[role]!.user.id, { ip: null, userAgent: null }, env.clock.now);

  const routes: [string, Page, Record<string, string>?, Record<string, string>?][] = [
    ["/dashboard", Dashboard as unknown as Page], ["/inventory", Inventory as unknown as Page], ["/inventory/new", InventoryNew as unknown as Page],
    [`/inventory/[id]`, InventoryItem as unknown as Page, { id: ids.item }], ["/inventory/import", InventoryImport as unknown as Page],
    ["/browse", Browse as unknown as Page], ["/my", My as unknown as Page], ["/requests", Requests as unknown as Page], ["/requests/[id]", RequestOne as unknown as Page, { id: ids.request }],
    ["/returns", Returns as unknown as Page], ["/returns/[id]", ReturnOne as unknown as Page, { id: ids.issue }],
    ["/adjustments", Adjustments as unknown as Page], ["/adjustments/discards", Discards as unknown as Page], ["/adjustments/corrections", Corrections as unknown as Page],
    ["/adjustments/counts", Counts as unknown as Page], ["/adjustments/counts/[id]", CountOne as unknown as Page, { id: ids.count }],
    ["/reports", Reports as unknown as Page], ["/reports/issues", ReportOne as unknown as Page, { key: "issues" }], ["/reports/stock", ReportOne as unknown as Page, { key: "stock" }],
    ["/reports/discards", ReportOne as unknown as Page, { key: "discards" }], ["/reports/receipts", ReportOne as unknown as Page, { key: "receipts" }],
    ["/admin/users", Users as unknown as Page], ["/admin/master", Master as unknown as Page], ["/admin/emails", Emails as unknown as Page], ["/admin/audit", Audit as unknown as Page],
  ];
  const styles = readFileSync(path.resolve("src/app/globals.css"), "utf8");
  mkdirSync(OUT, { recursive: true });
  const page = (body: string) => `<!doctype html>${body.replace("<html lang=\"en\">", `<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Preview</title><style>${styles}</style></head>`)}`;
  const matrix: Record<string, Record<string, string>> = {};
  const failures: string[] = [];

  const renderOne = async (comp: Page, params: Record<string, string> = {}, inApp = true) => {
    const tree = jsx(comp as never, { params: Promise.resolve(params), searchParams: Promise.resolve({}) });
    try {
      return { html: await render(jsx(RootLayout as never, { children: inApp ? jsx(AppLayout as never, { children: tree }) : tree })) };
    } catch (e) {
      if (e instanceof NavigationSignal) return { nav: e.kind === "redirect" ? `→ ${e.to}` : "404" };
      return { error: e instanceof Error ? `${e.message}\n${e.stack?.split("\n").slice(1, 4).join("\n")}` : String(e) };
    }
  };

  for (const [route, comp, params] of routes) {
    matrix[route] = {};
    for (const role of roles) {
      g.__token = users[role]!.token;
      g.__path = route;
      const r = await renderOne(comp, params);
      matrix[route]![role] = r.html ? "ok" : r.nav ?? "ERROR";
      if (r.error) failures.push(`${role} ${route}: ${r.error}`);
      if (r.html) writeFileSync(path.join(OUT, `${role}${route.replace(/[/[\]]+/g, "_")}.html`), page(r.html));
    }
  }
  // Pages outside the app shell
  g.__token = undefined;
  for (const [name, comp] of [["login", Login], ["home-signed-out", Home], ["forbidden", Forbidden]] as const) {
    const r = await renderOne(comp as unknown as Page, {}, false);
    if (r.html) writeFileSync(path.join(OUT, `public_${name}.html`), page(r.html));
    matrix[`/${name}`] = { signedOut: r.html ? "ok" : r.nav ?? "ERROR" };
    if (r.error) failures.push(`${name}: ${r.error}`);
  }
  g.__token = users.RECIPIENT!.token;
  matrix["/ (recipient)"] = { RECIPIENT: (await renderOne(Home as unknown as Page, {}, false)).nav ?? "?" };
  g.__token = users.FR_SPORTS!.token;
  matrix["/ (FR Sports)"] = { FR_SPORTS: (await renderOne(Home as unknown as Page, {}, false)).nav ?? "?" };
  const pr2 = await renderOne(Profile as unknown as Page, {}, false);
  if (pr2.html) writeFileSync(path.join(OUT, "FR_SPORTS_profile.html"), page(pr2.html));

  writeFileSync(path.join(OUT, "access-matrix.json"), JSON.stringify(matrix, null, 1));
  writeFileSync(path.join(OUT, "failures.txt"), failures.join("\n\n"));
  console.log(`rendered; failures: ${failures.length}`);
  for (const f of failures) console.log("FAIL", f.split("\n")[0]);
  await env.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
