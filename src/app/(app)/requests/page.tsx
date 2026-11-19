import Link from "next/link";
import { RequestStatus } from "@/components/RequestStatus";
import { requirePermissionPage } from "@/server/next-session";
import { listRequests } from "@/server/requests/requests";
import { getAppContext } from "@/server/runtime";
import { formatDate, formatDateTimeIST } from "@/server/time";

export const dynamic = "force-dynamic";

const TABS = [
  { key: "PENDING", label: "Pending" },
  { key: "ISSUED", label: "Issued" },
  { key: "OVERDUE", label: "Overdue" },
  { key: "CLOSED", label: "Closed" },
] as const;

export default async function RequestsPage({ searchParams }: { searchParams: Promise<{ tab?: string; q?: string }> }) {
  const user = await requirePermissionPage("request.markReady");
  const sp = await searchParams;
  const tab = TABS.find((t) => t.key === sp.tab)?.key ?? "PENDING";
  const ctx = getAppContext();
  const [rows, pendingCount, overdueCount] = await Promise.all([
    listRequests(ctx, user, { status: tab, q: sp.q || undefined, limit: 200 }),
    listRequests(ctx, user, { status: "PENDING", limit: 500 }).then((r) => r.length),
    listRequests(ctx, user, { status: "OVERDUE", limit: 500 }).then((r) => r.length),
  ]);
  const count = (k: string) => (k === "PENDING" ? ` (${pendingCount})` : k === "OVERDUE" ? ` (${overdueCount})` : "");

  return (
    <>
      <h1>Requests & issues</h1>
      <div className="row" style={{ marginBottom: "0.75rem" }}>
        {TABS.map((t) => (
          <Link key={t.key} href={`/requests?tab=${t.key}`} className={t.key === tab ? "button" : "button secondary"}>
            {t.label}{count(t.key)}
          </Link>
        ))}
        <form style={{ marginLeft: "auto" }}>
          <input type="hidden" name="tab" value={tab} />
          <input name="q" defaultValue={sp.q ?? ""} placeholder="Search ref, name, reg. no." aria-label="Search" style={{ maxWidth: 260 }} />
        </form>
      </div>
      <table>
        <thead>
          <tr>
            <th>Reference</th>
            <th>Recipient</th>
            <th>Items</th>
            <th>{tab === "PENDING" ? "Return by" : "Due back"}</th>
            <th>{tab === "PENDING" ? "Requested" : "Status"}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td data-label="Reference">
                <Link href={`/requests/${r.id}`}>{r.issue?.ref ?? r.ref}</Link>
                {r.ready && r.status === "PENDING" && <> <span className="badge">Ready</span></>}
              </td>
              <td data-label="Recipient">
                {r.requester.name} <span className="muted">{r.requester.univId}</span>
                {r.groupName && <div className="muted">for {r.groupName}</div>}
              </td>
              <td data-label="Items">
                {r.lines
                  .filter((l) => r.status === "PENDING" || r.status === "REJECTED" || r.status === "CANCELLED" || (l.qtyIssued ?? 0) > 0)
                  .map((l) => `${r.status === "PENDING" || l.qtyIssued === null ? l.qtyRequested : l.qtyIssued} × ${l.name}`)
                  .join(", ")}
              </td>
              <td data-label="Due" className={r.issue?.overdue ? "error" : undefined}>
                {formatDate(r.issue?.dueDate ?? r.expectedReturn)}
                {r.issue?.overdue && ` (${r.issue.daysOverdue} d late)`}
              </td>
              <td data-label="Status">
                {tab === "PENDING" ? formatDateTimeIST(r.createdAt) : <RequestStatus status={r.status} overdue={r.issue?.overdue} />}
              </td>
            </tr>
          ))}
          {rows.length === 0 && <tr><td colSpan={5} className="muted">Nothing here.</td></tr>}
        </tbody>
      </table>
    </>
  );
}
