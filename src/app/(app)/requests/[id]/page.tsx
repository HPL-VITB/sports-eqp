import Link from "next/link";
import { notFound } from "next/navigation";
import { RequestStatus } from "@/components/RequestStatus";
import { can, CATEGORY_LABELS, type Category } from "@/server/auth/permissions";
import { AppError } from "@/server/errors";
import { requirePermissionPage } from "@/server/next-session";
import { getRequest, issuerOptions, MAX_LOAN_DAYS } from "@/server/requests/requests";
import { getAppContext } from "@/server/runtime";
import { addDays, formatDate, formatDateTimeIST, todayIST } from "@/server/time";
import { RequestActions } from "./RequestActions";

export const dynamic = "force-dynamic";

export default async function RequestPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requirePermissionPage("request.markReady");
  const { id } = await params;
  const ctx = getAppContext();
  let r;
  try {
    r = await getRequest(ctx, user, id);
  } catch (e) {
    if (e instanceof AppError && e.status === 404) notFound();
    throw e;
  }
  const canApprove = can(user.role, "request.approveIssue");
  const ownRequest = r.requester.id === user.id;
  const issuers = canApprove ? await issuerOptions(ctx, user) : [];
  const today = todayIST(ctx.now());

  return (
    <>
      <p><Link href="/requests">← Requests & issues</Link></p>
      <h1>
        {r.issue ? r.issue.ref : r.ref} <RequestStatus status={r.status} overdue={r.issue?.overdue} />
      </h1>
      <div className="panel">
        <div className="grid2">
          <div>
            <strong>{r.requester.name}</strong>
            <div className="muted">
              {r.requester.univId} · {r.requester.category ? CATEGORY_LABELS[r.requester.category as Category] : ""} · {r.requester.email}
            </div>
            {r.groupName && <div>For: {r.groupName} (accountable: {r.requester.name})</div>}
          </div>
          <div>
            <div>Purpose: {r.purpose}</div>
            <div>Requested {formatDateTimeIST(r.createdAt)} ({r.ref}), return by {formatDate(r.expectedReturn)}</div>
            {r.ready && r.status === "PENDING" && <div>Set aside and ready (by {r.readyBy})</div>}
          </div>
        </div>
      </div>

      {r.issue && (
        <div className="panel">
          Issued {formatDateTimeIST(r.issue.issuedAt)} by <strong>{r.issue.issuedBy}</strong>, approved by <strong>{r.issue.approvedBy}</strong>.
          Due back <strong className={r.issue.overdue ? "error" : undefined}>{formatDate(r.issue.dueDate)}</strong>
          {r.issue.overdue && ` — ${r.issue.daysOverdue} day(s) overdue`}.
        </div>
      )}
      {r.status === "REJECTED" && <div className="panel">Rejected by {r.decidedBy}: {r.rejectReason}</div>}
      {r.status === "CANCELLED" && <div className="panel">Cancelled by the requester.</div>}

      {r.status === "PENDING" ? (
        <RequestActions
          request={r}
          canApprove={canApprove && !ownRequest}
          ownRequest={ownRequest}
          issuers={issuers}
          minDate={today}
          maxDate={addDays(today, MAX_LOAN_DAYS)}
          meId={user.id}
        />
      ) : (
        <table>
          <thead><tr><th>Code</th><th>Equipment</th><th style={{ textAlign: "right" }}>Requested</th><th style={{ textAlign: "right" }}>Issued</th></tr></thead>
          <tbody>
            {r.lines.map((l) => (
              <tr key={l.itemId}>
                <td data-label="Code"><Link href={`/inventory/${l.itemId}`}>{l.code}</Link></td>
                <td data-label="Equipment">{l.name}</td>
                <td data-label="Requested" style={{ textAlign: "right" }}>{l.qtyRequested}</td>
                <td data-label="Issued" style={{ textAlign: "right" }}>{l.qtyIssued ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
