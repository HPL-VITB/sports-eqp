/**
 * Excel / CSV stock import: template → upload → preview (nothing changes) → confirm (all rows or none).
 * The preview is stored; on confirm every row is re-checked under a lock and the import is refused if
 * anything changed since the preview.
 */
import { createHash } from "node:crypto";
import { writeAudit } from "../audit";
import { can, requirePermission } from "../auth/permissions";
import type { User } from "../auth/users";
import type { AppContext } from "../context";
import type { Queryable } from "../db/types";
import { AppError, notFound } from "../errors";
import { applyMovement, lockStock } from "./ledger";
import { insertItem, MAX_QTY, UNITS, type Unit } from "./items";
import { insertCategory } from "./masterdata";
import { MAX_ROWS, readSpreadsheet, writeXlsx } from "./spreadsheet";

export const PREVIEW_TTL_MS = 30 * 60_000;

export const COLUMNS = [
  { key: "code", header: "Item code", hint: "Leave blank for new equipment. Fill in to add stock to an existing item." },
  { key: "sport", header: "Sport", hint: "Must match a sport in the portal (see Lists sheet)." },
  { key: "category", header: "Category", hint: "e.g. Bats, Balls, Rackets. FR Sports imports may create new categories." },
  { key: "name", header: "Equipment name", hint: "e.g. Leather cricket ball" },
  { key: "brand", header: "Brand", hint: "Optional" },
  { key: "model", header: "Model", hint: "Optional" },
  { key: "size", header: "Size", hint: "Optional, e.g. 5, SH, Full" },
  { key: "spec", header: "Specification", hint: "Optional" },
  { key: "unit", header: "Unit", hint: `One of: ${UNITS.join(", ")}. Blank = piece.` },
  { key: "location", header: "Location", hint: "Blank = Central Sports Store" },
  { key: "qty", header: "Quantity", hint: "Whole number received / counted now" },
  { key: "minStock", header: "Minimum stock", hint: "Optional: warn when available falls below this" },
  { key: "consumable", header: "Consumable (Y/N)", hint: "Y for shuttlecocks, grip tape, etc." },
  { key: "remarks", header: "Remarks", hint: "Optional, e.g. invoice or delivery note number" },
] as const;
type ColKey = (typeof COLUMNS)[number]["key"];
type RawRow = Partial<Record<ColKey, string>> & { _row: number };

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
const HEADER_ALIASES: Record<string, ColKey> = {
  itemcode: "code", code: "code", equipmentcode: "code",
  sport: "sport", game: "sport",
  category: "category",
  equipmentname: "name", equipment: "name", name: "name", item: "name", itemname: "name",
  brand: "brand", make: "brand",
  model: "model",
  size: "size",
  specification: "spec", spec: "spec", specifications: "spec", description: "spec",
  unit: "unit", units: "unit", uom: "unit",
  location: "location", store: "location", room: "location",
  quantity: "qty", qty: "qty", quantityreceived: "qty", count: "qty", openingstock: "qty",
  minimumstock: "minStock", minstock: "minStock", reorderlevel: "minStock",
  consumableyn: "consumable", consumable: "consumable",
  remarks: "remarks", remark: "remarks", notes: "remarks",
};

const UNIT_ALIASES: Record<string, Unit> = {
  piece: "piece", pieces: "piece", pc: "piece", pcs: "piece", no: "piece", nos: "piece", number: "piece", each: "piece", ea: "piece",
  pair: "pair", pairs: "pair", pr: "pair",
  set: "set", sets: "set",
  box: "box", boxes: "box",
  dozen: "dozen", dozens: "dozen", doz: "dozen",
  tube: "tube", tubes: "tube",
  roll: "roll", rolls: "roll",
  metre: "metre", metres: "metre", meter: "metre", meters: "metre", m: "metre",
  pack: "pack", packs: "pack", packet: "pack", packets: "pack",
};

