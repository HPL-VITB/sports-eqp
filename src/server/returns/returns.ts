/**
 * Full-return reconciliation. One transaction: every issued unit is recorded as usable, damaged, missing or
 * (consumable items only) used up; stock moves out of Issued accordingly; incidents are opened for anything not
 * usable; the issue closes; return emails are queued. Nothing is recorded unless every unit is accounted for.
 */
import { z } from "zod";
import { writeAudit } from "../audit";
import { requirePermission } from "../auth/permissions";
import type { User } from "../auth/users";
import type { AppContext } from "../context";
import type { Queryable } from "../db/types";
import { AppError, notFound } from "../errors";
import { idempotent } from "../idempotency";
import { applyMovement, lockStock } from "../inventory/ledger";
import { dispatchSoon, enqueue } from "../notify/outbox";
import { returnEmail } from "../notify/templates";
import { linkPhoto } from "../photos";
import { daysBetween, todayIST } from "../time";

const idStr = z.string().regex(/^\d+$/);
const n = z.number().int("Quantities must be whole numbers.").min(0).max(1000);
const optText = (max: number) => z.string().trim().max(max).optional().nullable().transform((v) => (v ? v : null));

export interface IssueLineView {
  itemId: string;
  code: string;
  name: string;
  unit: string;
  isConsumable: boolean;
  qty: number;
  returned: { usable: number; damaged: number; missing: number; consumed: number; note: string | null } | null;
}

export interface IssueView {
  id: string;
  ref: string;
  requestId: string;
  requestRef: string;
  status: string;
  recipient: { id: string; name: string | null; email: string; univId: string | null };
  groupName: string | null;
  purpose: string;
  issuedAt: Date;
  dueDate: string;
  issuedBy: string;
  approvedBy: string;
  overdue: boolean;
  daysOverdue: number;
  returnedAt: Date | null;
  receivedBy: string | null;
  returnRemarks: string | null;
  returnPhotoId: string | null;
  lines: IssueLineView[];
}

async function loadIssue(q: Queryable, issueId: string, now: Date): Promise<IssueView | null> {
  const r = (await q.query<{
    id: string; ref: string; request_id: string; request_ref: string; status: string; recipient_id: string; recipient_name: string | null;
    recipient_email: string; recipient_univ_id: string | null; group_name: string | null; purpose: string; issued_at: Date; due_date: string;
    issued_by: string; approved_by: string; returned_at: Date | null; received_by: string | null; return_remarks: string | null; return_photo_id: string | null;
  }>(
    `SELECT i.id, i.ref, i.request_id, r.ref AS request_ref, i.status, i.recipient_id, ru.name AS recipient_name, ru.email AS recipient_email,
            ru.univ_id AS recipient_univ_id, r.group_name, r.purpose, i.issued_at, i.due_date::text AS due_date,
            coalesce(ib.name, ib.email) AS issued_by, coalesce(ab.name, ab.email) AS approved_by, i.returned_at,
            coalesce(rb.name, rb.email) AS received_by, i.return_remarks, i.return_photo_id
       FROM issues i JOIN requests r ON r.id = i.request_id JOIN users ru ON ru.id = i.recipient_id
       JOIN users ib ON ib.id = i.issued_by JOIN users ab ON ab.id = i.approved_by LEFT JOIN users rb ON rb.id = i.received_by
      WHERE i.id = $1`,
    [issueId],
  )).rows[0];
  if (!r) return null;
  const lines = (await q.query<{
    item_id: string; code: string; name: string; unit: string; is_consumable: boolean; qty: number;
    qty_usable: number | null; qty_damaged: number | null; qty_missing: number | null; qty_consumed: number | null; note: string | null;
  }>(
    `SELECT l.item_id, it.code, it.name, it.unit, it.is_consumable, l.qty,
            rl.qty_usable, rl.qty_damaged, rl.qty_missing, rl.qty_consumed, rl.note
       FROM issue_lines l JOIN items it ON it.id = l.item_id
       LEFT JOIN return_lines rl ON rl.issue_id = l.issue_id AND rl.item_id = l.item_id
      WHERE l.issue_id = $1 ORDER BY l.id`,
    [issueId],
  )).rows;
  const today = todayIST(now);
  const overdue = r.status === "ISSUED" && r.due_date < today;
  return {
    id: r.id, ref: r.ref, requestId: r.request_id, requestRef: r.request_ref, status: r.status,
    recipient: { id: r.recipient_id, name: r.recipient_name, email: r.recipient_email, univId: r.recipient_univ_id },
    groupName: r.group_name, purpose: r.purpose, issuedAt: r.issued_at, dueDate: r.due_date, issuedBy: r.issued_by, approvedBy: r.approved_by,
    overdue, daysOverdue: overdue ? daysBetween(r.due_date, today) : 0,
    returnedAt: r.returned_at, receivedBy: r.received_by, returnRemarks: r.return_remarks, returnPhotoId: r.return_photo_id,
    lines: lines.map((l) => ({
      itemId: l.item_id, code: l.code, name: l.name, unit: l.unit, isConsumable: l.is_consumable, qty: l.qty,
      returned: l.qty_usable === null ? null : { usable: l.qty_usable, damaged: l.qty_damaged!, missing: l.qty_missing!, consumed: l.qty_consumed!, note: l.note },
    })),
  };
}

