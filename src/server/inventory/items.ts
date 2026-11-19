/** Equipment master records, stock receipts, search and item history. */
import { z } from "zod";
import { writeAudit } from "../audit";
import { requirePermission } from "../auth/permissions";
import type { User } from "../auth/users";
import type { AppContext } from "../context";
import { PG, pgCode, pgConstraint, type Queryable } from "../db/types";
import { AppError, notFound } from "../errors";
import { idempotent } from "../idempotency";
import { accountable, applyMovement, availableToIssue, lockStock } from "./ledger";

export const UNITS = ["piece", "pair", "set", "box", "dozen", "tube", "roll", "metre", "pack"] as const;
export type Unit = (typeof UNITS)[number];
export const MAX_QTY = 100_000;

const id = z.string().regex(/^\d+$/, "Invalid id.");
const optText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .nullable()
    .transform((v) => (v ? v : null));

export const itemDefinitionSchema = z.object({
  sportId: id,
  categoryId: id,
  name: z.string().trim().min(2, "Enter the equipment name.").max(120),
  brand: optText(60),
  model: optText(60),
  size: optText(30),
  spec: optText(300),
  unit: z.enum(UNITS),
  locationId: id,
  minStock: z.number().int().min(0).max(MAX_QTY).nullable().optional().transform((v) => v ?? null),
  isConsumable: z.boolean().default(false),
});
export type ItemDefinition = z.infer<typeof itemDefinitionSchema>;

const createSchema = itemDefinitionSchema.extend({
  openingQty: z.number().int().min(0, "Quantity cannot be negative.").max(MAX_QTY),
  remarks: optText(300),
  idempotencyKey: z.string().optional(),
});

function validation(err: z.ZodError) {
  return new AppError(400, "VALIDATION", err.issues[0]?.message ?? "Invalid input.", {
    fields: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
  });
}

export interface ItemRow {
  id: string;
  code: string;
  sport_id: string;
  sport_name: string;
  category_id: string;
  category_name: string;
  name: string;
  brand: string | null;
  model: string | null;
  size: string | null;
  spec: string | null;
  unit: Unit;
  location_id: string;
  location_name: string;
  min_stock: number | null;
  is_consumable: boolean;
  is_active: boolean;
  available: number;
  issued: number;
  damaged: number;
  missing: number;
  discarded: number;
  reserved: number;
}

const ITEM_SELECT = `
  SELECT i.id, i.code, i.sport_id, s.name AS sport_name, i.category_id, c.name AS category_name, i.name, i.brand, i.model,
         i.size, i.spec, i.unit, i.location_id,
         CASE WHEN lp.id IS NULL THEN l.name ELSE lp.name || ' › ' || l.name END AS location_name,
         i.min_stock, i.is_consumable, i.is_active,
         st.available, st.issued, st.damaged, st.missing, st.discarded, st.reserved
    FROM items i
    JOIN sports s ON s.id = i.sport_id
    JOIN categories c ON c.id = i.category_id
    JOIN locations l ON l.id = i.location_id
    LEFT JOIN locations lp ON lp.id = l.parent_id
    JOIN item_stock st ON st.item_id = i.id`;

export function itemView(r: ItemRow) {
  const toIssue = availableToIssue(r);
  return {
    id: r.id,
    code: r.code,
    sport: { id: r.sport_id, name: r.sport_name },
    category: { id: r.category_id, name: r.category_name },
    name: r.name,
    brand: r.brand,
    model: r.model,
    size: r.size,
    spec: r.spec,
    unit: r.unit,
    location: { id: r.location_id, name: r.location_name },
    minStock: r.min_stock,
    isConsumable: r.is_consumable,
    isActive: r.is_active,
    stock: {
      available: r.available,
      issued: r.issued,
      damaged: r.damaged,
      missing: r.missing,
      discarded: r.discarded,
      reserved: r.reserved,
      availableToIssue: toIssue,
      accountable: accountable(r),
    },
    lowStock: r.min_stock !== null && toIssue < r.min_stock,
  };
}
export type ItemView = ReturnType<typeof itemView>;

