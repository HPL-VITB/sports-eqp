import Link from "next/link";
import { can, ROLE_LABELS } from "@/server/auth/permissions";
import { requirePermissionPage } from "@/server/next-session";
import { getDashboard } from "@/server/reports/dashboard";
import { getAppContext } from "@/server/runtime";
import { formatDate, formatDateTimeIST } from "@/server/time";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const user = await requirePermissionPage("dashboard.view");
  const d = await getDashboard(getAppContext(), user);
  const canSeeRequests = can(user.role, "request.markReady");
  const reqLink = (id: string) => (canSeeRequests ? `/requests/${id}` : undefined);
  const s = d.stock;
  return (
    <>
      <h1>Dashboard</h1>
      <p className="muted">{user.name} · {ROLE_LABELS[user.role]} · {formatDate(d.today)}</p>

      <div className="kpis">
        <div className="kpi"><span className="muted">Available to issue</span><b>{s.available}</b>{s.held > 0 && <span className="muted">{s.held} held for discard</span>}</div>
        <div className="kpi"><span className="muted">Issued</span><b>{s.issued}</b><span className="muted">{d.counts.openIssues} open issue(s)</span></div>
        <div className="kpi"><span className="muted">Damaged</span><b>{s.damaged}</b></div>
        <div className="kpi"><span className="muted">Missing</span><b>{s.missing}</b></div>
        <div className={`kpi${d.counts.overdueIssues ? " alert" : ""}`}><span className="muted">Overdue issues</span><b>{d.counts.overdueIssues}</b></div>
        <div className="kpi"><span className="muted">Pending requests</span><b>{d.counts.pendingRequests}</b></div>
        <div className={`kpi${d.counts.lowStock ? " alert" : ""}`}><span className="muted">Low-stock items</span><b>{d.counts.lowStock}</b></div>
      </div>
      <p className="muted">{s.items} active items · {s.accountable} units accountable in total</p>

      {d.actions.length > 0 && (
        <div className="panel">
          <strong>Needs your action</strong>
          <ul style={{ margin: "0.5rem 0 0", paddingLeft: "1.2rem" }}>
            {d.actions.map((a) => <li key={a.label}><Link href={a.href}>{a.label}: {a.count}</Link></li>)}
          </ul>
        </div>
      )}

      <div className="cols2">
        <section>
          <h2>Overdue</h2>
          {d.overdue.length === 0 ? <p className="muted">Nothing overdue.</p> : (
            <table>
              <tbody>
                {d.overdue.map((o) => (
                  <tr key={o.ref}>
                    <td data-label="Issue">{reqLink(o.request_id) ? <Link href={reqLink(o.request_id)!}>{o.ref}</Link> : o.ref}</td>
                    <td data-label="Recipient">{o.recipient} <span className="muted">{o.univ_id}</span><div className="muted">{o.items}</div></td>
                    <td data-label="Late" className="error">{o.days} d</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
        <section>
          <h2>Pending requests</h2>
          {d.pending.length === 0 ? <p className="muted">No pending requests.</p> : (
            <table>
              <tbody>
                {d.pending.map((p) => (
                  <tr key={p.ref}>
                    <td data-label="Request">{reqLink(p.id) ? <Link href={reqLink(p.id)!}>{p.ref}</Link> : p.ref}{p.ready && <> <span className="badge">Ready</span></>}</td>
                    <td data-label="By">{p.requester}<div className="muted">{p.items}</div></td>
                    <td data-label="Sent" className="muted">{formatDateTimeIST(p.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
        <section>
          <h2>Recent issues</h2>
          {d.recentIssues.length === 0 ? <p className="muted">None yet.</p> : (
            <table><tbody>{d.recentIssues.map((r) => (
              <tr key={r.ref}><td>{reqLink(r.request_id) ? <Link href={reqLink(r.request_id)!}>{r.ref}</Link> : r.ref}</td><td>{r.recipient}</td><td className="muted">{formatDateTimeIST(r.at)} · due {formatDate(r.due_date)}</td></tr>
            ))}</tbody></table>
          )}
        </section>
        <section>
          <h2>Recent returns</h2>
          {d.recentReturns.length === 0 ? <p className="muted">None yet.</p> : (
            <table><tbody>{d.recentReturns.map((r) => (
              <tr key={r.ref}><td>{can(user.role, "return.record") ? <Link href={`/returns/${r.issue_id}`}>{r.ref}</Link> : r.ref}</td><td>{r.recipient}{r.problems && <> <span className="badge">damage / missing</span></>}</td><td className="muted">{formatDateTimeIST(r.at)}</td></tr>
            ))}</tbody></table>
          )}
        </section>
        <section>
          <h2>Low stock</h2>
          {d.lowStock.length === 0 ? <p className="muted">Nothing below its minimum.</p> : (
            <table><tbody>{d.lowStock.map((l) => (
              <tr key={l.id}><td><Link href={`/inventory/${l.id}`}>{l.name}</Link> <span className="muted">{l.code}</span></td><td className="error">{l.available} of min. {l.min_stock}</td></tr>
            ))}</tbody></table>
          )}
        </section>
        <section>
          <h2>By sport</h2>
          <table>
            <thead><tr><th>Sport</th><th style={{ textAlign: "right" }}>Items</th><th style={{ textAlign: "right" }}>Available</th><th style={{ textAlign: "right" }}>Issued</th><th style={{ textAlign: "right" }}>Damaged</th><th style={{ textAlign: "right" }}>Missing</th></tr></thead>
            <tbody>{d.bySport.map((x) => (
              <tr key={x.id}>
                <td data-label="Sport"><Link href={`/inventory?sportId=${x.id}`}>{x.name}</Link></td>
                <td data-label="Items" style={{ textAlign: "right" }}>{x.items}</td>
                <td data-label="Available" style={{ textAlign: "right" }}>{x.available}</td>
                <td data-label="Issued" style={{ textAlign: "right" }}>{x.issued}</td>
                <td data-label="Damaged" style={{ textAlign: "right" }}>{x.damaged}</td>
                <td data-label="Missing" style={{ textAlign: "right" }}>{x.missing}</td>
              </tr>
            ))}</tbody>
          </table>
          {d.byLocation.length > 1 && (
            <>
              <h2>By location</h2>
              <table><tbody>{d.byLocation.map((x) => (
                <tr key={x.id}><td>{x.name}</td><td style={{ textAlign: "right" }}>{x.items} items</td><td style={{ textAlign: "right" }}>{x.available} available</td><td style={{ textAlign: "right" }}>{x.damaged} damaged</td></tr>
              ))}</tbody></table>
            </>
          )}
        </section>
      </div>
    </>
  );
}
