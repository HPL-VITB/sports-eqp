/**
 * Durable email outbox.
 * - enqueue() is called INSIDE the business transaction, so an email exists if and only if the event committed.
 * - dispatch() runs after commit (and every 15 minutes from a scheduled job). Each row is claimed with
 *   FOR UPDATE SKIP LOCKED, so two workers never send the same email.
 * - Failures retry after 1, 5, 15, 60 and 240 minutes; after 6 attempts the row is FAILED and shown to FR Sports.
 * - Email trouble never undoes or blocks an inventory transaction.
 */
import { writeAudit } from "../audit";
import { requirePermission } from "../auth/permissions";
import type { User } from "../auth/users";
import type { AppContext } from "../context";
import type { Queryable } from "../db/types";
import { AppError, notFound } from "../errors";

export const MAX_ATTEMPTS = 6;
const BACKOFF_MIN = [1, 5, 15, 60, 240];
export const DAILY_SEND_CEILING = 1500; // below Google Workspace's per-account limit, leaving room for sign-in codes
const STUCK_AFTER_MS = 10 * 60_000;

export interface NewNotification {
  dedupeKey: string;
  kind: string;
  to: string;
  subject: string;
  text: string;
  html?: string;
  entity?: string;
  entityId?: string;
}

/** Returns the new row id, or null if this exact email was already queued (same dedupe key). */
export async function enqueue(q: Queryable, n: NewNotification, now: Date): Promise<string | null> {
  const res = await q.query<{ id: string }>(
    `INSERT INTO notifications (dedupe_key, kind, to_email, subject, text_body, html_body, entity, entity_id, next_attempt_at, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)
     ON CONFLICT (dedupe_key) DO NOTHING RETURNING id`,
    [n.dedupeKey, n.kind, n.to, n.subject, n.text, n.html ?? null, n.entity ?? null, n.entityId ?? null, now],
  );
  return res.rows[0]?.id ?? null;
}

interface Row {
  id: string;
  to_email: string;
  subject: string;
  text_body: string;
  html_body: string | null;
  attempts: number;
}

export interface DispatchReport {
  sent: number;
  failed: number;
  retrying: number;
  deferred: boolean;
}

/** Sends due emails. `onlyIds` limits it to just-queued rows (used right after a transaction commits). */
export async function dispatch(ctx: AppContext, opts: { onlyIds?: string[]; limit?: number } = {}): Promise<DispatchReport> {
  const report: DispatchReport = { sent: 0, failed: 0, retrying: 0, deferred: false };
  const now = ctx.now();
  // Recover rows left in SENDING by a worker that crashed mid-send (may cause one duplicate in that rare case).
  await ctx.db.query(
    "UPDATE notifications SET status = 'QUEUED' WHERE status = 'SENDING' AND claimed_at < $1",
    [new Date(now.getTime() - STUCK_AFTER_MS)],
  );
  const sentToday = Number(
    (await ctx.db.query<{ n: string }>("SELECT count(*) AS n FROM notifications WHERE sent_at > $1", [new Date(now.getTime() - 86_400_000)]))
      .rows[0]!.n,
  );
  let budget = Math.min(opts.limit ?? 50, DAILY_SEND_CEILING - sentToday);
  if (budget <= 0) return { ...report, deferred: true };

  while (budget-- > 0) {
    const claimed = await ctx.db.query<Row>(
      `UPDATE notifications SET status = 'SENDING', attempts = attempts + 1, claimed_at = $1
        WHERE id = (
          SELECT id FROM notifications
           WHERE status = 'QUEUED' AND next_attempt_at <= $1 AND ($2::bigint[] IS NULL OR id = ANY($2::bigint[]))
           ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1)
        RETURNING id, to_email, subject, text_body, html_body, attempts`,
      [now, opts.onlyIds ?? null],
    );
    const row = claimed.rows[0];
    if (!row) break;
    try {
      const { messageId } = await ctx.mailer.send({ to: row.to_email, subject: row.subject, text: row.text_body, html: row.html_body ?? undefined });
      await ctx.db.query(
        "UPDATE notifications SET status = 'SENT', sent_at = $2, provider_id = $3, last_error = NULL WHERE id = $1",
        [row.id, ctx.now(), messageId],
      );
      report.sent++;
    } catch (err) {
      const message = (err instanceof Error ? err.message : String(err)).slice(0, 500);
      if (row.attempts >= MAX_ATTEMPTS) {
        await ctx.db.query("UPDATE notifications SET status = 'FAILED', last_error = $2 WHERE id = $1", [row.id, message]);
        report.failed++;
        console.error(`Email ${row.id} to ${row.to_email} failed permanently: ${message}`);
      } else {
        const wait = BACKOFF_MIN[Math.min(row.attempts - 1, BACKOFF_MIN.length - 1)]! * 60_000;
        await ctx.db.query(
          "UPDATE notifications SET status = 'QUEUED', last_error = $2, next_attempt_at = $3 WHERE id = $1",
          [row.id, message, new Date(ctx.now().getTime() + wait)],
        );
        report.retrying++;
      }
    }
  }
  return report;
}

