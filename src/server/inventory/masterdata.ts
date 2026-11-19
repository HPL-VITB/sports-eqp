/** Sports, categories and storage locations. Managed by FR Sports; readable by all staff. */
import { z } from "zod";
import { writeAudit } from "../audit";
import { can, requirePermission } from "../auth/permissions";
import type { User } from "../auth/users";
import type { AppContext } from "../context";
import { PG, pgCode, pgConstraint, type Queryable } from "../db/types";
import { AppError, forbidden, notFound } from "../errors";

export interface Sport { id: string; name: string; code: string; is_active: boolean; category_count: number; item_count: number }
export interface Category { id: string; sport_id: string; name: string; code: string; is_active: boolean; item_count: number }
export interface Location { id: string; name: string; parent_id: string | null; is_active: boolean; path: string }

const idSchema = z.string().regex(/^\d+$/, "Invalid id.");
const nameSchema = z.string().trim().min(2, "Name is too short.").max(60);

function validation(err: z.ZodError) {
  return new AppError(400, "VALIDATION", err.issues[0]?.message ?? "Invalid input.");
}

function canReadMasterData(user: User) {
  if (!user.is_active || !(can(user.role, "inventory.view") || can(user.role, "catalog.view"))) throw forbidden();
}

/** Turns "Table Tennis Balls" into a short upper-case code not already taken, e.g. "TAB", "TA2". */
export function deriveCode(name: string, taken: Set<string>, len = 3): string {
  const letters = name.toUpperCase().replace(/[^A-Z0-9]/g, "") || "X";
  const words = name.toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean);
  const candidates = [
    letters.slice(0, len),
    words.map((w) => w[0]).join("").slice(0, len),
    letters.slice(0, 2) + letters.slice(-1),
  ].filter((c) => c.length >= 2);
  for (const c of candidates) if (!taken.has(c)) return c;
  const base = (candidates[0] ?? "X").slice(0, len - 1).padEnd(len - 1, "X");
  for (let i = 2; i < 100; i++) {
    const c = `${base}${i}`.slice(0, 4);
    if (!taken.has(c)) return c;
  }
  throw new AppError(409, "CODE_EXHAUSTED", "Could not generate a code; enter one manually.");
}

function friendlyUnique(err: unknown, what: string): never {
  if (pgCode(err) === PG.UNIQUE_VIOLATION) {
    const c = pgConstraint(err) ?? "";
    throw new AppError(409, "DUPLICATE", c.includes("code") ? `That ${what} code is already used.` : `That ${what} already exists.`);
  }
  throw err;
}

// ---------- sports ----------

export async function listSports(ctx: AppContext, actor: User, opts: { includeInactive?: boolean } = {}): Promise<Sport[]> {
  canReadMasterData(actor);
  const res = await ctx.db.query<Sport>(
    `SELECT s.id, s.name, s.code, s.is_active,
            (SELECT count(*)::int FROM categories c WHERE c.sport_id = s.id) AS category_count,
            (SELECT count(*)::int FROM items i WHERE i.sport_id = s.id) AS item_count
       FROM sports s WHERE ($1 OR s.is_active) ORDER BY s.name`,
    [opts.includeInactive ?? false],
  );
  return res.rows;
}

const sportCreate = z.object({ name: nameSchema, code: z.string().trim().toUpperCase().regex(/^[A-Z]{2,4}$/, "Sport code: 2-4 letters.").optional() });

export async function createSport(ctx: AppContext, actor: User, input: unknown, ip: string | null) {
  requirePermission(actor, "masterdata.manage");
  const p = sportCreate.safeParse(input);
  if (!p.success) throw validation(p.error);
  try {
    return await ctx.db.tx(async (q) => {
      const taken = new Set((await q.query<{ code: string }>("SELECT code FROM sports")).rows.map((r) => r.code));
      const code = p.data.code ?? deriveCode(p.data.name.replace(/[^A-Za-z ]/g, ""), taken);
      const res = await q.query<{ id: string }>("INSERT INTO sports (name, code) VALUES ($1, $2) RETURNING id", [p.data.name, code]);
      const id = res.rows[0]!.id;
      await writeAudit(q, { actorId: actor.id, action: "sport.create", entity: "sport", entityId: id, after: { name: p.data.name, code }, ip });
      return { id, name: p.data.name, code };
    });
  } catch (err) {
    friendlyUnique(err, "sport");
  }
}

