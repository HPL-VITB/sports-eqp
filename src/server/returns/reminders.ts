/**
 * Automatic overdue reminders (daily job). Overdue status itself is always computed live; this only sends emails.
 * Schedule (configurable by FR Sports): first reminder `firstAfterDays` after the due date, then every `everyDays`,
 * at most `max` reminders. The last one is copied to the issuing staff member. A missed day is caught up with the
 * reminder that is due now (no burst of old ones); re-running the job the same day sends nothing extra.
 */
import { z } from "zod";
import { writeAudit } from "../audit";
import { requirePermission } from "../auth/permissions";
import type { User } from "../auth/users";
import type { AppContext } from "../context";
import type { Queryable } from "../db/types";
import { AppError } from "../errors";
import { dispatch, enqueue } from "../notify/outbox";
import { overdueEmail } from "../notify/templates";
import { daysBetween, todayIST } from "../time";

export const reminderSettingsSchema = z
  .object({
    firstAfterDays: z.number().int().min(0).max(30),
    everyDays: z.number().int().min(1).max(30),
    max: z.number().int().min(0, "Use 0 to turn reminders off.").max(10),
  })
  .strict();
export type ReminderSettings = z.infer<typeof reminderSettingsSchema>;
const DEFAULTS: ReminderSettings = { firstAfterDays: 1, everyDays: 3, max: 4 };

export async function getReminderSettings(q: Queryable): Promise<ReminderSettings> {
  const r = (await q.query<{ value: unknown }>("SELECT value FROM settings WHERE key = 'overdue_reminders'")).rows[0];
  const p = reminderSettingsSchema.safeParse(r?.value);
  return p.success ? p.data : DEFAULTS;
}

export async function updateReminderSettings(ctx: AppContext, actor: User, input: unknown, ip: string | null): Promise<ReminderSettings> {
  requirePermission(actor, "masterdata.manage");
  const p = reminderSettingsSchema.safeParse(input);
  if (!p.success) throw new AppError(400, "VALIDATION", p.error.issues[0]?.message ?? "Invalid settings.");
  await ctx.db.tx(async (q) => {
    const before = await getReminderSettings(q);
    await q.query(
      `INSERT INTO settings (key, value, updated_by, updated_at) VALUES ('overdue_reminders', $1::jsonb, $2, $3)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at`,
      [JSON.stringify(p.data), actor.id, ctx.now()],
    );
    await writeAudit(q, { actorId: actor.id, action: "settings.overdue_reminders", entity: "settings", entityId: "overdue_reminders", before, after: p.data, ip });
  });
  return p.data;
}

/** Which reminder (1, 2, …) is due for an issue `daysOverdue` days late; 0 = none yet. */
export function reminderNumberFor(daysOverdue: number, s: ReminderSettings): number {
  if (s.max === 0 || daysOverdue < Math.max(1, s.firstAfterDays)) return 0;
  return Math.min(s.max, Math.floor((daysOverdue - Math.max(1, s.firstAfterDays)) / s.everyDays) + 1);
}

export async function runOverdueReminders(ctx: AppContext) {
  const now = ctx.now();
  const today = todayIST(now);
  const emailIds = await ctx.db.tx(async (q) => {
    const s = await getReminderSettings(q);
    const overdue = (await q.query<{
      id: string; ref: string; due_date: string; recipient_email: string; recipient_name: string | null; issuer_email: string; issuer_name: string | null;
    }>(
      `SELECT i.id, i.ref, i.due_date::text AS due_date, ru.email AS recipient_email, ru.name AS recipient_name,
              ib.email AS issuer_email, coalesce(ib.name, ib.email) AS issuer_name
         FROM issues i JOIN users ru ON ru.id = i.recipient_id JOIN users ib ON ib.id = i.issued_by
        WHERE i.status = 'ISSUED' AND i.due_date < $1::date ORDER BY i.id FOR UPDATE OF i SKIP LOCKED`,
      [today],
    )).rows;
    const ids: (string | null)[] = [];
    for (const i of overdue) {
      const days = daysBetween(i.due_date, today);
      const no = reminderNumberFor(days, s);
      if (no === 0) continue;
      const ins = await q.query("INSERT INTO reminders_sent (issue_id, reminder_no, queued_at) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING issue_id", [i.id, no, now]);
      if (!ins.rowCount) continue;
      const lines = (await q.query<{ code: string; name: string; qty: number; unit: string }>(
        "SELECT it.code, it.name, l.qty, it.unit FROM issue_lines l JOIN items it ON it.id = l.item_id WHERE l.issue_id = $1 ORDER BY l.id",
        [i.id],
      )).rows;
      const data = {
        ref: i.ref, recipientName: i.recipient_name ?? i.recipient_email, dueDate: i.due_date, daysOverdue: days, issuedByName: i.issuer_name ?? i.issuer_email,
        reminderNo: no, final: no === s.max, lines, appOrigin: ctx.config.APP_ORIGIN,
      };
      ids.push(await enqueue(q, { dedupeKey: `overdue:${i.id}:${no}`, kind: "overdue.recipient", to: i.recipient_email, ...overdueEmail(data, "recipient"), entity: "issue", entityId: i.id }, now));
      if (data.final && i.issuer_email !== i.recipient_email) {
        ids.push(await enqueue(q, { dedupeKey: `overdue:${i.id}:${no}:issuer`, kind: "overdue.issuer", to: i.issuer_email, ...overdueEmail(data, "issuer"), entity: "issue", entityId: i.id }, now));
      }
    }
    return { ids, overdueCount: overdue.length };
  });
  const queued = emailIds.ids.filter((x): x is string => x !== null);
  const sent = queued.length ? await dispatch(ctx, { onlyIds: queued, limit: queued.length }) : { sent: 0, failed: 0, retrying: 0, deferred: false };
  return { overdueIssues: emailIds.overdueCount, remindersQueued: queued.length, sent: sent.sent };
}