/** Maps header cells to columns and returns the data rows. Header = first non-empty row. */
export function mapRows(table: string[][]): { rows: RawRow[]; unknownHeaders: string[] } {
  const headerIdx = table.findIndex((r) => r.some((c) => c.trim() !== ""));
  if (headerIdx < 0) throw new AppError(400, "EMPTY_FILE", "The file has no rows.");
  const header = table[headerIdx]!;
  const map = new Map<number, ColKey>();
  const unknownHeaders: string[] = [];
  header.forEach((h, i) => {
    if (!h.trim()) return;
    const key = HEADER_ALIASES[norm(h)];
    if (key && ![...map.values()].includes(key)) map.set(i, key);
    else unknownHeaders.push(h);
  });
  const present = new Set(map.values());
  const missing = (["sport", "category", "name", "qty"] as ColKey[]).filter((k) => !present.has(k));
  if (missing.length && !(present.has("code") && present.has("qty"))) {
    const names = missing.map((k) => COLUMNS.find((c) => c.key === k)!.header);
    throw new AppError(400, "MISSING_COLUMNS", `Missing column(s): ${names.join(", ")}. Download the template to see the expected columns.`);
  }
  const rows: RawRow[] = [];
  for (let r = headerIdx + 1; r < table.length; r++) {
    const cells = table[r] ?? [];
    if (!cells.some((c) => c && c.trim() !== "")) continue;
    const row: RawRow = { _row: r + 1 };
    for (const [i, key] of map) {
      const v = (cells[i] ?? "").trim();
      if (v) row[key] = v;
    }
    rows.push(row);
  }
  if (rows.length === 0) throw new AppError(400, "EMPTY_FILE", "The file has a header row but no data rows.");
  if (rows.length > MAX_ROWS) throw new AppError(400, "TOO_MANY_ROWS", `Import at most ${MAX_ROWS} rows at a time.`);
  return { rows, unknownHeaders };
}

export type PlanAction = "NEW_ITEM" | "ADD_STOCK" | "MERGED" | "ERROR";

export interface PlanRow {
  row: number;
  action: PlanAction;
  errors: string[];
  notes: string[];
  sport?: string;
  category?: string;
  name?: string;
  brand?: string | null;
  model?: string | null;
  size?: string | null;
  spec?: string | null;
  unit?: Unit;
  location?: string;
  qty: number;
  minStock?: number | null;
  consumable?: boolean;
  remarks?: string | null;
  itemId?: string;
  itemCode?: string;
  sportId?: string;
  categoryId?: string | null; // null = category will be created
  locationId?: string;
  mergedInto?: number;
}

export interface PlanSummary {
  rows: number;
  newItems: number;
  stockAdditions: number;
  merged: number;
  newCategories: string[];
  errors: number;
  totalQty: number;
}

interface Lookups {
  sports: Map<string, { id: string; name: string; active: boolean }>;
  categories: Map<string, { id: string; name: string; active: boolean }>; // key: sportId|lower(name) and sportId|code
  locations: Map<string, { id: string; name: string; active: boolean }>;
  defaultLocation?: { id: string; name: string };
  itemsByCode: Map<string, { id: string; code: string; active: boolean; name: string }>;
  itemsByKey: Map<string, { id: string; code: string; active: boolean }>;
}

const lc = (s: string | null | undefined) => (s ?? "").trim().toLowerCase();

