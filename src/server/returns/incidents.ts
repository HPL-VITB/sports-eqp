/**
 * Damaged, missing and used-up equipment. Each incident holds a quantity; resolutions take units out of it:
 * - damaged (from a return or found in the store) -> marked usable again: Damaged -> Available (FR Sports / ASO)
 * - missing -> recovered: Missing -> Available or Damaged (store staff)
 * - discards (Phase 6) will resolve the rest.
 * No penalty or recovery cost is calculated anywhere.
 */
import { z } from "zod";
import { writeAudit } from "../audit";
import { can, requirePermission } from "../auth/permissions";
import type { User } from "../auth/users";
import type { AppContext } from "../context";
import { AppError, forbidden, notFound } from "../errors";
import { idempotent } from "../idempotency";
import { applyMovement, availableToIssue, lockStock } from "../inventory/ledger";
import { linkPhoto } from "../photos";

export const INCIDENT_TYPES = ["DAMAGED", "MISSING", "CONSUMED", "STORE_DAMAGE"] as const;
const optText = (max: number) => z.string().trim().max(max).optional().nullable().transform((v) => (v ? v : null));

export interface IncidentView {
  id: string;
  type: (typeof INCIDENT_TYPES)[number];
  item: { id: string; code: string; name: string; unit: string };
  issue: { id: string; ref: string } | null;
  recipient: { id: string; name: string | null; univId: string | null } | null;
  qty: number;
  qtyResolved: number;
  qtyOpen: number;
  qtyReserved: number;
  description: string | null;
  photoId: string | null;
  reportedBy: string;
  createdAt: Date;
  resolutions: { action: string; qty: number; remarks: string | null; by: string; at: Date }[];
}