async function loadItem(q: Queryable, itemId: string): Promise<ItemRow | null> {
  return (await q.query<ItemRow>(`${ITEM_SELECT} WHERE i.id = $1`, [itemId])).rows[0] ?? null;
}

/** Finds an item with the same category / name / brand / model / size (case-insensitive). */
export async function findByDefinition(
  q: Queryable,
  d: { categoryId: string; name: string; brand: string | null; model: string | null; size: string | null },
): Promise<{ id: string; code: string; is_active: boolean } | null> {
  const res = await q.query<{ id: string; code: string; is_active: boolean }>(
    `SELECT id, code, is_active FROM items
      WHERE category_id = $1 AND lower(name) = lower($2) AND lower(coalesce(brand,'')) = lower(coalesce($3,''))
        AND lower(coalesce(model,'')) = lower(coalesce($4,'')) AND lower(coalesce(size,'')) = lower(coalesce($5,''))`,
    [d.categoryId, d.name, d.brand, d.model, d.size],
  );
  return res.rows[0] ?? null;
}

/**
 * Internal: inserts the item, its zero balance row and (if qty > 0) an OPENING movement.
 * Item code = SPORT-CATEGORY-NNNN, numbered per category under a row lock, so codes never repeat.
 */
export async function insertItem(
  q: Queryable,
  def: ItemDefinition,
  opening: { qty: number; actorId: string; now: Date; remarks?: string | null; source?: { table: string; id: string } },
): Promise<{ id: string; code: string }> {
  const loc = (await q.query<{ is_active: boolean }>("SELECT is_active FROM locations WHERE id = $1", [def.locationId])).rows[0];
  if (!loc || !loc.is_active) throw new AppError(400, "VALIDATION", "Choose an active storage location.");
  const seq = (
    await q.query<{ seq: number; cat_code: string; sport_code: string; cat_active: boolean; sport_active: boolean }>(
      `UPDATE categories c SET next_seq = c.next_seq + 1
         FROM sports s
        WHERE c.id = $1 AND c.sport_id = $2 AND s.id = c.sport_id
        RETURNING c.next_seq - 1 AS seq, c.code AS cat_code, s.code AS sport_code, c.is_active AS cat_active, s.is_active AS sport_active`,
      [def.categoryId, def.sportId],
    )
  ).rows[0];
  if (!seq) throw new AppError(400, "VALIDATION", "That category does not belong to the chosen sport.");
  if (!seq.cat_active || !seq.sport_active) throw new AppError(400, "VALIDATION", "That sport or category is deactivated.");

  const existing = await findByDefinition(q, def);
  if (existing) {
    throw new AppError(409, "DUPLICATE_ITEM", `This equipment already exists as ${existing.code}. Add stock to it instead.`, {
      itemId: existing.id,
      code: existing.code,
    });
  }
  const code = `${seq.sport_code}-${seq.cat_code}-${String(seq.seq).padStart(4, "0")}`;
  let itemId: string;
  try {
    itemId = (
      await q.query<{ id: string }>(
        `INSERT INTO items (code, sport_id, category_id, name, brand, model, size, spec, unit, location_id, min_stock, is_consumable, created_by, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$14) RETURNING id`,
        [code, def.sportId, def.categoryId, def.name, def.brand, def.model, def.size, def.spec, def.unit, def.locationId, def.minStock, def.isConsumable, opening.actorId, opening.now],
      )
    ).rows[0]!.id;
  } catch (err) {
    if (pgCode(err) === PG.UNIQUE_VIOLATION && pgConstraint(err) === "items_definition_key") {
      throw new AppError(409, "DUPLICATE_ITEM", "This equipment was just added by someone else. Search for it and add stock instead.");
    }
    throw err;
  }
  await q.query("INSERT INTO item_stock (item_id, updated_at) VALUES ($1, $2)", [itemId, opening.now]);
  if (opening.qty > 0) {
    const locked = await lockStock(q, [itemId]);
    await applyMovement(q, locked, {
      itemId,
      type: "OPENING",
      qty: opening.qty,
      from: null,
      to: "AVAILABLE",
      actorId: opening.actorId,
      remarks: opening.remarks ?? null,
      source: opening.source ?? { table: "items", id: itemId },
      now: opening.now,
    });
  }
  return { id: itemId, code };
}