const sportUpdate = z.object({ name: nameSchema.optional(), isActive: z.boolean().optional() }).strict();

/** Codes never change once created, because item codes contain them. */
export async function updateSport(ctx: AppContext, actor: User, id: string, input: unknown, ip: string | null) {
  requirePermission(actor, "masterdata.manage");
  if (!idSchema.safeParse(id).success) throw notFound("Sport");
  const p = sportUpdate.safeParse(input);
  if (!p.success) throw validation(p.error);
  try {
    return await ctx.db.tx(async (q) => {
      const cur = (await q.query<{ name: string; is_active: boolean }>("SELECT name, is_active FROM sports WHERE id = $1 FOR UPDATE", [id])).rows[0];
      if (!cur) throw notFound("Sport");
      const next = { name: p.data.name ?? cur.name, is_active: p.data.isActive ?? cur.is_active };
      await q.query("UPDATE sports SET name = $2, is_active = $3 WHERE id = $1", [id, next.name, next.is_active]);
      await writeAudit(q, { actorId: actor.id, action: "sport.update", entity: "sport", entityId: id, before: cur, after: next, ip });
      return { id, ...next };
    });
  } catch (err) {
    friendlyUnique(err, "sport");
  }
}

// ---------- categories ----------

export async function listCategories(ctx: AppContext, actor: User, opts: { sportId?: string; includeInactive?: boolean } = {}): Promise<Category[]> {
  canReadMasterData(actor);
  const res = await ctx.db.query<Category>(
    `SELECT c.id, c.sport_id, c.name, c.code, c.is_active,
            (SELECT count(*)::int FROM items i WHERE i.category_id = c.id) AS item_count
       FROM categories c
      WHERE ($1::bigint IS NULL OR c.sport_id = $1::bigint) AND ($2 OR c.is_active)
      ORDER BY c.name`,
    [opts.sportId && /^\d+$/.test(opts.sportId) ? opts.sportId : null, opts.includeInactive ?? false],
  );
  return res.rows;
}

/** Internal: creates a category (code derived from the name when not given). Caller checks permission. */
export async function insertCategory(q: Queryable, sportId: string, name: string, code?: string) {
  const sport = (await q.query<{ is_active: boolean }>("SELECT is_active FROM sports WHERE id = $1", [sportId])).rows[0];
  if (!sport) throw notFound("Sport");
  if (!sport.is_active) throw new AppError(409, "SPORT_INACTIVE", "This sport is deactivated.");
  const taken = new Set((await q.query<{ code: string }>("SELECT code FROM categories WHERE sport_id = $1", [sportId])).rows.map((r) => r.code));
  const finalCode = code ?? deriveCode(name, taken);
  const res = await q.query<{ id: string }>(
    "INSERT INTO categories (sport_id, name, code) VALUES ($1, $2, $3) RETURNING id",
    [sportId, name, finalCode],
  );
  return { id: res.rows[0]!.id, sportId, name, code: finalCode };
}

const categoryCreate = z.object({
  sportId: idSchema,
  name: nameSchema,
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{2,4}$/, "Category code: 2-4 letters or digits.").optional(),
});

export async function createCategory(ctx: AppContext, actor: User, input: unknown, ip: string | null) {
  requirePermission(actor, "masterdata.manage");
  const p = categoryCreate.safeParse(input);
  if (!p.success) throw validation(p.error);
  try {
    return await ctx.db.tx(async (q) => {
      const c = await insertCategory(q, p.data.sportId, p.data.name, p.data.code);
      await writeAudit(q, { actorId: actor.id, action: "category.create", entity: "category", entityId: c.id, after: c, ip });
      return c;
    });
  } catch (err) {
    friendlyUnique(err, "category");
  }
}

const categoryUpdate = z.object({ name: nameSchema.optional(), isActive: z.boolean().optional() }).strict();

