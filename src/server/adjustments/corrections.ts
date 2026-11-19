/**
 * Stock corrections. Staff record expected vs actual; the DIFFERENCE is stored and, on FR Sports approval, applied as a
 * CORRECTION movement. Applying a difference (not overwriting a total) keeps the result right even if issues or returns
 * happened between counting and approval. Historical balances are never overwritten.
 * Damaged corrections keep damage records in step: extra damaged units open a record; fewer close the oldest records.
 */
import { z } from "zod";
import { writeAudit } from "../audit";
import { can, requirePermission } from "../auth/permissions";
import type { User } from "../auth/users";
import type { AppContext } from "../context";
import type { Queryable } from "../db/types";
import { AppError, forbidden, notFound } from "../errors";
import { applyMovement, availableToIssue, lockStock } from "../inventory/ledger";

const optText = (max: number) => z.string().trim().max(max).optional().nullable().transform((v) => (v ? v : null));

/** Internal: inserts a pending correction. Caller has permission-checked and holds the stock lock. */
export async function insertCorrection(
  q: Queryable,
  c: { itemId: string; state: "AVAILABLE" | "DAMAGED"; expected: number; counted: number; reason: string; requestedBy: string; verificationLineId?: string; now: Date },
): Promise<string> {
  const pending = await q.query("SELECT 1 FROM adjustments WHERE item_id = $1 AND state = $2 AND status = 'PENDING'", [c.itemId, c.state]);
  if (pending.rowCount) {
    const name = (await q.query<{ name: string }>("SELECT name FROM items WHERE id = $1", [c.itemId])).rows[0]?.name ?? c.itemId;
    throw new AppError(409, "CORRECTION_PENDING", `${name} already has a ${c.state.toLowerCase()} correction waiting for FR Sports.`);
  }
  return (await q.query<{ id: string }>(
    `INSERT INTO adjustments (item_id, state, delta, expected_qty, counted_qty, reason, verification_line_id, requested_by, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [c.itemId, c.state, c.counted - c.expected, c.expected, c.counted, c.reason, c.verificationLineId ?? null, c.requestedBy, c.now],
  )).rows[0]!.id;
}

const requestSchema = z.object({
  itemId: z.string().regex(/^\d+$/),
  state: z.enum(["AVAILABLE", "DAMAGED"]),
  countedQty: z.number().int().min(0).max(100_000),
  reason: z.string().trim().min(3, "Explain the discrepancy briefly.").max(300),
});

export async function requestCorrection(ctx: AppContext, actor: User, input: unknown, ip: string | null) {
  requirePermission(actor, "adjustment.request");
  const p = requestSchema.safeParse(input);
  if (!p.success) throw new AppError(400, "VALIDATION", p.error.issues[0]?.message ?? "Invalid input.");
  const d = p.data;
  return ctx.db.tx(async (q) => {
    const locked = await lockStock(q, [d.itemId]);
    const st = locked.get(d.itemId)!;
    const expected = d.state === "AVAILABLE" ? st.available : st.damaged;
    if (expected === d.countedQty) throw new AppError(400, "NO_DIFFERENCE", "The count matches the records; nothing to correct.");
    const id = await insertCorrection(q, { itemId: d.itemId, state: d.state, expected, counted: d.countedQty, reason: d.reason, requestedBy: actor.id, now: ctx.now() });
    await writeAudit(q, { actorId: actor.id, action: "correction.request", entity: "adjustment", entityId: id, after: { ...d, expected, delta: d.countedQty - expected }, ip });
    return { id, expected, counted: d.countedQty, delta: d.countedQty - expected };
  });
}

const decideSchema = z.object({ decision: z.enum(["APPROVE", "REJECT"]), note: optText(300) });

export async function decideCorrection(ctx: AppContext, actor: User, id: string, input: unknown, ip: string | null) {
  requirePermission(actor, "adjustment.approve");
  if (!/^\d+$/.test(id)) throw notFound("Correction");
  const p = decideSchema.safeParse(input);
  if (!p.success) throw new AppError(400, "VALIDATION", p.error.issues[0]?.message ?? "Invalid input.");
  if (p.data.decision === "REJECT" && !p.data.note) throw new AppError(400, "VALIDATION", "Give a short reason for rejecting.");
  const now = ctx.now();
  return ctx.db.tx(async (q) => {
    const a = (await q.query<{ item_id: string; state: "AVAILABLE" | "DAMAGED"; delta: number; status: string; requested_by: string; reason: string }>(
      "SELECT item_id, state, delta, status, requested_by, reason FROM adjustments WHERE id = $1 FOR UPDATE",
      [id],
    )).rows[0];
    if (!a) throw notFound("Correction");
    if (a.status !== "PENDING") throw new AppError(409, "ALREADY_PROCESSED", `This correction was already ${a.status.toLowerCase()}.`);
    if (String(a.requested_by) === String(actor.id)) throw new AppError(403, "SELF_DECISION", "You cannot approve your own correction.");
    if (p.data.decision === "REJECT") {
      await q.query("UPDATE adjustments SET status = 'REJECTED', decided_by = $2, decided_at = $3, decision_note = $4 WHERE id = $1", [id, actor.id, now, p.data.note]);
      await writeAudit(q, { actorId: actor.id, action: "correction.reject", entity: "adjustment", entityId: id, after: { note: p.data.note }, ip });
      return { id, status: "REJECTED" };
    }

    const itemId = String(a.item_id);
    const locked = await lockStock(q, [itemId]);
    const st = locked.get(itemId)!;
    const qty = Math.abs(a.delta);
    const source = { table: "adjustments", id };
    const remarks = `Correction: ${a.reason}`;
    let movementId: string;
    if (a.state === "AVAILABLE") {
      if (a.delta < 0 && availableToIssue(st) < qty) {
        throw new AppError(409, "INSUFFICIENT_STOCK", `Cannot remove ${qty}: only ${availableToIssue(st)} available now (others are held by pending discards). Nothing was changed.`);
      }
      movementId = (await applyMovement(q, locked, {
        itemId, type: "CORRECTION", qty, from: a.delta < 0 ? "AVAILABLE" : null, to: a.delta > 0 ? "AVAILABLE" : null,
        actorId: actor.id, approvedBy: actor.id, source, remarks, now,
      })).movementId;
    } else if (a.delta > 0) {
      movementId = (await applyMovement(q, locked, { itemId, type: "CORRECTION", qty, from: null, to: "DAMAGED", actorId: actor.id, approvedBy: actor.id, source, remarks, now })).movementId;
      await q.query(
        `INSERT INTO incidents (type, item_id, qty, description, reported_by, created_at) VALUES ('STORE_DAMAGE', $1, $2, $3, $4, $5)`,
        [itemId, qty, `Found in stock correction #${id}: ${a.reason}`, actor.id, now],
      );
    } else {
      // Fewer damaged units than recorded: close the oldest open damage records that are not held by a discard.
      const open = (await q.query<{ id: string; free: number }>(
        `SELECT id, qty - qty_resolved - qty_reserved AS free FROM incidents
          WHERE item_id = $1 AND type IN ('DAMAGED','STORE_DAMAGE') AND qty - qty_resolved - qty_reserved > 0
          ORDER BY created_at, id FOR UPDATE`,
        [itemId],
      )).rows;
      const free = open.reduce((s, r) => s + r.free, 0);
      if (free < qty) throw new AppError(409, "INSUFFICIENT_STOCK", `Cannot remove ${qty} damaged: only ${free} are not held by pending discards. Nothing was changed.`);
      movementId = (await applyMovement(q, locked, { itemId, type: "CORRECTION", qty, from: "DAMAGED", to: null, actorId: actor.id, approvedBy: actor.id, source, remarks, now })).movementId;
      let left = qty;
      for (const r of open) {
        if (left === 0) break;
        const take = Math.min(left, r.free);
        await q.query("UPDATE incidents SET qty_resolved = qty_resolved + $2 WHERE id = $1", [r.id, take]);
        await q.query(
          "INSERT INTO incident_resolutions (incident_id, action, qty, remarks, movement_id, resolved_by, created_at) VALUES ($1,'CORRECTED',$2,$3,$4,$5,$6)",
          [r.id, take, `Stock correction #${id}`, movementId, actor.id, now],
        );
        left -= take;
      }
    }
    const done = await q.query("UPDATE adjustments SET status = 'APPROVED', decided_by = $2, decided_at = $3, decision_note = $4, movement_id = $5 WHERE id = $1 AND status = 'PENDING'", [id, actor.id, now, p.data.note, movementId]);
    if (!done.rowCount) throw new AppError(409, "ALREADY_PROCESSED", "This correction was already decided.");
    await writeAudit(q, { actorId: actor.id, action: "correction.approve", entity: "adjustment", entityId: id, after: { delta: a.delta, state: a.state }, ip });
    return { id, status: "APPROVED", stockAfter: locked.get(itemId) };
  });
}