/** Called right after a transaction that queued emails. Never throws; slow mail servers cannot hold the user for long. */
export async function dispatchSoon(ctx: AppContext, ids: (string | null)[], timeoutMs = 8000): Promise<void> {
  const onlyIds = ids.filter((x): x is string => x !== null);
  if (!onlyIds.length) return;
  await Promise.race([
    dispatch(ctx, { onlyIds }).catch((err) => console.error("Email dispatch failed", err)),
    new Promise((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
}

export interface NotificationView {
  id: string;
  kind: string;
  to: string;
  subject: string;
  status: string;
  attempts: number;
  lastError: string | null;
  createdAt: Date;
  sentAt: Date | null;
  nextAttemptAt: Date;
  entity: string | null;
  entityId: string | null;
}

export async function listNotifications(ctx: AppContext, actor: User, opts: { status?: string; limit?: number } = {}): Promise<NotificationView[]> {
  requirePermission(actor, "users.manage");
  const status = opts.status && ["QUEUED", "SENDING", "SENT", "FAILED"].includes(opts.status) ? opts.status : null;
  const res = await ctx.db.query<{
    id: string; kind: string; to_email: string; subject: string; status: string; attempts: number; last_error: string | null;
    created_at: Date; sent_at: Date | null; next_attempt_at: Date; entity: string | null; entity_id: string | null;
  }>(
    `SELECT id, kind, to_email, subject, status, attempts, last_error, created_at, sent_at, next_attempt_at, entity, entity_id
       FROM notifications WHERE ($1::text IS NULL OR status = $1::text)
      ORDER BY (status = 'FAILED') DESC, id DESC LIMIT $2`,
    [status, Math.min(Math.max(opts.limit ?? 100, 1), 500)],
  );
  return res.rows.map((r) => ({
    id: r.id, kind: r.kind, to: r.to_email, subject: r.subject, status: r.status, attempts: r.attempts, lastError: r.last_error,
    createdAt: r.created_at, sentAt: r.sent_at, nextAttemptAt: r.next_attempt_at, entity: r.entity, entityId: r.entity_id,
  }));
}

export async function notificationCounts(q: Queryable) {
  const res = await q.query<{ status: string; n: string }>("SELECT status, count(*) AS n FROM notifications GROUP BY status");
  const out: Record<string, number> = { QUEUED: 0, SENDING: 0, SENT: 0, FAILED: 0 };
  for (const r of res.rows) out[r.status] = Number(r.n);
  return out;
}

/** FR Sports re-queues a failed (or waiting) email and it is sent at once. */
export async function resendNotification(ctx: AppContext, actor: User, id: string, ip: string | null) {
  requirePermission(actor, "users.manage");
  if (!/^\d+$/.test(id)) throw notFound("Email");
  const res = await ctx.db.tx(async (q) => {
    const r = await q.query<{ status: string; to_email: string }>(
      `UPDATE notifications SET status = 'QUEUED', attempts = 0, next_attempt_at = $2, last_error = NULL
        WHERE id = $1 AND status IN ('FAILED', 'QUEUED') RETURNING status, to_email`,
      [id, ctx.now()],
    );
    if (!r.rows[0]) {
      const exists = await q.query("SELECT 1 FROM notifications WHERE id = $1", [id]);
      if (!exists.rowCount) throw notFound("Email");
      throw new AppError(409, "ALREADY_SENT", "This email has already been sent.");
    }
    await writeAudit(q, { actorId: actor.id, action: "email.resend", entity: "notification", entityId: id, ip });
    return r.rows[0];
  });
  await dispatch(ctx, { onlyIds: [id] });
  const after = await ctx.db.query<{ status: string; last_error: string | null }>("SELECT status, last_error FROM notifications WHERE id = $1", [id]);
  return { id, to: res.to_email, status: after.rows[0]!.status, lastError: after.rows[0]!.last_error };
}