export async function createItem(ctx: AppContext, actor: User, input: unknown, ip: string | null): Promise<ItemView> {
  requirePermission(actor, "item.manage");
  const p = createSchema.safeParse(input);
  if (!p.success) throw validation(p.error);
  const { openingQty, remarks, idempotencyKey, ...def } = p.data;
  const now = ctx.now();
  const { result } = await ctx.db.tx((q) =>
    idempotent(q, idempotencyKey, actor.id, "item.create", async () => {
      const created = await insertItem(q, def, { qty: openingQty, actorId: actor.id, now, remarks });
      await writeAudit(q, { actorId: actor.id, action: "item.create", entity: "item", entityId: created.id, after: { ...def, code: created.code, openingQty }, ip });
      return itemView((await loadItem(q, created.id))!);
    }),
  );
  return result;
}

const updateSchema = z
  .object({
    name: z.string().trim().min(2).max(120).optional(),
    brand: optText(60),
    model: optText(60),
    size: optText(30),
    spec: optText(300),
    unit: z.enum(UNITS).optional(),
    locationId: id.optional(),
    minStock: z.number().int().min(0).max(MAX_QTY).nullable().optional(),
    isConsumable: z.boolean().optional(),
    isActive: z.boolean().optional(),
  })
  .strict();

/** Edits descriptive fields only. Sport, category and code never change; quantities change only through movements. */
export async function updateItem(ctx: AppContext, actor: User, itemId: string, input: unknown, ip: string | null): Promise<ItemView> {
  requirePermission(actor, "item.manage");
  if (!/^\d+$/.test(itemId)) throw notFound("Item");
  const raw = (input ?? {}) as Record<string, unknown>;
  const p = updateSchema.safeParse(input);
  if (!p.success) throw validation(p.error);
  const has = (k: string) => Object.prototype.hasOwnProperty.call(raw, k);
  try {
    return await ctx.db.tx(async (q) => {
      const cur = (await q.query<ItemRow>(`${ITEM_SELECT} WHERE i.id = $1 FOR UPDATE OF i, st`, [itemId])).rows[0];
      if (!cur) throw notFound("Item");
      const next = {
        name: p.data.name ?? cur.name,
        brand: has("brand") ? p.data.brand ?? null : cur.brand,
        model: has("model") ? p.data.model ?? null : cur.model,
        size: has("size") ? p.data.size ?? null : cur.size,
        spec: has("spec") ? p.data.spec ?? null : cur.spec,
        unit: p.data.unit ?? cur.unit,
        location_id: p.data.locationId ?? cur.location_id,
        min_stock: has("minStock") ? p.data.minStock ?? null : cur.min_stock,
        is_consumable: p.data.isConsumable ?? cur.is_consumable,
        is_active: p.data.isActive ?? cur.is_active,
      };
      if (cur.is_active && !next.is_active && accountable(cur) > 0) {
        throw new AppError(409, "ITEM_HAS_STOCK", `This item still has ${accountable(cur)} accountable units. Return, discard or correct them first.`);
      }
      if (next.location_id !== cur.location_id) {
        const loc = (await q.query<{ is_active: boolean }>("SELECT is_active FROM locations WHERE id = $1", [next.location_id])).rows[0];
        if (!loc?.is_active) throw new AppError(400, "VALIDATION", "Choose an active storage location.");
      }
      await q.query(
        `UPDATE items SET name=$2, brand=$3, model=$4, size=$5, spec=$6, unit=$7, location_id=$8, min_stock=$9, is_consumable=$10, is_active=$11, updated_at=$12
          WHERE id = $1`,
        [itemId, next.name, next.brand, next.model, next.size, next.spec, next.unit, next.location_id, next.min_stock, next.is_consumable, next.is_active, ctx.now()],
      );
      const before = { name: cur.name, brand: cur.brand, model: cur.model, size: cur.size, spec: cur.spec, unit: cur.unit, location_id: cur.location_id, min_stock: cur.min_stock, is_consumable: cur.is_consumable, is_active: cur.is_active };
      await writeAudit(q, { actorId: actor.id, action: "item.update", entity: "item", entityId: itemId, before, after: next, ip });
      return itemView((await loadItem(q, itemId))!);
    });
  } catch (err) {
    if (pgCode(err) === PG.UNIQUE_VIOLATION && pgConstraint(err) === "items_definition_key") {
      throw new AppError(409, "DUPLICATE_ITEM", "Another item already has this name, brand, model and size in the same category.");
    }
    throw err;
  }
}

