import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, test } from "node:test";
import { findUserById, type User } from "../src/server/auth/users";
import { AppError } from "../src/server/errors";
import { createItem, getItem, listItems, receiveStock, updateItem } from "../src/server/inventory/items";
import { ledgerMismatches } from "../src/server/inventory/ledger";
import { createCategory, createLocation, createSport, deriveCode, listSports, updateLocation } from "../src/server/inventory/masterdata";
import { createItemHandler, receiveStockHandler } from "../src/server/http/inventory-handlers";
import { makeUser, req, setupTestEnv, type TestEnv } from "./support/harness";

let env: TestEnv;
let fr: User, aso: User, sk: User, pr: User, mg: User, rc: User;
let asoToken: string, rcToken: string;
let cricketId: string, footballId: string, ballsCatId: string, batsCatId: string, storeId: string;

const u = async (id: string) => (await findUserById(env.ctx.db, id))!;
const key = () => randomBytes(12).toString("hex");
async function rejectsWith(p: Promise<unknown>, code: string) {
  await assert.rejects(p, (e: unknown) => {
    if (!(e instanceof AppError)) throw e;
    assert.equal(e.code, code, e.message);
    return true;
  });
}
const def = (over: Record<string, unknown> = {}) => ({
  sportId: cricketId,
  categoryId: ballsCatId,
  name: "Leather cricket ball",
  brand: "SG",
  model: "Test",
  size: null,
  spec: "156 g",
  unit: "piece",
  locationId: storeId,
  minStock: 10,
  isConsumable: false,
  openingQty: 40,
  ...over,
});
async function stockOf(itemId: string) {
  return (await env.ctx.db.query<{ available: number; issued: number }>("SELECT * FROM item_stock WHERE item_id = $1", [itemId])).rows[0]!;
}

before(async () => {
  env = await setupTestEnv();
  const mk = async (role: Parameters<typeof makeUser>[1]) => makeUser(env, role);
  const [a, b, c, d, e, f] = await Promise.all([mk("FR_SPORTS"), mk("ASO"), mk("STOREKEEPER"), mk("PROCUREMENT"), mk("MANAGEMENT"), mk("RECIPIENT")]);
  [fr, aso, sk, pr, mg, rc] = (await Promise.all([a, b, c, d, e, f].map((x) => u(x.id)))) as [User, User, User, User, User, User];
  asoToken = b.token;
  rcToken = f.token;
  const sports = await listSports(env.ctx, fr);
  cricketId = sports.find((s) => s.code === "CRI")!.id;
  footballId = sports.find((s) => s.code === "FTB")!.id;
  ballsCatId = (await createCategory(env.ctx, fr, { sportId: cricketId, name: "Balls" }, null)).id;
  batsCatId = (await createCategory(env.ctx, fr, { sportId: cricketId, name: "Bats" }, null)).id;
  storeId = (await env.ctx.db.query<{ id: string }>("SELECT id FROM locations WHERE name = 'Central Sports Store'")).rows[0]!.id;
});
after(async () => env.close());

test("seed data: one store location and 11 sports", async () => {
  assert.equal((await listSports(env.ctx, fr)).length, 11);
});

test("only FR Sports manages sports, categories and locations; codes are derived and unique", async () => {
  await rejectsWith(createSport(env.ctx, aso, { name: "Kabaddi" }, null), "FORBIDDEN");
  await rejectsWith(createCategory(env.ctx, aso, { sportId: cricketId, name: "Pads" }, null), "FORBIDDEN");
  const kab = await createSport(env.ctx, fr, { name: "Kabaddi" }, null);
  assert.equal(kab.code, "KAB");
  await rejectsWith(createSport(env.ctx, fr, { name: "kabaddi" }, null), "DUPLICATE");
  await rejectsWith(createCategory(env.ctx, fr, { sportId: cricketId, name: "BALLS" }, null), "DUPLICATE");
  assert.equal(deriveCode("Balls", new Set()), "BAL");
  const alt = deriveCode("Balls", new Set(["BAL"]));
  assert.notEqual(alt, "BAL");
  assert.match(alt, /^[A-Z0-9]{2,4}$/);
  const room = await createLocation(env.ctx, fr, { name: "Rack room", parentId: storeId }, null);
  await rejectsWith(createLocation(env.ctx, fr, { name: "Shelf", parentId: room.id }, null), "VALIDATION");
});