async function loadLookups(q: Queryable): Promise<Lookups> {
  const sports = new Map<string, { id: string; name: string; active: boolean }>();
  for (const s of (await q.query<{ id: string; name: string; code: string; is_active: boolean }>("SELECT id, name, code, is_active FROM sports")).rows) {
    const v = { id: s.id, name: s.name, active: s.is_active };
    sports.set(lc(s.name), v);
    sports.set(lc(s.code), v);
  }
  const categories = new Map<string, { id: string; name: string; active: boolean }>();
  for (const c of (await q.query<{ id: string; sport_id: string; name: string; code: string; is_active: boolean }>("SELECT id, sport_id, name, code, is_active FROM categories")).rows) {
    const v = { id: c.id, name: c.name, active: c.is_active };
    categories.set(`${c.sport_id}|${lc(c.name)}`, v);
    categories.set(`${c.sport_id}|${lc(c.code)}`, v);
  }
  const locations = new Map<string, { id: string; name: string; active: boolean }>();
  let defaultLocation: { id: string; name: string } | undefined;
  for (const l of (await q.query<{ id: string; name: string; path: string; is_active: boolean; parent_id: string | null }>(
    `SELECT l.id, l.name, l.is_active, l.parent_id, CASE WHEN p.id IS NULL THEN l.name ELSE p.name || ' › ' || l.name END AS path
       FROM locations l LEFT JOIN locations p ON p.id = l.parent_id ORDER BY l.id`,
  )).rows) {
    const v = { id: l.id, name: l.path, active: l.is_active };
    if (!locations.has(lc(l.name))) locations.set(lc(l.name), v);
    locations.set(lc(l.path), v);
    locations.set(lc(l.path.replace(" › ", " > ")), v);
    if (!defaultLocation && l.is_active && l.parent_id === null) defaultLocation = { id: l.id, name: l.path };
  }
  const itemsByCode = new Map<string, { id: string; code: string; active: boolean; name: string }>();
  const itemsByKey = new Map<string, { id: string; code: string; active: boolean }>();
  for (const i of (await q.query<{ id: string; code: string; is_active: boolean; name: string; category_id: string; brand: string | null; model: string | null; size: string | null }>(
    "SELECT id, code, is_active, name, category_id, brand, model, size FROM items",
  )).rows) {
    itemsByCode.set(lc(i.code), { id: i.id, code: i.code, active: i.is_active, name: i.name });
    itemsByKey.set(defKey(i.category_id, i.name, i.brand, i.model, i.size), { id: i.id, code: i.code, active: i.is_active });
  }
  return { sports, categories, locations, defaultLocation, itemsByCode, itemsByKey };
}

function defKey(categoryRef: string, name: string, brand?: string | null, model?: string | null, size?: string | null) {
  return [categoryRef, lc(name), lc(brand), lc(model), lc(size)].join("|");
}

function parseQty(v: string | undefined, label: string, errors: string[], min: number): number {
  if (v === undefined || v === "") {
    errors.push(`${label} is empty.`);
    return 0;
  }
  const n = Number(v.replace(/,/g, ""));
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    errors.push(`${label} "${v}" is not a whole number.`);
    return 0;
  }
  if (n < min || n > MAX_QTY) {
    errors.push(`${label} must be between ${min} and ${MAX_QTY}.`);
    return 0;
  }
  return n;
}

