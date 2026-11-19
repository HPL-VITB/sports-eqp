/**
 * Physical stock counts. Only what should be ON THE SHELF is counted: usable (= Available) and damaged (= Damaged).
 * Issued and missing units are shown for information and are never treated as shortages.
 * On submission the system figures are captured under lock, differences become correction requests for FR Sports,
 * and the count becomes a verification report.
 */
import { z } from "zod";
import { writeAudit } from "../audit";
import { can, requirePermission } from "../auth/permissions";
import type { User } from "../auth/users";
import type { AppContext } from "../context";
import { PG, pgCode } from "../db/types";
import { AppError, forbidden, notFound } from "../errors";
import { lockStock } from "../inventory/ledger";
import { insertCorrection } from "./corrections";

const startSchema = z.object({
  scopeType: z.enum(["ALL", "SPORT", "CATEGORY", "LOCATION"]),
  scopeId: z.string().regex(/^\d+$/).optional().nullable(),
});

export async function startCount(ctx: AppContext, actor: User, input: unknown, ip: string | null) {
  requirePermission(actor, "verification.count");
  const p = startSchema.safeParse(input);
  if (!p.success) throw new AppError(400, "VALIDATION", p.error.issues[0]?.message ?? "Invalid input.");
  const { scopeType } = p.data;
  const scopeId = scopeType === "ALL" ? null : p.data.scopeId;
  if (scopeType !== "ALL" && !scopeId) throw new AppError(400, "VALIDATION", "Choose what to count.");
  try {
    return await ctx.db.tx(async (q) => {
      let label = "Whole store";
      if (scopeType !== "ALL") {
        const sql = {
          SPORT: "SELECT name AS label FROM sports WHERE id = $1",
          CATEGORY: "SELECT s.name || ' › ' || c.name AS label FROM categories c JOIN sports s ON s.id = c.sport_id WHERE c.id = $1",
          LOCATION: "SELECT name AS label FROM locations WHERE id = $1",
        }[scopeType];
        const r = (await q.query<{ label: string }>(sql, [scopeId])).rows[0];
        if (!r) throw notFound("Scope");
        label = r.label;
      }
      const id = (await q.query<{ id: string }>(
        "INSERT INTO verification_sessions (scope_type, scope_id, scope_label, started_by, started_at) VALUES ($1,$2,$3,$4,$5) RETURNING id",
        [scopeType, scopeId, label, actor.id, ctx.now()],
      )).rows[0]!.id;
      const lines = await q.query(
        `INSERT INTO verification_lines (session_id, item_id)
         SELECT $1, i.id FROM items i JOIN locations l ON l.id = i.location_id
          WHERE i.is_active AND CASE $2::text
            WHEN 'SPORT' THEN i.sport_id = $3::bigint
            WHEN 'CATEGORY' THEN i.category_id = $3::bigint
            WHEN 'LOCATION' THEN i.location_id = $3::bigint OR l.parent_id = $3::bigint
            ELSE true END`,
        [id, scopeType, scopeId],
      );
      if (!lines.rowCount) throw new AppError(400, "NOTHING_TO_COUNT", "There is no active equipment in this selection.");
      await writeAudit(q, { actorId: actor.id, action: "count.start", entity: "verification", entityId: id, after: { scopeType, scopeId, label, items: lines.rowCount }, ip });
      return { id, label, items: lines.rowCount };
    });
  } catch (err) {
    if (pgCode(err) === PG.UNIQUE_VIOLATION) throw new AppError(409, "COUNT_OPEN", "A count of this selection is already in progress. Continue that one.");
    throw err;
  }
}

export interface CountLineView {
  lineId: string;
  item: { id: string; code: string; name: string; unit: string; sport: string; category: string };
  countedUsable: number | null;
  countedDamaged: number | null;
  expectedUsable: number;
  expectedDamaged: number;
  issued: number;
  missing: number;
  expectedOnShelf: number;
  correction: { id: string; state: string; delta: number; status: string }[];
}

