import Link from "next/link";
import { RequestStatus } from "@/components/RequestStatus";
import { requirePermissionPage } from "@/server/next-session";
import { listRequests } from "@/server/requests/requests";
import { getAppContext } from "@/server/runtime";
import { formatDate, formatDateTimeIST } from "@/server/time";
import { CancelButton } from "./CancelButton";

export const dynamic = "force-dynamic";

export default async function MyPage({ searchParams }: { searchParams: Promise<{ sent?: string }> }) {
  const user = await requirePermissionPage("request.create");
  const sp = await searchParams;
  const all = await listRequests(getAppContext(), user, { mine: "1", limit: 200 });
  const pending = all.filter((r) => r.status === "PENDING");
  const holding = all.filter((r) => r.status === "ISSUED");
  const past = all.filter((r) => !["PENDING", "ISSUED"].includes(r.status));
  const items = (r: (typeof all)[number], issued: boolean) =>
    r.lines.filter((l) => !issued || (l.qtyIssued ?? 0) > 0).map((l) => `${issued ? l.qtyIssued : l.qtyRequested} × ${l.name}`).join(", ");

  return (
    <>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h1 style={{ margin: 0 }}>My requests & equipment</h1>
        <Link className="button" href="/browse">New request</Link>
      </div>
      {sp.sent && <p className="success" role="status">Request sent. You will get an email when it is decided.</p>}

      <h2>Equipment I hold</h2>
      {holding.length === 0 ? <p className="muted">Nothing issued to you right now.</p> : (
        <table>
          <thead><tr><th>Issue</th><th>Items</th><th>Due back</th></tr></thead>
          <tbody>
            {holding.map((r) => (
              <tr key={r.id}>
                <td data-label="Issue">{r.issue!.ref}{r.groupName ? <span className="muted"> · {r.groupName}</span> : null}</td>
                <td data-label="Items">{items(r, true)}</td>
                <td data-label="Due back" className={r.issue!.overdue ? "error" : undefined}>
                  {formatDate(r.issue!.dueDate)}{r.issue!.overdue && ` — overdue by ${r.issue!.daysOverdue} day${r.issue!.daysOverdue === 1 ? "" : "s"}`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2>Waiting for a decision</h2>
      {pending.length === 0 ? <p className="muted">No pending requests.</p> : (
        <table>
          <thead><tr><th>Request</th><th>Items</th><th>Return by</th><th>Sent</th><th></th></tr></thead>
          <tbody>
            {pending.map((r) => (
              <tr key={r.id}>
                <td data-label="Request">{r.ref}{r.ready && <> <span className="badge">Ready at the store</span></>}</td>
                <td data-label="Items">{items(r, false)}</td>
                <td data-label="Return by">{formatDate(r.expectedReturn)}</td>
                <td data-label="Sent">{formatDateTimeIST(r.createdAt)}</td>
                <td><CancelButton id={r.id} refText={r.ref} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2>History</h2>
      {past.length === 0 ? <p className="muted">No past requests.</p> : (
        <table>
          <thead><tr><th>Request</th><th>Status</th><th>Items</th><th>Details</th></tr></thead>
          <tbody>
            {past.map((r) => (
              <tr key={r.id}>
                <td data-label="Request">{r.ref}{r.issue ? ` / ${r.issue.ref}` : ""}</td>
                <td data-label="Status"><RequestStatus status={r.status} /></td>
                <td data-label="Items">{items(r, r.status === "RETURNED")}</td>
                <td data-label="Details">{r.rejectReason ?? (r.decidedAt ? formatDateTimeIST(r.decidedAt) : "")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