/** Decides what each row will do. Pure function of the rows, the database contents and the importer's role. */
export async function planImport(q: Queryable, actor: User, raw: RawRow[]): Promise<{ plan: PlanRow[]; summary: PlanSummary }> {
  const L = await loadLookups(q);
  const canCreateItems = can(actor.role, "item.manage");
  const canCreateCategories = can(actor.role, "masterdata.manage");
  const plan: PlanRow[] = [];
  const firstByKey = new Map<string, PlanRow>();
  const newCategories = new Set<string>();

  for (const r of raw) {
    const errors: string[] = [];
    const notes: string[] = [];
    const remarks = r.remarks ?? null;
    if (r.code) {
      const qty = parseQty(r.qty, "Quantity", errors, 1);
      const item = L.itemsByCode.get(lc(r.code));
      if (!item) errors.push(`Item code "${r.code}" not found.`);
      else if (!item.active) errors.push(`Item ${item.code} is deactivated.`);
      const row: PlanRow = { row: r._row, action: errors.length ? "ERROR" : "ADD_STOCK", errors, notes, qty, remarks, itemId: item?.id, itemCode: item?.code, name: item?.name };
      if (!errors.length) {
        const key = `id:${item!.id}`;
        const first = firstByKey.get(key);
        if (first) {
          first.qty += qty;
          row.action = "MERGED";
          row.mergedInto = first.row;
          notes.push(`Same item as row ${first.row}; quantities added together.`);
        } else firstByKey.set(key, row);
      }
      plan.push(row);
      continue;
    }

    const sport = r.sport ? L.sports.get(lc(r.sport)) : undefined;
    if (!r.sport) errors.push("Sport is empty.");
    else if (!sport) errors.push(`Sport "${r.sport}" not found. Ask FR Sports to add it, or check the spelling.`);
    else if (!sport.active) errors.push(`Sport "${sport.name}" is deactivated.`);

    let categoryId: string | null | undefined;
    let categoryName = r.category;
    if (!r.category) errors.push("Category is empty.");
    else if (sport) {
      const cat = L.categories.get(`${sport.id}|${lc(r.category)}`);
      if (cat) {
        if (!cat.active) errors.push(`Category "${cat.name}" is deactivated.`);
        categoryId = cat.id;
        categoryName = cat.name;
      } else if (canCreateCategories) {
        if (r.category.trim().length < 2) errors.push("Category name is too short.");
        categoryId = null;
        newCategories.add(`${sport.name} › ${r.category.trim()}`);
        notes.push(`New category "${r.category.trim()}" will be created under ${sport.name}.`);
      } else {
        errors.push(`Category "${r.category}" does not exist under ${sport.name}. Ask FR Sports to add it.`);
      }
    }

    const name = (r.name ?? "").trim();
    if (name.length < 2) errors.push("Equipment name is empty or too short.");
    const unitRaw = lc(r.unit ?? "piece");
    const unit = UNIT_ALIASES[unitRaw];
    if (!unit) errors.push(`Unit "${r.unit}" is not recognised. Use one of: ${UNITS.join(", ")}.`);

    let location = r.location ? L.locations.get(lc(r.location)) : L.defaultLocation && { ...L.defaultLocation, active: true };
    if (r.location && !location) errors.push(`Location "${r.location}" not found.`);
    else if (location && !location.active) errors.push(`Location "${location.name}" is deactivated.`);
    if (!location && !r.location) errors.push("No storage location set up. Ask FR Sports to add one.");

    const minStock = r.minStock ? parseQty(r.minStock, "Minimum stock", errors, 0) : null;
    const consumable = r.consumable ? /^(y|yes|true|1)$/i.test(r.consumable) : false;
    if (r.consumable && !/^(y|yes|n|no|true|false|1|0)$/i.test(r.consumable)) errors.push(`Consumable must be Y or N, not "${r.consumable}".`);

    const brand = r.brand?.trim() || null;
    const model = r.model?.trim() || null;
    const size = r.size?.trim() || null;
    const categoryRef = categoryId ?? (sport ? `new:${sport.id}|${lc(r.category)}` : "?");
    const key = defKey(categoryRef, name, brand, model, size);
    const existing = categoryId ? L.itemsByKey.get(key) : undefined;

    let action: PlanAction;
    let qty: number;
    if (existing) {
      qty = parseQty(r.qty, "Quantity", errors, 1);
      if (!existing.active) errors.push(`This matches ${existing.code}, which is deactivated.`);
      else notes.push(`Matches existing item ${existing.code}; stock will be added.`);
      action = "ADD_STOCK";
    } else {
      qty = parseQty(r.qty, "Quantity", errors, 0);
      if (!canCreateItems) errors.push("New equipment can only be created by FR Sports or the Assistant Sports Officer. Ask them to add it, then import stock using its item code.");
      action = "NEW_ITEM";
    }

    const row: PlanRow = {
      row: r._row,
      action: errors.length ? "ERROR" : action,
      errors,
      notes,
      sport: sport?.name ?? r.sport,
      category: categoryName,
      name,
      brand,
      model,
      size,
      spec: r.spec?.trim() || null,
      unit,
      location: location?.name,
      qty,
      minStock,
      consumable,
      remarks,
      itemId: existing?.id,
      itemCode: existing?.code,
      sportId: sport?.id,
      categoryId,
      locationId: location?.id,
    };
    if (!errors.length) {
      const dupKey = existing ? `id:${existing.id}` : key;
      const first = firstByKey.get(dupKey);
      if (first) {
        first.qty += qty;
        row.action = "MERGED";
        row.mergedInto = first.row;
        notes.push(`Same equipment as row ${first.row}; quantities added together.`);
      } else firstByKey.set(dupKey, row);
    }
    plan.push(row);
  }

  const summary: PlanSummary = {
    rows: plan.length,
    newItems: plan.filter((p) => p.action === "NEW_ITEM").length,
    stockAdditions: plan.filter((p) => p.action === "ADD_STOCK").length,
    merged: plan.filter((p) => p.action === "MERGED").length,
    newCategories: [...newCategories],
    errors: plan.filter((p) => p.action === "ERROR").length,
    totalQty: plan.filter((p) => p.action === "NEW_ITEM" || p.action === "ADD_STOCK").reduce((a, p) => a + p.qty, 0),
  };
  return { plan, summary };
}