export async function getCount(ctx: AppContext, actor: User, id: string) {
  if (!actor.is_active || !(can(actor.role, "verification.count") || can(actor.role, "reports.view"))) throw forbidden();
  if (!/^\d+$/.test(id)) throw notFound("Count");
  const s = (await ctx.db.query<{ id: string; scope_label: string; status: string; started_at: Date; started_by: string; submitted_at: Date | null; submitted_by: string | null }>(
    `SELECT v.id, v.scope_label, v.status, v.started_at, coalesce(a.name, a.email) AS started_by, v.submitted_at, coalesce(b.name, b.email) AS submitted_by
       FROM verification_sessions v JOIN users a ON a.id = v.started_by LEFT JOIN users b ON b.id = v.submitted_by WHERE v.id = $1`,
    [id],
  )).rows[0];
  if (!s) throw notFound("Count");
  const lines = (await ctx.db.query<{
    id: string; item_id: string; code: string; name: string; unit: string; sport: string; category: string; counted_usable: number | null; counted_damaged: number | null;
    expected_usable: number | null; expected_damaged: number | null; issued_at_count: number | null; missing_at_count: number | null;
    available: number; damaged: number; issued: number; missing: number;
  }>(
    `SELECT vl.id, vl.item_id, it.code, it.name, it.unit, s.name AS sport, c.name AS category, vl.counted_usable, vl.counted_damaged,
            vl.expected_usable, vl.expected_damaged, vl.issued_at_count, vl.missing_at_count, st.available, st.damaged, st.issued, st.missing
       FROM verification_lines vl JOIN items it ON it.id = vl.item_id JOIN sports s ON s.id = it.sport_id JOIN categories c ON c.id = it.category_id
       JOIN item_stock st ON st.item_id = vl.item_id
      WHERE vl.session_id = $1 ORDER BY s.name, c.name, it.name`,
    [id],
  )).rows;
  const corr = (await ctx.db.query<{ verification_line_id: string; id: string; state: string; delta: number; status: string }>(
    "SELECT a.verification_line_id, a.id, a.state, a.delta, a.status FROM adjustments a JOIN verification_lines vl ON vl.id = a.verification_line_id WHERE vl.session_id = $1",
    [id],
  )).rows;
  const submitted = s.status === "SUBMITTED";
  return {
    id: s.id, label: s.scope_label, status: s.status, startedAt: s.started_at, startedBy: s.started_by, submittedAt: s.submitted_at, submittedBy: s.submitted_by,
    lines: lines.map((l): CountLineView => {
      const eu = submitted ? l.expected_usable! : l.available;
      const ed = submitted ? l.expected_damaged! : l.damaged;
      return {
        lineId: l.id,
        item: { id: l.item_id, code: l.code, name: l.name, unit: l.unit, sport: l.sport, category: l.category },
        countedUsable: l.counted_usable, countedDamaged: l.counted_damaged, expectedUsable: eu, expectedDamaged: ed,
        issued: submitted ? l.issued_at_count! : l.issued, missing: submitted ? l.missing_at_count! : l.missing, expectedOnShelf: eu + ed,
        correction: corr.filter((c) => String(c.verification_line_id) === String(l.id)).map((c) => ({ id: c.id, state: c.state, delta: c.delta, status: c.status })),
      };
    }),
  };
}

export async function listCounts(ctx: AppContext, actor: User) {
  if (!actor.is_active || !(can(actor.role, "verification.count") || can(actor.role, "reports.view"))) throw forbidden();
  return (await ctx.db.query<{ id: string; scope_label: string; status: string; started_at: Date; started_by: string; submitted_at: Date | null; lines: number; counted: number; discrepancies: number }>(
    `SELECT v.id, v.scope_label, v.status, v.started_at, coalesce(u.name, u.email) AS started_by, v.submitted_at,
            (SELECT count(*)::int FROM verification_lines l WHERE l.session_id = v.id) AS lines,
            (SELECT count(*)::int FROM verification_lines l WHERE l.session_id = v.id AND l.counted_usable IS NOT NULL) AS counted,
            (SELECT count(*)::int FROM adjustments a JOIN verification_lines l ON l.id = a.verification_line_id WHERE l.session_id = v.id) AS discrepancies
       FROM verification_sessions v JOIN users u ON u.id = v.started_by ORDER BY v.id DESC LIMIT 100`,
  )).rows;
}

const saveSchema = z.object({
  lines: z.array(z.object({
    itemId: z.string().regex(/^\d+$/),
    usable: z.number().int().min(0).max(100_000).nullable(),
    damaged: z.number().int().min(0).max(100_000).nullable(),
  })).max(5000),
});