const receiveSchema = z.object({
  qty: z.number().int("Quantity must be a whole number.").min(1, "Quantity must be at least 1.").max(MAX_QTY),
  remarks: optText(300),
  idempotencyKey: z.string().optional(),
});

export interface ReceiptResult {
  movementId: string;
  itemId: string;
  code: string;
  qty: number;
  availableBefore: number;
  availableAfter: number;
}

/** Records newly received stock: Available += qty, with a RECEIPT movement. */
export async function receiveStock(ctx: AppContext, actor: User, itemId: string, input: unknown): Promise<ReceiptResult & { replayed: boolean }> {
  requirePermission(actor, "stock.receive");
  if (!/^\d+$/.test(itemId)) throw notFound("Item");
  const p = receiveSchema.safeParse(input);
  if (!p.success) throw validation(p.error);
  const now = ctx.now();
  const { result, replayed } = await ctx.db.tx((q) =>
    idempotent(q, p.data.idempotencyKey, actor.id, `stock.receive:${itemId}`, async (): Promise<ReceiptResult> => {
      const item = (await q.query<{ code: string; is_active: boolean }>("SELECT code, is_active FROM items WHERE id = $1", [itemId])).rows[0];
      if (!item) throw notFound("Item");
      if (!item.is_active) throw new AppError(409, "ITEM_INACTIVE", "This item is deactivated. Reactivate it before adding stock.");
      const locked = await lockStock(q, [itemId]);
      const m = await applyMovement(q, locked, {
        itemId,
        type: "RECEIPT",
        qty: p.data.qty,
        from: null,
        to: "AVAILABLE",
        actorId: actor.id,
        remarks: p.data.remarks,
        now,
      });
      return { movementId: m.movementId, itemId, code: item.code, qty: p.data.qty, availableBefore: m.before.available, availableAfter: m.after.available };
    }),
  );
  return { ...result, replayed };
}