test("new equipment gets SPORT-CATEGORY-NNNN codes and an OPENING movement (40 in stock)", async () => {
  const item = await createItem(env.ctx, aso, def(), null);
  assert.match(item.code, /^CRI-BAL-0001$/);
  assert.equal(item.stock.available, 40);
  assert.equal(item.stock.accountable, 40);
  const { movements } = await getItem(env.ctx, mg, item.id);
  assert.equal(movements.length, 1);
  assert.equal(movements[0]!.type, "OPENING");
  assert.deepEqual([movements[0]!.before.available, movements[0]!.qty, movements[0]!.after.available], [0, 40, 40]);
  const second = await createItem(env.ctx, fr, def({ name: "Tennis ball (taped)", brand: null, model: null, openingQty: 0 }), null);
  assert.equal(second.code, "CRI-BAL-0002");
  assert.equal(second.stock.available, 0);
  assert.equal((await getItem(env.ctx, fr, second.id)).movements.length, 0, "zero opening stock -> no movement");
});

test("blueprint receipt example: 40 + 20 = 60, with before/after, actor and remarks recorded", async () => {
  const item = await createItem(env.ctx, fr, def({ name: "Practice ball", openingQty: 40 }), null);
  const r = await receiveStock(env.ctx, pr, item.id, { qty: 20, remarks: "Invoice 1123" });
  assert.deepEqual([r.availableBefore, r.qty, r.availableAfter], [40, 20, 60]);
  const { movements, item: after } = await getItem(env.ctx, fr, item.id);
  assert.equal(after.stock.available, 60);
  const m = movements[0]!;
  assert.equal(m.type, "RECEIPT");
  assert.equal(m.remarks, "Invoice 1123");
  assert.equal(m.actor, pr.name);
  assert.deepEqual(await ledgerMismatches(env.ctx.db), []);
});

test("receipt validation and permissions", async () => {
  const item = await createItem(env.ctx, fr, def({ name: "Validation ball" }), null);
  for (const qty of [0, -5, 2.5, 100_001, "10"]) await rejectsWith(receiveStock(env.ctx, fr, item.id, { qty }), "VALIDATION");
  for (const who of [sk, mg, rc]) await rejectsWith(receiveStock(env.ctx, who, item.id, { qty: 1 }), "FORBIDDEN");
  await rejectsWith(receiveStock(env.ctx, fr, "999999", { qty: 1 }), "NOT_FOUND");
  await env.ctx.db.query("UPDATE items SET is_active = false WHERE id = $1", [item.id]);
  await rejectsWith(receiveStock(env.ctx, fr, item.id, { qty: 1 }), "ITEM_INACTIVE");
});

test("creation rules: permissions, duplicates (any letter case), category must belong to sport", async () => {
  for (const who of [sk, pr, mg, rc]) await rejectsWith(createItem(env.ctx, who, def({ name: "Perm ball" }), null), "FORBIDDEN");
  await createItem(env.ctx, fr, def({ name: "Dup ball", brand: "Kookaburra" }), null);
  await assert.rejects(createItem(env.ctx, aso, def({ name: "  DUP BALL ", brand: "kookaburra" }), null), (e: unknown) => {
    return e instanceof AppError && e.code === "DUPLICATE_ITEM" && /CRI-BAL-\d{4}/.test(e.message);
  });
  await rejectsWith(createItem(env.ctx, fr, def({ name: "Wrong sport ball", sportId: footballId }), null), "VALIDATION");
  await rejectsWith(createItem(env.ctx, fr, def({ name: "Bad unit", unit: "kg" }), null), "VALIDATION");
  await rejectsWith(createItem(env.ctx, fr, def({ name: "Neg", openingQty: -1 }), null), "VALIDATION");
});