const listSchema = z.object({
  status: z.enum(["open", "closed", "all"]).default("open"),
  type: z.enum(INCIDENT_TYPES).optional(),
  itemId: z.string().regex(/^\d+$/).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

export async function listIncidents(ctx: AppContext, actor: User, input: unknown): Promise<IncidentView[]> {
  if (!actor.is_active || !(can(actor.role, "incident.report") || can(actor.role, "reports.view"))) throw forbidden();
  const p = listSchema.safeParse(input ?? {});
  if (!p.success) throw new AppError(400, "VALIDATION", p.error.issues[0]?.message ?? "Invalid input.");
  const f = p.data;
  const rows = (await ctx.db.query<{
    id: string; type: IncidentView["type"]; item_id: string; code: string; name: string; unit: string; issue_id: string | null; issue_ref: string | null;
    recipient_id: string | null; recipient_name: string | null; recipient_univ_id: string | null; qty: number; qty_resolved: number; qty_reserved: number;
    description: string | null; photo_id: string | null; reported_by: string; created_at: Date;
  }>(
    `SELECT n.id, n.type, n.item_id, it.code, it.name, it.unit, n.issue_id, i.ref AS issue_ref, n.recipient_id, ru.name AS recipient_name,
            ru.univ_id AS recipient_univ_id, n.qty, n.qty_resolved, n.qty_reserved, n.description, n.photo_id, coalesce(rb.name, rb.email) AS reported_by, n.created_at
       FROM incidents n JOIN items it ON it.id = n.item_id LEFT JOIN issues i ON i.id = n.issue_id
       LEFT JOIN users ru ON ru.id = n.recipient_id JOIN users rb ON rb.id = n.reported_by
      WHERE ($1 = 'all' OR ($1 = 'open') = (n.qty_resolved < n.qty))
        AND ($2::text IS NULL OR n.type = $2::text) AND ($3::bigint IS NULL OR n.item_id = $3::bigint)
      ORDER BY n.created_at DESC LIMIT $4`,
    [f.status, f.type ?? null, f.itemId ?? null, f.limit],
  )).rows;
  const res = rows.length
    ? (await ctx.db.query<{ incident_id: string; action: string; qty: number; remarks: string | null; by: string; created_at: Date }>(
        `SELECT r.incident_id, r.action, r.qty, r.remarks, coalesce(u.name, u.email) AS by, r.created_at
           FROM incident_resolutions r JOIN users u ON u.id = r.resolved_by WHERE r.incident_id = ANY($1::bigint[]) ORDER BY r.id`,
        [rows.map((r) => r.id)],
      )).rows
    : [];
  return rows.map((r) => ({
    id: r.id, type: r.type, item: { id: r.item_id, code: r.code, name: r.name, unit: r.unit },
    issue: r.issue_id ? { id: r.issue_id, ref: r.issue_ref! } : null,
    recipient: r.recipient_id ? { id: r.recipient_id, name: r.recipient_name, univId: r.recipient_univ_id } : null,
    qty: r.qty, qtyResolved: r.qty_resolved, qtyOpen: r.qty - r.qty_resolved, qtyReserved: r.qty_reserved, description: r.description, photoId: r.photo_id,
    reportedBy: r.reported_by, createdAt: r.created_at,
    resolutions: res.filter((x) => String(x.incident_id) === String(r.id)).map((x) => ({ action: x.action, qty: x.qty, remarks: x.remarks, by: x.by, at: x.created_at })),
  }));
}

const storeDamageSchema = z.object({
  qty: z.number().int().min(1).max(100_000),
  description: z.string().trim().min(3, "Describe the damage briefly.").max(300),
  photoId: z.string().regex(/^\d+$/).optional().nullable(),
  idempotencyKey: z.string().optional(),
});

/** Damage found in the store (not linked to an issue): Available -> Damaged. */
export async function reportStoreDamage(ctx: AppContext, actor: User, itemId: string, input: unknown, ip: string | null) {
  requirePermission(actor, "incident.report");
  if (!/^\d+$/.test(itemId)) throw notFound("Item");
  const p = storeDamageSchema.safeParse(input);
  if (!p.success) throw new AppError(400, "VALIDATION", p.error.issues[0]?.message ?? "Invalid input.");
  const now = ctx.now();
  const { result } = await ctx.db.tx((q) =>
    idempotent(q, p.data.idempotencyKey, actor.id, `store.damage:${itemId}`, async () => {
      const locked = await lockStock(q, [itemId]);
      const st = locked.get(itemId)!;
      if (availableToIssue(st) < p.data.qty) {
        throw new AppError(409, "INSUFFICIENT_STOCK", `Only ${availableToIssue(st)} available in the store; issued units are recorded at return.`);
      }
      const photoId = await linkPhoto(q, p.data.photoId);
      const inc = (await q.query<{ id: string }>(
        `INSERT INTO incidents (type, item_id, qty, description, photo_id, reported_by, created_at)
         VALUES ('STORE_DAMAGE', $1, $2, $3, $4, $5, $6) RETURNING id`,
        [itemId, p.data.qty, p.data.description, photoId, actor.id, now],
      )).rows[0]!.id;
      const m = await applyMovement(q, locked, {
        itemId, type: "STORE_DAMAGE", qty: p.data.qty, from: "AVAILABLE", to: "DAMAGED", actorId: actor.id,
        source: { table: "incidents", id: inc }, remarks: p.data.description, now,
      });
      await writeAudit(q, { actorId: actor.id, action: "incident.store_damage", entity: "incident", entityId: inc, after: { itemId, qty: p.data.qty }, ip });
      return { incidentId: inc, availableAfter: m.after.available, damagedAfter: m.after.damaged };
    }),
  );
  return result;
}

const resolveSchema = z.object({
  action: z.enum(["MARKED_USABLE", "RECOVERED_USABLE", "RECOVERED_DAMAGED"]),
  qty: z.number().int().min(1).max(100_000),
  remarks: optText(300),
  idempotencyKey: z.string().optional(),
});

export async function resolveIncident(ctx: AppContext, actor: User, incidentId: string, input: unknown, ip: string | null) {
  if (!/^\d+$/.test(incidentId)) throw notFound("Incident");
  const p = resolveSchema.safeParse(input);
  if (!p.success) throw new AppError(400, "VALIDATION", p.error.issues[0]?.message ?? "Invalid input.");
  const { action, qty, remarks } = p.data;
  requirePermission(actor, action === "MARKED_USABLE" ? "damaged.markUsable" : "return.record");
  const now = ctx.now();

  const { result } = await ctx.db.tx((q) =>
    idempotent(q, p.data.idempotencyKey, actor.id, `incident.resolve:${incidentId}`, async () => {
      const inc = (await q.query<{ type: string; item_id: string; issue_id: string | null; recipient_id: string | null; qty: number; qty_resolved: number; qty_reserved: number }>(
        "SELECT type, item_id, issue_id, recipient_id, qty, qty_resolved, qty_reserved FROM incidents WHERE id = $1 FOR UPDATE",
        [incidentId],
      )).rows[0];
      if (!inc) throw notFound("Incident");
      const open = inc.qty - inc.qty_resolved;
      const free = open - inc.qty_reserved;
      if (open === 0) throw new AppError(409, "INCIDENT_CLOSED", "This incident is already fully resolved.");
      if (qty > free) {
        throw new AppError(400, "VALIDATION", inc.qty_reserved
          ? `Only ${free} unit(s) can be changed; ${inc.qty_reserved} are held by a pending discard request.`
          : `Only ${open} unit(s) are still open on this incident.`);
      }

      const isDamage = inc.type === "DAMAGED" || inc.type === "STORE_DAMAGE";
      if (action === "MARKED_USABLE" && !isDamage) throw new AppError(400, "VALIDATION", "Only damaged equipment can be marked usable.");
      if (action !== "MARKED_USABLE" && inc.type !== "MISSING") {
        throw new AppError(400, "VALIDATION", inc.type === "CONSUMED" ? "Used-up items are closed by an FR Sports discard." : "Only missing equipment can be recovered.");
      }

      const locked = await lockStock(q, [inc.item_id]);
      const source = { table: "incidents", id: incidentId };
      const m =
        action === "MARKED_USABLE"
          ? await applyMovement(q, locked, { itemId: inc.item_id, type: "MARK_USABLE", qty, from: "DAMAGED", to: "AVAILABLE", actorId: actor.id, source, remarks, now })
          : await applyMovement(q, locked, {
              itemId: inc.item_id, type: "RECOVERED", qty, from: "MISSING", to: action === "RECOVERED_USABLE" ? "AVAILABLE" : "DAMAGED",
              actorId: actor.id, source, remarks, now,
            });
      await q.query("UPDATE incidents SET qty_resolved = qty_resolved + $2 WHERE id = $1", [incidentId, qty]);
      await q.query(
        "INSERT INTO incident_resolutions (incident_id, action, qty, remarks, movement_id, resolved_by, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)",
        [incidentId, action, qty, remarks, m.movementId, actor.id, now],
      );
      // Recovered but damaged: those units now sit in Damaged, so they get their own damage incident to resolve later.
      let newIncidentId: string | null = null;
      if (action === "RECOVERED_DAMAGED") {
        newIncidentId = (await q.query<{ id: string }>(
          `INSERT INTO incidents (type, item_id, issue_id, recipient_id, qty, description, reported_by, created_at)
           VALUES ('DAMAGED', $1, $2, $3, $4, $5, $6, $7) RETURNING id`,
          [inc.item_id, inc.issue_id, inc.recipient_id, qty, `Recovered damaged (from incident #${incidentId})${remarks ? `: ${remarks}` : ""}`, actor.id, now],
        )).rows[0]!.id;
      }
      await writeAudit(q, { actorId: actor.id, action: `incident.${action.toLowerCase()}`, entity: "incident", entityId: incidentId, after: { qty, remarks, newIncidentId }, ip });
      return { incidentId, action, qty, open: open - qty, newIncidentId, stockAfter: m.after };
    }),
  );
  return result;
}