function fingerprint(plan: PlanRow[]): string {
  const essential = plan.map((p) => [p.row, p.action, p.itemId ?? null, p.categoryId ?? null, p.sportId ?? null, p.locationId ?? null, p.qty, p.mergedInto ?? null]);
  return createHash("sha256").update(JSON.stringify(essential)).digest("hex");
}

export async function buildTemplate(ctx: AppContext, actor: User): Promise<Uint8Array> {
  requirePermission(actor, "stock.receive");
  const sports = (await ctx.db.query<{ sport: string; code: string; category: string | null }>(
    `SELECT s.name AS sport, s.code, c.name AS category FROM sports s LEFT JOIN categories c ON c.sport_id = s.id AND c.is_active
      WHERE s.is_active ORDER BY s.name, c.name`,
  )).rows;
  const locations = (await ctx.db.query<{ path: string }>(
    `SELECT CASE WHEN p.id IS NULL THEN l.name ELSE p.name || ' > ' || l.name END AS path
       FROM locations l LEFT JOIN locations p ON p.id = l.parent_id WHERE l.is_active ORDER BY 1`,
  )).rows;
  const lists: string[][] = [["Sport", "Sport code", "Existing categories", "", "Units", "", "Locations"]];
  const n = Math.max(sports.length, UNITS.length, locations.length);
  for (let i = 0; i < n; i++) {
    const s = sports[i];
    lists.push([s?.sport ?? "", s?.code ?? "", s?.category ?? "", "", UNITS[i] ?? "", "", locations[i]?.path ?? ""]);
  }
  return writeXlsx([
    { name: "Stock", rows: [COLUMNS.map((c) => c.header)], widths: [14, 16, 18, 30, 14, 14, 10, 24, 10, 22, 11, 14, 16, 26], boldFirstRow: true },
    {
      name: "Instructions",
      rows: [
        ["Column", "What to enter"],
        ...COLUMNS.map((c) => [c.header, c.hint]),
        ["", ""],
        ["Example (new item)", "Cricket | Balls | Leather cricket ball | SG | Test | | 156 g | piece | | 40 | 10 | N |"],
        ["Example (add stock)", "CRI-BAL-0001 | | | | | | | | | | 20 | | | Invoice 1123"],
        ["", ""],
        ["After upload", "You will see a preview of every row. Nothing changes until you confirm. If any row has an error, nothing is imported."],
      ],
      widths: [22, 110],
      boldFirstRow: true,
    },
    { name: "Lists", rows: lists, widths: [18, 11, 26, 3, 10, 3, 34], boldFirstRow: true },
  ]);
}

export async function previewImport(ctx: AppContext, actor: User, file: { name: string; bytes: Uint8Array }) {
  requirePermission(actor, "stock.receive");
  const table = await readSpreadsheet(file.name, file.bytes);
  const { rows, unknownHeaders } = mapRows(table);
  const { plan, summary } = await planImport(ctx.db, actor, rows);
  const res = await ctx.db.query<{ id: string }>(
    `INSERT INTO import_batches (filename, uploaded_by, raw_rows, plan, fingerprint, created_at)
     VALUES ($1, $2, $3::jsonb, $4::jsonb, $5, $6) RETURNING id`,
    [file.name.slice(0, 200), actor.id, JSON.stringify(rows), JSON.stringify(plan), fingerprint(plan), ctx.now()],
  );
  return { batchId: res.rows[0]!.id, filename: file.name, plan, summary, unknownHeaders, canCommit: summary.errors === 0 };
}

export interface CommitResult {
  batchId: string;
  createdItems: { row: number; code: string; name: string; qty: number }[];
  stockAdded: { row: number; code: string; qty: number; availableAfter: number }[];
  createdCategories: string[];
  totalQty: number;
}

