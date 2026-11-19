/**
 * Discards. Store staff (ASO / storekeeper) request; FR Sports approves or rejects. A pending request holds its units
 * (reserved) so they cannot be issued, marked usable or recovered meanwhile. Issued units can never be discarded:
 * they must first be returned or recorded missing. Item records and history are never deleted.
 */
import { z } from "zod";
import { writeAudit } from "../audit";
import { can, requirePermission } from "../auth/permissions";
import type { User } from "../auth/users";
import type { AppContext } from "../context";
import type { Queryable } from "../db/types";
import { AppError, forbidden, notFound } from "../errors";
import { idempotent } from "../idempotency";
import { applyMovement, availableToIssue, lockStock, type LockedStock } from "../inventory/ledger";

export const DISCARD_REASONS = ["BROKEN", "WORN_OUT", "OBSOLETE", "BEYOND_USE", "LOST", "CONSUMED", "OTHER"] as const;
export const DISCARD_REASON_LABELS: Record<(typeof DISCARD_REASONS)[number], string> = {
  BROKEN: "Broken",
  WORN_OUT: "Worn out",
  OBSOLETE: "Obsolete",
  BEYOND_USE: "Beyond usable condition",
  LOST: "Lost",
  CONSUMED: "Used up",
  OTHER: "Other",
};
const optText = (max: number) => z.string().trim().max(max).optional().nullable().transform((v) => (v ? v : null));

/** Changes item_stock.reserved (units of Available held by pending discards) inside a locked transaction. */
export async function changeReserved(q: Queryable, locked: LockedStock, itemId: string, delta: number) {
  const row = locked.get(itemId)!;
  const next = row.reserved + delta;
  if (next < 0 || next > row.available) throw new AppError(409, "RESERVATION", "Stock changed; refresh and try again.");
  await q.query("UPDATE item_stock SET reserved = $2 WHERE item_id = $1", [itemId, next]);
  locked.set(itemId, { ...row, reserved: next });
}

const requestSchema = z.object({
  itemId: z.string().regex(/^\d+$/),
  fromState: z.enum(["AVAILABLE", "DAMAGED", "MISSING", "ISSUED"]).optional(),
  incidentId: z.string().regex(/^\d+$/).optional().nullable(),
  qty: z.number().int().min(1).max(100_000),
  reason: z.enum(DISCARD_REASONS),
  details: optText(300),
  idempotencyKey: z.string().optional(),
});

