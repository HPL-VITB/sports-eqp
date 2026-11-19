import Link from "next/link";
import { requirePermissionPage } from "@/server/next-session";
import { listRequests } from "@/server/requests/requests";
import { getAppContext } from "@/server/runtime";
import { formatDate } from "@/server/time";

export const dynamic = "force-dynamic";

export default async function ReturnsPage({ searchParams }: { searchParams: Promise<{ q?: string; done?: string }> }) {
  const user = await requirePermissionPage("return.record");
  const sp = await searchParams;
  const open = await listRequests(getAppContext(), user, { status: "ISSUED", q: sp.q || undefined, limit: 200 });
  return (
    <>
      <h1>Returns</h1>
      {sp.done && <p className="success" role="status">Return of {sp.done} recorded. Confirmation emails are on their way.</p>}
      <form className="row" style={{ marginBottom: "0.75rem" }}>
        <input name="q" defaultValue={sp.q ?? ""} placeholder="Issue reference, name or registration no." aria-label="Search" style={{ maxWidth: 360 }} autoFocus />
        <button type="submit">Find</button>
      </form>
      <p className="muted">Equipment currently issued, earliest due first. Only full returns can be recorded: every unit back, damaged, missing or used up.</p>
      <table>
        <thead><tr><th>Issue</th><th>Recipient</th><th>Items</th><th>Due back</th><th></th></tr></thead>
        <tbody>
          {open.map((r) => (
            <tr key={r.id}>
              <td data-label="Issue">{r.issue!.ref}</td>
              <td data-label="Recipient">
                {r.requester.name} <span className="muted">{r.requester.univId}</span>
                {r.groupName && <div className="muted">for {r.groupName}</div>}
              </td>
              <td data-label="Items">{r.lines.filter((l) => (l.qtyIssued ?? 0) > 0).map((l) => `${l.qtyIssued} × ${l.name}`).join(", ")}</td>
              <td data-label="Due back" className={r.issue!.overdue ? "error" : undefined}>
                {formatDate(r.issue!.dueDate)}{r.issue!.overdue && ` (${r.issue!.daysOverdue} d late)`}
              </td>
              <td><Link className="button" href={`/returns/${r.issue!.id}`}>Record return</Link></td>
            </tr>
          ))}
          {open.length === 0 && <tr><td colSpan={5} className="muted">{sp.q ? "No open issue matches." : "Nothing is out on issue."}</td></tr>}
        </tbody>
      </table>
    </>
  );
}