export async function updateCategory(ctx: AppContext, actor: User, id: string, input: unknown, ip: string | null) {
  requirePermission(actor, "masterdata.manage");
  if (!idSchema.safeParse(id).success) throw notFound("Category");
  const p = categoryUpdate.safeParse(input);
  if (!p.success) throw validation(p.error);
  try {
    return await ctx.db.tx(async (q) => {
      const cur = (await q.query<{ name: string; is_active: boolean }>("SELECT name, is_active FROM categories WHERE id = $1 FOR UPDATE", [id])).rows[0];
      if (!cur) throw notFound("Category");
      const next = { name: p.data.name ?? cur.name, is_active: p.data.isActive ?? cur.is_active };
      await q.query("UPDATE categories SET name = $2, is_active = $3 WHERE id = $1", [id, next.name, next.is_active]);
      await writeAudit(q, { actorId: actor.id, action: "category.update", entity: "category", entityId: id, before: cur, after: next, ip });
      return { id, ...next };
    });
  } catch (err) {
    friendlyUnique(err, "category");
  }
}

// ---------- locations ----------

export async function listLocations(ctx: AppContext, actor: User, opts: { includeInactive?: boolean } = {}): Promise<Location[]> {
  canReadMasterData(actor);
  const res = await ctx.db.query<Location>(
    `SELECT l.id, l.name, l.parent_id, l.is_active,
            CASE WHEN p.id IS NULL THEN l.name ELSE p.name || ' › ' || l.name END AS path
       FROM locations l LEFT JOIN locations p ON p.id = l.parent_id
      WHERE ($1 OR l.is_active)
      ORDER BY coalesce(p.name, l.name), l.parent_id NULLS FIRST, l.name`,
    [opts.includeInactive ?? false],
  );
  return res.rows;
}

const locationCreate = z.object({ name: nameSchema, parentId: idSchema.optional() });

export async function createLocation(ctx: AppContext, actor: User, input: unknown, ip: string | null) {
  requirePermission(actor, "masterdata.manage");
  const p = locationCreate.safeParse(input);
  if (!p.success) throw validation(p.error);
  try {
    return await ctx.db.tx(async (q) => {
      if (p.data.parentId) {
        const parent = (await q.query<{ parent_id: string | null }>("SELECT parent_id FROM locations WHERE id = $1", [p.data.parentId])).rows[0];
        if (!parent) throw notFound("Parent location");
        if (parent.parent_id !== null) throw new AppError(400, "VALIDATION", "Rooms can only be added under a top-level location.");
      }
      const res = await q.query<{ id: string }>("INSERT INTO locations (name, parent_id) VALUES ($1, $2) RETURNING id", [p.data.name, p.data.parentId ?? null]);
      const id = res.rows[0]!.id;
      await writeAudit(q, { actorId: actor.id, action: "location.create", entity: "location", entityId: id, after: p.data, ip });
      return { id, name: p.data.name, parentId: p.data.parentId ?? null };
    });
  } catch (err) {
    friendlyUnique(err, "location");
  }
}

const locationUpdate = z.object({ name: nameSchema.optional(), isActive: z.boolean().optional() }).strict();

export async function updateLocation(ctx: AppContext, actor: User, id: string, input: unknown, ip: string | null) {
  requirePermission(actor, "masterdata.manage");
  if (!idSchema.safeParse(id).success) throw notFound("Location");
  const p = locationUpdate.safeParse(input);
  if (!p.success) throw validation(p.error);
  try {
    return await ctx.db.tx(async (q) => {
      const cur = (await q.query<{ name: string; is_active: boolean }>("SELECT name, is_active FROM locations WHERE id = $1 FOR UPDATE", [id])).rows[0];
      if (!cur) throw notFound("Location");
      if (p.data.isActive === false) {
        const used = await q.query("SELECT 1 FROM items WHERE location_id = $1 AND is_active LIMIT 1", [id]);
        if (used.rowCount) throw new AppError(409, "LOCATION_IN_USE", "Move the equipment stored here to another location first.");
      }
      const next = { name: p.data.name ?? cur.name, is_active: p.data.isActive ?? cur.is_active };
      await q.query("UPDATE locations SET name = $2, is_active = $3 WHERE id = $1", [id, next.name, next.is_active]);
      await writeAudit(q, { actorId: actor.id, action: "location.update", entity: "location", entityId: id, before: cur, after: next, ip });
      return { id, ...next };
    });
  } catch (err) {
    friendlyUnique(err, "location");
  }
}