export async function cancelCorrection(ctx: AppContext, actor: User, id: string, ip: string | null) {
  if (!/^\d+$/.test(id)) throw notFound("Correction");
  return ctx.db.tx(async (q) => {
    const a = (await q.query<{ status: string; requested_by: string }>("SELECT status, requested_by FROM adjustments WHERE id = $1 FOR UPDATE", [id])).rows[0];
    if (!a) throw notFound("Correction");
    if (String(a.requested_by) !== String(actor.id)) throw forbidden("Only the person who asked can cancel this correction.");
    if (a.status !== "PENDING") throw new AppError(409, "ALREADY_PROCESSED", `This correction was already ${a.status.toLowerCase()}.`);
    await q.query("UPDATE adjustments SET status = 'CANCELLED', decided_by = $2, decided_at = $3 WHERE id = $1", [id, actor.id, ctx.now()]);
    await writeAudit(q, { actorId: actor.id, action: "correction.cancel", entity: "adjustment", entityId: id, ip });
    return { id, status: "CANCELLED" };
  });
}

export interface CorrectionView {
  id: string;
  item: { id: string; code: string; name: string; unit: string };
  state: string;
  expected: number;
  counted: number;
  delta: number;
  reason: string;
  fromCount: string | null;
  requestedBy: string;
  requestedById: string;
  status: string;
  decidedBy: string | null;
  decidedAt: Date | null;
  decisionNote: string | null;
  createdAt: Date;
}