export async function getIssue(ctx: AppContext, actor: User, issueId: string): Promise<IssueView> {
  requirePermission(actor, "return.record");
  if (!/^\d+$/.test(issueId)) throw notFound("Issue");
  const v = await loadIssue(ctx.db, issueId, ctx.now());
  if (!v) throw notFound("Issue");
  return v;
}

const returnSchema = z.object({
  lines: z.array(z.object({ itemId: idStr, usable: n, damaged: n, missing: n, consumed: n.default(0), note: optText(300) })).min(1),
  remarks: optText(500),
  photoId: idStr.optional().nullable(),
  idempotencyKey: z.string().optional(),
});

export interface ReturnResult {
  issueId: string;
  issueRef: string;
  returnedAt: string;
  totals: { usable: number; damaged: number; missing: number; consumed: number };
  incidentIds: string[];
  emailIds: (string | null)[];
}

export async function recordReturn(ctx: AppContext, actor: User, issueId: string, input: unknown, ip: string | null): Promise<ReturnResult & { replayed: boolean }> {
  requirePermission(actor, "return.record");
  if (!/^\d+$/.test(issueId)) throw notFound("Issue");
  const p = returnSchema.safeParse(input);
  if (!p.success) {
    throw new AppError(400, "VALIDATION", p.error.issues[0]?.message ?? "Invalid input.");
  }
  const d = p.data;
  const now = ctx.now();

  const { result, replayed } = await ctx.db.tx((q) =>
    idempotent(q, d.idempotencyKey, actor.id, `issue.return:${issueId}`, async (): Promise<ReturnResult> => {
      // 1. Lock the issue: a second simultaneous return waits here, then finds it RETURNED and stops.
      const head = (await q.query<{ status: string; returned_at: Date | null; received_by: string | null; recipient_id: string; request_id: string }>(
        `SELECT i.status, i.returned_at, coalesce(u.name, u.email) AS received_by, i.recipient_id, i.request_id
           FROM issues i LEFT JOIN users u ON u.id = i.received_by WHERE i.id = $1 FOR UPDATE OF i`,
        [issueId],
      )).rows[0];
      if (!head) throw notFound("Issue");
      if (head.status === "RETURNED") {
        throw new AppError(409, "ALREADY_RETURNED", `This issue was already returned (received by ${head.received_by}). Refresh the page.`);
      }

      // 2. Every issued line must be accounted for exactly; no extra lines.
      const issue = (await loadIssue(q, issueId, now))!;
      const given = new Map<string, (typeof d.lines)[number]>();
      for (const l of d.lines) {
        if (given.has(l.itemId)) throw new AppError(400, "VALIDATION", "Each item may appear once.");
        given.set(l.itemId, l);
      }
      const problems: string[] = [];
      for (const il of issue.lines) {
        const g = given.get(il.itemId);
        if (!g) {
          problems.push(`${il.name}: not recorded.`);
          continue;
        }
        const sum = g.usable + g.damaged + g.missing + g.consumed;
        if (sum !== il.qty) problems.push(`${il.name}: ${il.qty} issued but ${sum} recorded.`);
        if (g.consumed > 0 && !il.isConsumable) problems.push(`${il.name} is not a consumable item; it cannot be recorded as used up.`);
        if ((g.missing > 0 || g.consumed > 0) && !g.note) problems.push(`${il.name}: say briefly what happened to the missing or used-up units.`);
      }
      for (const itemId of given.keys()) {
        if (!issue.lines.some((il) => il.itemId === itemId)) problems.push("A line does not belong to this issue.");
      }
      if (problems.length) throw new AppError(400, "RETURN_INCOMPLETE", `Nothing was recorded. ${problems.join(" ")}`, { problems });

      const photoId = await linkPhoto(q, d.photoId);

      // 3. Move stock out of Issued, line by line, and open incidents for anything not usable.
      const locked = await lockStock(q, issue.lines.map((l) => l.itemId));
      const source = { table: "issues", id: issueId };
      const totals = { usable: 0, damaged: 0, missing: 0, consumed: 0 };
      const incidentIds: string[] = [];
      for (const il of issue.lines) {
        const g = given.get(il.itemId)!;
        const move = async (qty: number, type: "RETURN_USABLE" | "RETURN_DAMAGED" | "RETURN_MISSING", to: "AVAILABLE" | "DAMAGED" | "MISSING", remarks: string) => {
          if (qty > 0) await applyMovement(q, locked, { itemId: il.itemId, type, qty, from: "ISSUED", to, actorId: actor.id, source, remarks, now });
        };
        await move(g.usable, "RETURN_USABLE", "AVAILABLE", issue.ref);
        await move(g.damaged, "RETURN_DAMAGED", "DAMAGED", issue.ref);
        await move(g.missing + g.consumed, "RETURN_MISSING", "MISSING", g.consumed ? `${issue.ref}: ${g.consumed} used up` : issue.ref);
        await q.query(
          `INSERT INTO return_lines (issue_id, item_id, qty_usable, qty_damaged, qty_missing, qty_consumed, note) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [issueId, il.itemId, g.usable, g.damaged, g.missing, g.consumed, g.note],
        );
        for (const [type, qty] of [["DAMAGED", g.damaged], ["MISSING", g.missing], ["CONSUMED", g.consumed]] as const) {
          if (qty === 0) continue;
          const inc = await q.query<{ id: string }>(
            `INSERT INTO incidents (type, item_id, issue_id, recipient_id, qty, description, photo_id, reported_by, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
            [type, il.itemId, issueId, head.recipient_id, qty, g.note ?? d.remarks, type === "DAMAGED" ? photoId : null, actor.id, now],
          );
          incidentIds.push(inc.rows[0]!.id);
          if (type === "CONSUMED") {
            // Used-up units go straight to FR Sports as a discard request, holding them until decided.
            await q.query(
              `INSERT INTO discard_requests (item_id, from_state, incident_id, qty, reason, details, auto, created_at)
               VALUES ($1, 'MISSING', $2, $3, 'CONSUMED', $4, true, $5)`,
              [il.itemId, inc.rows[0]!.id, qty, `${issue.ref}: ${g.note}`, now],
            );
            await q.query("UPDATE incidents SET qty_reserved = qty WHERE id = $1", [inc.rows[0]!.id]);
          }
        }
        totals.usable += g.usable;
        totals.damaged += g.damaged;
        totals.missing += g.missing;
        totals.consumed += g.consumed;
      }

      // 4. Close the issue and the request.
      await q.query(
        `UPDATE issues SET status = 'RETURNED', returned_at = $2, received_by = $3, return_remarks = $4, return_photo_id = $5
          WHERE id = $1 AND status = 'ISSUED'`,
        [issueId, now, actor.id, d.remarks, photoId],
      );
      await q.query("UPDATE requests SET status = 'RETURNED' WHERE id = $1 AND status = 'ISSUED'", [head.request_id]);
      await writeAudit(q, {
        actorId: actor.id, action: "issue.return", entity: "issue", entityId: issueId,
        after: { ref: issue.ref, totals, lines: d.lines, remarks: d.remarks, incidentIds }, ip,
      });

      // 5. Emails to the recipient and the issuing staff member.
      const issuer = (await q.query<{ email: string; name: string | null }>("SELECT u.email, u.name FROM issues i JOIN users u ON u.id = i.issued_by WHERE i.id = $1", [issueId])).rows[0]!;
      const data = {
        ref: issue.ref, recipientName: issue.recipient.name ?? issue.recipient.email, groupName: issue.groupName, issuedAt: issue.issuedAt,
        returnedAt: now, dueDate: issue.dueDate, issuedByName: issue.issuedBy, receivedByName: actor.name ?? actor.email, appOrigin: ctx.config.APP_ORIGIN,
        lines: issue.lines.map((il) => {
          const g = given.get(il.itemId)!;
          return { code: il.code, name: il.name, unit: il.unit, usable: g.usable, damaged: g.damaged, missing: g.missing, consumed: g.consumed };
        }),
      };
      const emailIds = [
        await enqueue(q, { dedupeKey: `return:${issueId}:recipient`, kind: "return.recipient", to: issue.recipient.email, ...returnEmail(data, "recipient"), entity: "issue", entityId: issueId }, now),
      ];
      if (issuer.email !== issue.recipient.email) {
        emailIds.push(await enqueue(q, { dedupeKey: `return:${issueId}:issuer`, kind: "return.issuer", to: issuer.email, ...returnEmail(data, "issuer"), entity: "issue", entityId: issueId }, now));
      }
      return { issueId, issueRef: issue.ref, returnedAt: now.toISOString(), totals, incidentIds, emailIds };
    }),
  );
  if (!replayed) await dispatchSoon(ctx, result.emailIds);
  return { ...result, replayed };
}