test("double-submitting a receipt with the same request key adds stock once (sequential and simultaneous)", async () => {
  const item = await createItem(env.ctx, fr, def({ name: "Idem ball", openingQty: 10 }), null);
  const k = key();
  const first = await receiveStock(env.ctx, fr, item.id, { qty: 5, idempotencyKey: k });
  const again = await receiveStock(env.ctx, fr, item.id, { qty: 5, idempotencyKey: k });
  assert.equal(first.replayed, false);
  assert.equal(again.replayed, true);
  assert.equal(again.movementId, first.movementId);
  const k2 = key();
  const results = await Promise.all(Array.from({ length: 6 }, () => receiveStock(env.ctx, fr, item.id, { qty: 7, idempotencyKey: k2 })));
  assert.equal(new Set(results.map((r) => r.movementId)).size, 1);
  assert.equal((await stockOf(item.id)).available, 10 + 5 + 7);
  await rejectsWith(receiveStock(env.ctx, pr, item.id, { qty: 7, idempotencyKey: k2 }), "IDEMPOTENCY_CONFLICT");
});

test("25 simultaneous receipts: every unit counted, ledger chain unbroken (opening + delta = closing)", async () => {
  const item = await createItem(env.ctx, fr, def({ name: "Concurrent ball", openingQty: 100 }), null);
  const qtys = Array.from({ length: 25 }, (_, i) => i + 1);
  await Promise.all(qtys.map((qty) => receiveStock(env.ctx, qty % 2 ? fr : pr, item.id, { qty })));
  const expected = 100 + qtys.reduce((a, b) => a + b, 0);
  assert.equal((await stockOf(item.id)).available, expected);
  const mv = (await env.ctx.db.query<{ qty: number; before: { available: number }; after: { available: number } }>(
    "SELECT qty, before, after FROM stock_movements WHERE item_id = $1 ORDER BY id",
    [item.id],
  )).rows;
  assert.equal(mv.length, 26);
  let running = 0;
  for (const m of mv) {
    assert.equal(m.before.available, running, "each movement starts where the previous ended");
    assert.equal(m.after.available, m.before.available + m.qty, "opening + delta = closing");
    running = m.after.available;
  }
  assert.equal(running, expected);
  assert.deepEqual(await ledgerMismatches(env.ctx.db), []);
});

test("simultaneous creation: distinct items get consecutive unique codes; identical items are created once", async () => {
  const names = Array.from({ length: 10 }, (_, i) => `Bat model ${i}`);
  const made = await Promise.all(names.map((name) => createItem(env.ctx, fr, def({ categoryId: batsCatId, name, openingQty: 1 }), null)));
  const codes = made.map((m) => m.code).sort();
  assert.deepEqual(codes, Array.from({ length: 10 }, (_, i) => `CRI-BAT-${String(i + 1).padStart(4, "0")}`));
  const same = await Promise.allSettled(Array.from({ length: 5 }, () => createItem(env.ctx, fr, def({ categoryId: batsCatId, name: "Twin bat" }), null)));
  assert.equal(same.filter((r) => r.status === "fulfilled").length, 1);
  for (const r of same) if (r.status === "rejected") assert.equal((r.reason as AppError).code, "DUPLICATE_ITEM");
});

test("the database itself refuses negative stock and edits to history", async () => {
  const item = await createItem(env.ctx, fr, def({ name: "Guard ball" }), null);
  await assert.rejects(env.ctx.db.query("UPDATE item_stock SET available = -1 WHERE item_id = $1", [item.id]), /stock_available_nonneg/);
  await assert.rejects(env.ctx.db.query("UPDATE stock_movements SET qty = 999 WHERE item_id = $1", [item.id]), /append-only/);
  await assert.rejects(env.ctx.db.query("DELETE FROM stock_movements WHERE item_id = $1", [item.id]), /append-only/);
  await assert.rejects(
    env.ctx.db.query("INSERT INTO stock_movements (item_id, type, qty, from_state, to_state, before, after) VALUES ($1, 'RECEIPT', 0, NULL, 'AVAILABLE', '{}', '{}')", [item.id]),
    /movement_qty_positive/,
  );
});