export async function listCorrections(ctx: AppContext, actor: User, opts: { status?: string } = {}): Promise<CorrectionView[]> {
  if (!actor.is_active || !(can(actor.role, "incident.report") || can(actor.role, "reports.view"))) throw forbidden();
  const status = opts.status && ["PENDING", "APPROVED", "REJECTED", "CANCELLED"].includes(opts.status) ? opts.status : null;
  const rows = (await ctx.db.query<{
    id: string; item_id: string; code: string; name: string; unit: string; state: string; expected_qty: number; counted_qty: number; delta: number;
    reason: string; session_id: string | null; requested_by: string; requested_by_id: string; status: string; decided_by: string | null;
    decided_at: Date | null; decision_note: string | null; created_at: Date;
  }>(
    `SELECT a.id, a.item_id, it.code, it.name, it.unit, a.state, a.expected_qty, a.counted_qty, a.delta, a.reason, vl.session_id,
            coalesce(rq.name, rq.email) AS requested_by, a.requested_by AS requested_by_id, a.status, coalesce(dc.name, dc.email) AS decided_by,
            a.decided_at, a.decision_note, a.created_at
       FROM adjustments a JOIN items it ON it.id = a.item_id LEFT JOIN verification_lines vl ON vl.id = a.verification_line_id
       JOIN users rq ON rq.id = a.requested_by LEFT JOIN users dc ON dc.id = a.decided_by
      WHERE ($1::text IS NULL OR a.status = $1::text)
      ORDER BY (a.status = 'PENDING') DESC, a.created_at DESC LIMIT 300`,
    [status],
  )).rows;
  return rows.map((r) => ({
    id: r.id, item: { id: r.item_id, code: r.code, name: r.name, unit: r.unit }, state: r.state, expected: r.expected_qty, counted: r.counted_qty,
    delta: r.delta, reason: r.reason, fromCount: r.session_id, requestedBy: r.requested_by, requestedById: r.requested_by_id, status: r.status,
    decidedBy: r.decided_by, decidedAt: r.decided_at, decisionNote: r.decision_note, createdAt: r.created_at,
  }));
}