export async function requestDiscard(ctx: AppContext, actor: User, input: unknown, ip: string | null) {
  requirePermission(actor, "discard.request");
  const p = requestSchema.safeParse(input);
  if (!p.success) throw new AppError(400, "VALIDATION", p.error.issues[0]?.message ?? "Invalid input.");
  const d = p.data;
  if (d.fromState === "ISSUED") {
    throw new AppError(409, "ITEM_ISSUED", "Issued equipment cannot be discarded. Record its return (or mark it missing) first.");
  }
  if (d.reason === "OTHER" && !d.details) throw new AppError(400, "VALIDATION", "Describe the reason.");
  const now = ctx.now();
  const { result } = await ctx.db.tx((q) =>
    idempotent(q, d.idempotencyKey, actor.id, "discard.request", async () => {
      const item = (await q.query<{ is_active: boolean }>("SELECT is_active FROM items WHERE id = $1", [d.itemId])).rows[0];
      if (!item) throw notFound("Item");
      let fromState: "AVAILABLE" | "DAMAGED" | "MISSING" = "AVAILABLE";
      if (d.incidentId) {
        const inc = (await q.query<{ item_id: string; type: string; qty: number; qty_resolved: number; qty_reserved: number }>(
          "SELECT item_id, type, qty, qty_resolved, qty_reserved FROM incidents WHERE id = $1 FOR UPDATE",
          [d.incidentId],
        )).rows[0];
        if (!inc || String(inc.item_id) !== d.itemId) throw notFound("Incident");
        if (inc.type === "CONSUMED") throw new AppError(409, "ALREADY_REQUESTED", "Used-up units already have a discard request waiting for FR Sports.");
        fromState = inc.type === "MISSING" ? "MISSING" : "DAMAGED";
        const free = inc.qty - inc.qty_resolved - inc.qty_reserved;
        if (d.qty > free) throw new AppError(409, "INSUFFICIENT_STOCK", `Only ${free} unit(s) of this record can still be discarded.`);
        await q.query("UPDATE incidents SET qty_reserved = qty_reserved + $2 WHERE id = $1", [d.incidentId, d.qty]);
      } else {
        if (d.fromState && d.fromState !== "AVAILABLE") {
          throw new AppError(400, "VALIDATION", "To discard damaged or missing units, choose the damage or missing record.");
        }
        const locked = await lockStock(q, [d.itemId]);
        const free = availableToIssue(locked.get(d.itemId)!);
        if (d.qty > free) throw new AppError(409, "INSUFFICIENT_STOCK", `Only ${free} unit(s) are in the store and not already held.`);
        await changeReserved(q, locked, d.itemId, d.qty);
      }
      const id = (await q.query<{ id: string }>(
        `INSERT INTO discard_requests (item_id, from_state, incident_id, qty, reason, details, requested_by, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [d.itemId, fromState, d.incidentId ?? null, d.qty, d.reason, d.details, actor.id, now],
      )).rows[0]!.id;
      await writeAudit(q, { actorId: actor.id, action: "discard.request", entity: "discard_request", entityId: id, after: { itemId: d.itemId, fromState, qty: d.qty, reason: d.reason }, ip });
      return { id, fromState };
    }),
  );
  return result;
}

async function lockPendingDiscard(q: Queryable, id: string) {
  const r = (await q.query<{ item_id: string; from_state: "AVAILABLE" | "DAMAGED" | "MISSING"; incident_id: string | null; qty: number; status: string; requested_by: string | null; reason: string; auto: boolean }>(
    "SELECT item_id, from_state, incident_id, qty, status, requested_by, reason, auto FROM discard_requests WHERE id = $1 FOR UPDATE",
    [id],
  )).rows[0];
  if (!r) throw notFound("Discard request");
  if (r.status !== "PENDING") throw new AppError(409, "ALREADY_PROCESSED", `This discard request was already ${r.status.toLowerCase()}.`);
  return r;
}

async function release(q: Queryable, r: { item_id: string; incident_id: string | null; qty: number }) {
  if (r.incident_id) {
    await q.query("UPDATE incidents SET qty_reserved = qty_reserved - $2 WHERE id = $1", [r.incident_id, r.qty]);
  } else {
    const locked = await lockStock(q, [String(r.item_id)]);
    await changeReserved(q, locked, String(r.item_id), -r.qty);
  }
}

const decideSchema = z.object({ decision: z.enum(["APPROVE", "REJECT"]), note: optText(300) });

export async function decideDiscard(ctx: AppContext, actor: User, id: string, input: unknown, ip: string | null) {
  requirePermission(actor, "discard.approve");
  if (!/^\d+$/.test(id)) throw notFound("Discard request");
  const p = decideSchema.safeParse(input);
  if (!p.success) throw new AppError(400, "VALIDATION", p.error.issues[0]?.message ?? "Invalid input.");
  if (p.data.decision === "REJECT" && !p.data.note) throw new AppError(400, "VALIDATION", "Give a short reason for rejecting.");
  const now = ctx.now();
  return ctx.db.tx(async (q) => {
    const r = await lockPendingDiscard(q, id);
    if (r.requested_by !== null && String(r.requested_by) === String(actor.id)) {
      throw new AppError(403, "SELF_DECISION", "You cannot approve your own discard request.");
    }
    if (p.data.decision === "REJECT") {
      await release(q, r);
      await q.query("UPDATE discard_requests SET status = 'REJECTED', decided_by = $2, decided_at = $3, decision_note = $4 WHERE id = $1", [id, actor.id, now, p.data.note]);
      await writeAudit(q, { actorId: actor.id, action: "discard.reject", entity: "discard_request", entityId: id, after: { note: p.data.note }, ip });
      return { id, status: "REJECTED" };
    }
    const itemId = String(r.item_id);
    const locked = await lockStock(q, [itemId]);
    if (r.incident_id) {
      await q.query("UPDATE incidents SET qty_reserved = qty_reserved - $2, qty_resolved = qty_resolved + $2 WHERE id = $1", [r.incident_id, r.qty]);
    } else {
      await changeReserved(q, locked, itemId, -r.qty);
    }
    const m = await applyMovement(q, locked, {
      itemId, type: "DISCARD", qty: r.qty, from: r.from_state, to: "DISCARDED", actorId: actor.id, approvedBy: actor.id,
      source: { table: "discard_requests", id }, remarks: p.data.note ?? r.reason, now,
    });
    if (r.incident_id) {
      await q.query(
        "INSERT INTO incident_resolutions (incident_id, action, qty, remarks, movement_id, resolved_by, created_at) VALUES ($1,'DISCARDED',$2,$3,$4,$5,$6)",
        [r.incident_id, r.qty, p.data.note, m.movementId, actor.id, now],
      );
    }
    const done = await q.query(
      "UPDATE discard_requests SET status = 'APPROVED', decided_by = $2, decided_at = $3, decision_note = $4, movement_id = $5 WHERE id = $1 AND status = 'PENDING'",
      [id, actor.id, now, p.data.note, m.movementId],
    );
    if (!done.rowCount) throw new AppError(409, "ALREADY_PROCESSED", "This discard request was already decided.");
    await writeAudit(q, { actorId: actor.id, action: "discard.approve", entity: "discard_request", entityId: id, before: m.before, after: m.after, ip });
    return { id, status: "APPROVED", stockAfter: m.after };
  });
}

export async function cancelDiscard(ctx: AppContext, actor: User, id: string, ip: string | null) {
  if (!/^\d+$/.test(id)) throw notFound("Discard request");
  return ctx.db.tx(async (q) => {
    const r = await lockPendingDiscard(q, id);
    if (r.auto || String(r.requested_by) !== String(actor.id)) throw forbidden("Only the person who asked can cancel this request.");
    await release(q, r);
    await q.query("UPDATE discard_requests SET status = 'CANCELLED', decided_at = $2 WHERE id = $1", [id, ctx.now()]);
    await writeAudit(q, { actorId: actor.id, action: "discard.cancel", entity: "discard_request", entityId: id, ip });
    return { id, status: "CANCELLED" };
  });
}

export interface DiscardView {
  id: string;
  item: { id: string; code: string; name: string; unit: string };
  fromState: string;
  incidentId: string | null;
  issueRef: string | null;
  qty: number;
  reason: string;
  details: string | null;
  auto: boolean;
  requestedBy: string | null;
  requestedById: string | null;
  status: string;
  decidedBy: string | null;
  decidedAt: Date | null;
  decisionNote: string | null;
  createdAt: Date;
}

export async function listDiscards(ctx: AppContext, actor: User, opts: { status?: string } = {}): Promise<DiscardView[]> {
  if (!actor.is_active || !(can(actor.role, "incident.report") || can(actor.role, "reports.view"))) throw forbidden();
  const status = opts.status && ["PENDING", "APPROVED", "REJECTED", "CANCELLED"].includes(opts.status) ? opts.status : null;
  const rows = (await ctx.db.query<{
    id: string; item_id: string; code: string; name: string; unit: string; from_state: string; incident_id: string | null; issue_ref: string | null;
    qty: number; reason: string; details: string | null; auto: boolean; requested_by: string | null; requested_by_id: string | null; status: string;
    decided_by: string | null; decided_at: Date | null; decision_note: string | null; created_at: Date;
  }>(
    `SELECT d.id, d.item_id, it.code, it.name, it.unit, d.from_state, d.incident_id, i.ref AS issue_ref, d.qty, d.reason, d.details, d.auto,
            coalesce(rq.name, rq.email) AS requested_by, d.requested_by AS requested_by_id, d.status, coalesce(dc.name, dc.email) AS decided_by,
            d.decided_at, d.decision_note, d.created_at
       FROM discard_requests d JOIN items it ON it.id = d.item_id LEFT JOIN incidents n ON n.id = d.incident_id LEFT JOIN issues i ON i.id = n.issue_id
       LEFT JOIN users rq ON rq.id = d.requested_by LEFT JOIN users dc ON dc.id = d.decided_by
      WHERE ($1::text IS NULL OR d.status = $1::text)
      ORDER BY (d.status = 'PENDING') DESC, d.created_at DESC LIMIT 300`,
    [status],
  )).rows;
  return rows.map((r) => ({
    id: r.id, item: { id: r.item_id, code: r.code, name: r.name, unit: r.unit }, fromState: r.from_state, incidentId: r.incident_id, issueRef: r.issue_ref,
    qty: r.qty, reason: r.reason, details: r.details, auto: r.auto, requestedBy: r.requested_by, requestedById: r.requested_by_id, status: r.status,
    decidedBy: r.decided_by, decidedAt: r.decided_at, decisionNote: r.decision_note, createdAt: r.created_at,
  }));
}