/** Saves counts entered so far (can be done in several sittings). */
export async function saveCounts(ctx: AppContext, actor: User, id: string, input: unknown) {
  requirePermission(actor, "verification.count");
  if (!/^\d+$/.test(id)) throw notFound("Count");
  const p = saveSchema.safeParse(input);
  if (!p.success) throw new AppError(400, "VALIDATION", p.error.issues[0]?.message ?? "Invalid input.");
  return ctx.db.tx(async (q) => {
    const s = (await q.query<{ status: string }>("SELECT status FROM verification_sessions WHERE id = $1 FOR UPDATE", [id])).rows[0];
    if (!s) throw notFound("Count");
    if (s.status !== "OPEN") throw new AppError(409, "COUNT_CLOSED", "This count has already been submitted.");
    let saved = 0;
    for (const l of p.data.lines) {
      const r = await q.query(
        "UPDATE verification_lines SET counted_usable = $3, counted_damaged = $4 WHERE session_id = $1 AND item_id = $2",
        [id, l.itemId, l.usable, l.damaged],
      );
      saved += r.rowCount;
    }
    return { saved };
  });
}

export async function submitCount(ctx: AppContext, actor: User, id: string, ip: string | null) {
  requirePermission(actor, "verification.count");
  if (!/^\d+$/.test(id)) throw notFound("Count");
  const now = ctx.now();
  return ctx.db.tx(async (q) => {
    const s = (await q.query<{ status: string }>("SELECT status FROM verification_sessions WHERE id = $1 FOR UPDATE", [id])).rows[0];
    if (!s) throw notFound("Count");
    if (s.status !== "OPEN") throw new AppError(409, "COUNT_CLOSED", "This count has already been submitted.");
    const lines = (await q.query<{ id: string; item_id: string; counted_usable: number | null; counted_damaged: number | null; name: string }>(
      "SELECT vl.id, vl.item_id, vl.counted_usable, vl.counted_damaged, it.name FROM verification_lines vl JOIN items it ON it.id = vl.item_id WHERE vl.session_id = $1",
      [id],
    )).rows;
    const blank = lines.filter((l) => l.counted_usable === null || l.counted_damaged === null);
    if (blank.length) {
      throw new AppError(400, "COUNT_INCOMPLETE", `Enter both counts for every item (0 if none). Missing: ${blank.slice(0, 5).map((l) => l.name).join(", ")}${blank.length > 5 ? ` and ${blank.length - 5} more` : ""}.`);
    }
    const locked = await lockStock(q, lines.map((l) => String(l.item_id)));
    const created: { itemId: string; state: string; delta: number; correctionId: string }[] = [];
    for (const l of lines) {
      const st = locked.get(String(l.item_id))!;
      await q.query(
        "UPDATE verification_lines SET expected_usable = $2, expected_damaged = $3, issued_at_count = $4, missing_at_count = $5 WHERE id = $1",
        [l.id, st.available, st.damaged, st.issued, st.missing],
      );
      for (const [state, expected, counted] of [["AVAILABLE", st.available, l.counted_usable!], ["DAMAGED", st.damaged, l.counted_damaged!]] as const) {
        if (expected === counted) continue;
        const cid = await insertCorrection(q, {
          itemId: String(l.item_id), state, expected, counted, reason: `Stock count #${id}`, requestedBy: actor.id, verificationLineId: l.id, now,
        });
        created.push({ itemId: String(l.item_id), state, delta: counted - expected, correctionId: cid });
      }
    }
    await q.query("UPDATE verification_sessions SET status = 'SUBMITTED', submitted_by = $2, submitted_at = $3 WHERE id = $1", [id, actor.id, now]);
    await writeAudit(q, { actorId: actor.id, action: "count.submit", entity: "verification", entityId: id, after: { items: lines.length, discrepancies: created.length }, ip });
    return { id, items: lines.length, discrepancies: created };
  });
}

export async function abandonCount(ctx: AppContext, actor: User, id: string, ip: string | null) {
  requirePermission(actor, "verification.count");
  if (!/^\d+$/.test(id)) throw notFound("Count");
  return ctx.db.tx(async (q) => {
    const r = await q.query("UPDATE verification_sessions SET status = 'ABANDONED' WHERE id = $1 AND status = 'OPEN' RETURNING id", [id]);
    if (!r.rowCount) throw new AppError(409, "COUNT_CLOSED", "Only an open count can be abandoned.");
    await writeAudit(q, { actorId: actor.id, action: "count.abandon", entity: "verification", entityId: id, ip });
    return { id, status: "ABANDONED" };
  });
}
