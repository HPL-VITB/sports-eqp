import { requirePermissionPage } from "@/server/next-session";
import { listNotifications, notificationCounts } from "@/server/notify/outbox";
import { getAppContext } from "@/server/runtime";
import { formatDateTimeIST } from "@/server/time";
import { getReminderSettings } from "@/server/returns/reminders";
import { ReminderSettings } from "./ReminderSettings";
import { ResendButton } from "./ResendButton";

export const dynamic = "force-dynamic";

const LABEL: Record<string, string> = { QUEUED: "Waiting / retrying", SENDING: "Sending", SENT: "Accepted by mail server", FAILED: "Failed" };

export default async function EmailsPage({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const user = await requirePermissionPage("users.manage");
  const sp = await searchParams;
  const ctx = getAppContext();
  const [emails, counts, reminders] = await Promise.all([
    listNotifications(ctx, user, { status: sp.status, limit: 200 }),
    notificationCounts(ctx.db),
    getReminderSettings(ctx.db),
  ]);
  return (
    <>
      <h1>Email delivery</h1>
      <p className="muted">
        Issue, return and reminder emails. Failures never affect stock records. Emails that fail are retried automatically for
        about 5 hours, then shown here as Failed.
      </p>
      <ReminderSettings initial={reminders} />
      <div className="row" style={{ marginBottom: "0.75rem" }}>
        <a className={!sp.status ? "button" : "button secondary"} href="/admin/emails">All</a>
        {(["FAILED", "QUEUED", "SENT"] as const).map((s) => (
          <a key={s} className={sp.status === s ? "button" : "button secondary"} href={`/admin/emails?status=${s}`}>
            {LABEL[s]} ({counts[s]})
          </a>
        ))}
      </div>
      <table>
        <thead><tr><th>Created (IST)</th><th>To</th><th>Subject</th><th>Status</th><th>Attempts</th><th></th></tr></thead>
        <tbody>
          {emails.map((e) => (
            <tr key={e.id}>
              <td data-label="Created">{formatDateTimeIST(e.createdAt)}</td>
              <td data-label="To">{e.to}</td>
              <td data-label="Subject">{e.subject}</td>
              <td data-label="Status" className={e.status === "FAILED" ? "error" : undefined}>
                {LABEL[e.status] ?? e.status}
                {e.sentAt && <div className="muted">{formatDateTimeIST(e.sentAt)}</div>}
                {e.lastError && e.status !== "SENT" && <div className="muted">{e.lastError}</div>}
              </td>
              <td data-label="Attempts">{e.attempts}</td>
              <td>{(e.status === "FAILED" || e.status === "QUEUED") && <ResendButton id={e.id} />}</td>
            </tr>
          ))}
          {emails.length === 0 && <tr><td colSpan={6} className="muted">No emails.</td></tr>}
        </tbody>
      </table>
    </>
  );
}