test("editing: descriptive fields audited; code, sport, category fixed; cannot deactivate with stock", async () => {
  const item = await createItem(env.ctx, aso, def({ name: "Edit ball", openingQty: 3 }), null);
  const edited = await updateItem(env.ctx, aso, item.id, { name: "Edited ball", minStock: null, brand: "" }, "10.0.0.9");
  assert.equal(edited.name, "Edited ball");
  assert.equal(edited.brand, null);
  assert.equal(edited.minStock, null);
  assert.equal(edited.code, item.code);
  await rejectsWith(updateItem(env.ctx, aso, item.id, { categoryId: batsCatId }, null), "VALIDATION");
  await rejectsWith(updateItem(env.ctx, aso, item.id, { isActive: false }, null), "ITEM_HAS_STOCK");
  await rejectsWith(updateItem(env.ctx, pr, item.id, { name: "x y" }, null), "FORBIDDEN");
  const audit = await env.ctx.db.query<{ before: { name: string }; after: { name: string } }>(
    "SELECT before, after FROM audit_log WHERE action = 'item.update' AND entity_id = $1",
    [item.id],
  );
  assert.equal(audit.rows[0]!.before.name, "Edit ball");
  assert.equal(audit.rows[0]!.after.name, "Edited ball");
  const empty = await createItem(env.ctx, aso, def({ name: "Empty ball", openingQty: 0 }), null);
  assert.equal((await updateItem(env.ctx, aso, empty.id, { isActive: false }, null)).isActive, false);
});

test("location in use cannot be deactivated", async () => {
  await rejectsWith(updateLocation(env.ctx, fr, storeId, { isActive: false }, null), "LOCATION_IN_USE");
});

test("search and filters: text, sport, low stock, status; recipients cannot see the stock register", async () => {
  const low = await createItem(env.ctx, fr, def({ name: "Low ball", brand: "Zebra", openingQty: 2, minStock: 5 }), null);
  const byText = await listItems(env.ctx, mg, { q: "zebra" });
  assert.deepEqual(byText.items.map((i) => i.id), [low.id]);
  assert.equal((await listItems(env.ctx, sk, { q: low.code })).items[0]!.id, low.id);
  const lowOnly = await listItems(env.ctx, fr, { lowStock: "1" });
  assert.ok(lowOnly.items.length > 0 && lowOnly.items.every((i) => i.lowStock));
  assert.ok(lowOnly.items.some((i) => i.id === low.id));
  const football = await listItems(env.ctx, fr, { sportId: footballId });
  assert.equal(football.total, 0);
  const all = await listItems(env.ctx, fr, { status: "all", limit: 500 });
  const active = await listItems(env.ctx, fr, {});
  assert.ok(all.total > active.total, "inactive items only when asked");
  assert.equal(active.sums.available, active.items.reduce((a, i) => a + i.stock.available, 0));
  await rejectsWith(listItems(env.ctx, rc, {}), "FORBIDDEN");
  await rejectsWith(listItems(env.ctx, fr, { sort: "drop table" }), "VALIDATION");
});

test("HTTP: ASO creates an item (201); recipients get 403; repeated receipt returns 200 with the same result", async () => {
  const created = await createItemHandler(env.ctx, req("POST", "/api/items", { token: asoToken, body: def({ name: "HTTP ball", openingQty: 5 }) }));
  assert.equal(created.status, 201);
  const item = ((await created.json()) as { item: { id: string } }).item;
  const denied = await createItemHandler(env.ctx, req("POST", "/api/items", { token: rcToken, body: def({ name: "Sneaky ball" }) }));
  assert.equal(denied.status, 403);
  const k = key();
  const r1 = await receiveStockHandler(env.ctx, req("POST", `/api/items/${item.id}/receipts`, { token: asoToken, body: { qty: 4, idempotencyKey: k } }), item.id);
  const r2 = await receiveStockHandler(env.ctx, req("POST", `/api/items/${item.id}/receipts`, { token: asoToken, body: { qty: 4, idempotencyKey: k } }), item.id);
  assert.equal(r1.status, 201);
  assert.equal(r2.status, 200);
  assert.equal((await stockOf(item.id)).available, 9);
  const evil = await receiveStockHandler(env.ctx, req("POST", `/api/items/${item.id}/receipts`, { token: asoToken, origin: "https://evil.example", body: { qty: 4 } }), item.id);
  assert.equal(evil.status, 403);
});

test("final ledger check: every balance equals the sum of its movements", async () => {
  assert.deepEqual(await ledgerMismatches(env.ctx.db), []);
});