const listSchema = z.object({
  q: z.string().trim().max(100).optional(),
  sportId: id.optional(),
  categoryId: id.optional(),
  locationId: id.optional(),
  lowStock: z.enum(["1", "true"]).optional(),
  status: z.enum(["active", "inactive", "all"]).default("active"),
  sort: z.enum(["name", "code", "available", "issued"]).default("name"),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

const SORT_SQL: Record<string, string> = {
  name: "s.name, c.name, i.name, i.code",
  code: "i.code",
  available: "st.available - st.reserved, i.name",
  issued: "st.issued DESC, i.name",
};

export async function listItems(ctx: AppContext, actor: User, input: unknown) {
  requirePermission(actor, "inventory.view");
  const p = listSchema.safeParse(input);
  if (!p.success) throw validation(p.error);
  const f = p.data;
  const pattern = f.q ? `%${f.q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%` : null;
  const res = await ctx.db.query<ItemRow>(
    `${ITEM_SELECT}
      WHERE ($1::text IS NULL OR i.name ILIKE $1 OR i.code ILIKE $1 OR i.brand ILIKE $1 OR i.model ILIKE $1 OR c.name ILIKE $1)
        AND ($2::bigint IS NULL OR i.sport_id = $2::bigint)
        AND ($3::bigint IS NULL OR i.category_id = $3::bigint)
        AND ($4::bigint IS NULL OR i.location_id = $4::bigint OR l.parent_id = $4::bigint)
        AND (NOT $5 OR (i.min_stock IS NOT NULL AND st.available - st.reserved < i.min_stock))
        AND ($6 = 'all' OR i.is_active = ($6 = 'active'))
      ORDER BY ${SORT_SQL[f.sort]}
      LIMIT $7 OFFSET $8`,
    [pattern, f.sportId ?? null, f.categoryId ?? null, f.locationId ?? null, f.lowStock !== undefined, f.status, f.limit, f.offset],
  );
  const totals = await ctx.db.query<{ n: string; available: string | null; issued: string | null; damaged: string | null; missing: string | null }>(
    `SELECT count(*) AS n, sum(st.available) AS available, sum(st.issued) AS issued, sum(st.damaged) AS damaged, sum(st.missing) AS missing
       FROM items i JOIN item_stock st ON st.item_id = i.id JOIN categories c ON c.id = i.category_id JOIN locations l ON l.id = i.location_id
      WHERE ($1::text IS NULL OR i.name ILIKE $1 OR i.code ILIKE $1 OR i.brand ILIKE $1 OR i.model ILIKE $1 OR c.name ILIKE $1)
        AND ($2::bigint IS NULL OR i.sport_id = $2::bigint)
        AND ($3::bigint IS NULL OR i.category_id = $3::bigint)
        AND ($4::bigint IS NULL OR i.location_id = $4::bigint OR l.parent_id = $4::bigint)
        AND (NOT $5 OR (i.min_stock IS NOT NULL AND st.available - st.reserved < i.min_stock))
        AND ($6 = 'all' OR i.is_active = ($6 = 'active'))`,
    [pattern, f.sportId ?? null, f.categoryId ?? null, f.locationId ?? null, f.lowStock !== undefined, f.status],
  );
  const t = totals.rows[0]!;
  return {
    items: res.rows.map(itemView),
    total: Number(t.n),
    sums: { available: Number(t.available ?? 0), issued: Number(t.issued ?? 0), damaged: Number(t.damaged ?? 0), missing: Number(t.missing ?? 0) },
  };
}

export interface MovementView {
  id: string;
  type: string;
  qty: number;
  from: string | null;
  to: string | null;
  before: Record<string, number>;
  after: Record<string, number>;
  remarks: string | null;
  source: string | null;
  createdAt: Date;
  actor: string | null;
  reversed: boolean;
}

export async function getItem(ctx: AppContext, actor: User, itemId: string, opts: { movementsBefore?: string } = {}) {
  requirePermission(actor, "inventory.view");
  if (!/^\d+$/.test(itemId)) throw notFound("Item");
  const row = await loadItem(ctx.db, itemId);
  if (!row) throw notFound("Item");
  const mv = await ctx.db.query<{
    id: string; type: string; qty: number; from_state: string | null; to_state: string | null;
    before: Record<string, number>; after: Record<string, number>; remarks: string | null;
    source_table: string | null; source_id: string | null; created_at: Date; actor: string | null; reversed: boolean;
  }>(
    `SELECT m.id, m.type, m.qty, m.from_state, m.to_state, m.before, m.after, m.remarks, m.source_table, m.source_id, m.created_at,
            coalesce(u.name, u.email) AS actor,
            EXISTS (SELECT 1 FROM stock_movements r WHERE r.reverses_id = m.id) AS reversed
       FROM stock_movements m LEFT JOIN users u ON u.id = m.actor_id
      WHERE m.item_id = $1 AND ($2::bigint IS NULL OR m.id < $2::bigint)
      ORDER BY m.id DESC LIMIT 50`,
    [itemId, opts.movementsBefore && /^\d+$/.test(opts.movementsBefore) ? opts.movementsBefore : null],
  );
  const movements: MovementView[] = mv.rows.map((m) => ({
    id: m.id,
    type: m.type,
    qty: m.qty,
    from: m.from_state,
    to: m.to_state,
    before: m.before,
    after: m.after,
    remarks: m.remarks,
    source: m.source_table === "import_batches" ? `Excel import #${m.source_id}` : null,
    createdAt: m.created_at,
    actor: m.actor,
    reversed: m.reversed,
  }));
  return { item: itemView(row), movements };
}