export async function commitImport(ctx: AppContext, actor: User, batchId: string, ip: string | null): Promise<CommitResult> {
  requirePermission(actor, "stock.receive");
  if (!/^\d+$/.test(batchId)) throw notFound("Import");
  const now = ctx.now();
  return ctx.db.tx(async (q) => {
    // One import at a time, so two imports cannot both create the same new item.
    await q.query("SELECT pg_advisory_xact_lock(hashtext('stock-import'))");
    const batch = (await q.query<{ uploaded_by: string; status: string; raw_rows: RawRow[]; fingerprint: string; created_at: Date }>(
      "SELECT uploaded_by, status, raw_rows, fingerprint, created_at FROM import_batches WHERE id = $1 FOR UPDATE",
      [batchId],
    )).rows[0];
    if (!batch || String(batch.uploaded_by) !== String(actor.id)) throw notFound("Import");
    if (batch.status === "COMMITTED") throw new AppError(409, "ALREADY_IMPORTED", "This file has already been imported.");
    if (batch.status !== "PREVIEW") throw new AppError(409, "IMPORT_CLOSED", "This preview is no longer valid. Upload the file again.");
    if (now.getTime() - batch.created_at.getTime() > PREVIEW_TTL_MS) {
      throw new AppError(409, "PREVIEW_EXPIRED", "This preview is more than 30 minutes old. Upload the file again.");
    }
    const { plan, summary } = await planImport(q, actor, batch.raw_rows);
    if (summary.errors > 0) throw new AppError(409, "IMPORT_HAS_ERRORS", "Fix the rows with errors and upload the file again. Nothing was imported.");
    if (fingerprint(plan) !== batch.fingerprint) {
      throw new AppError(409, "PREVIEW_OUTDATED", "Stock records changed since this preview. Upload the file again to see an up-to-date preview. Nothing was imported.");
    }

    const source = { table: "import_batches", id: batchId };
    const result: CommitResult = { batchId, createdItems: [], stockAdded: [], createdCategories: [], totalQty: summary.totalQty };
    const createdCategoryIds = new Map<string, string>();

    for (const p of plan.filter((x) => x.action === "NEW_ITEM")) {
      let categoryId = p.categoryId ?? null;
      if (categoryId === null) {
        const ck = `${p.sportId}|${lc(p.category)}`;
        categoryId = createdCategoryIds.get(ck) ?? null;
        if (!categoryId) {
          const c = await insertCategory(q, p.sportId!, p.category!.trim());
          categoryId = c.id;
          createdCategoryIds.set(ck, c.id);
          result.createdCategories.push(`${p.sport} › ${c.name} (${c.code})`);
          await writeAudit(q, { actorId: actor.id, action: "category.create", entity: "category", entityId: c.id, after: { ...c, viaImport: batchId }, ip });
        }
      }
      const created = await insertItem(
        q,
        {
          sportId: p.sportId!,
          categoryId,
          name: p.name!,
          brand: p.brand ?? null,
          model: p.model ?? null,
          size: p.size ?? null,
          spec: p.spec ?? null,
          unit: p.unit!,
          locationId: p.locationId!,
          minStock: p.minStock ?? null,
          isConsumable: p.consumable ?? false,
        },
        { qty: p.qty, actorId: actor.id, now, remarks: p.remarks, source },
      );
      result.createdItems.push({ row: p.row, code: created.code, name: p.name!, qty: p.qty });
    }

    const additions = plan.filter((x) => x.action === "ADD_STOCK");
    const locked = await lockStock(q, additions.map((a) => a.itemId!));
    for (const p of additions) {
      const m = await applyMovement(q, locked, {
        itemId: p.itemId!,
        type: "RECEIPT",
        qty: p.qty,
        from: null,
        to: "AVAILABLE",
        actorId: actor.id,
        remarks: p.remarks ?? null,
        source,
        now,
      });
      result.stockAdded.push({ row: p.row, code: p.itemCode!, qty: p.qty, availableAfter: m.after.available });
    }

    await q.query("UPDATE import_batches SET status = 'COMMITTED', committed_at = $2 WHERE id = $1", [batchId, now]);
    await writeAudit(q, {
      actorId: actor.id,
      action: "import.commit",
      entity: "import_batch",
      entityId: batchId,
      after: { newItems: result.createdItems.length, stockAdditions: result.stockAdded.length, newCategories: result.createdCategories, totalQty: result.totalQty },
      ip,
    });
    return result;
  });
}
