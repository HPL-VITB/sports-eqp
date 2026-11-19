import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { AppError } from "@/server/errors";
import { listCategories, listSports } from "@/server/inventory/masterdata";
import { requirePermissionPage } from "@/server/next-session";
import { runReport } from "@/server/reports/reports";
import { getAppContext } from "@/server/runtime";
import { formatDateTimeIST } from "@/server/time";
import { PrintButton } from "./PrintButton";

export const dynamic = "force-dynamic";

const OPTIONS: Record<string, { name: string; label: string; options: [string, string][] }> = {
  itemStatus: { name: "itemStatus", label: "Items", options: [["active", "Active"], ["inactive", "Deactivated"], ["all", "All"]] },
  issueStatus: { name: "issueStatus", label: "Status", options: [["all", "All"], ["open", "Still issued"], ["overdue", "Overdue"], ["returned", "Returned"]] },
  incidentType: { name: "incidentType", label: "Type", options: [["", "All"], ["DAMAGED", "Returned damaged"], ["STORE_DAMAGE", "Damaged in store"], ["MISSING", "Missing"], ["CONSUMED", "Used up"]] },
  openClosed: { name: "openClosed", label: "Status", options: [["all", "All"], ["open", "Open"], ["closed", "Resolved"]] },
  decisionStatus: { name: "decisionStatus", label: "Decision", options: [["", "All"], ["PENDING", "Pending"], ["APPROVED", "Approved"], ["REJECTED", "Rejected"], ["CANCELLED", "Cancelled"]] },
};

export default async function ReportPage({ params, searchParams }: { params: Promise<{ key: string }>; searchParams: Promise<Record<string, string>> }) {
  const user = await requirePermissionPage("reports.view");
  const { key } = await params;
  const sp = await searchParams;
  const ctx = getAppContext();
  let r;
  try {
    r = await runReport(ctx, user, key, sp);
  } catch (e) {
    if (e instanceof AppError && e.status === 404) notFound();
    if (e instanceof AppError && e.status === 403) redirect("/forbidden");
    if (e instanceof AppError && e.code === "VALIDATION") {
      return (<><p><Link href={`/reports/${key}`}>← Reset filters</Link></p><p className="error">{e.message}</p></>);
    }
    throw e;
  }
  const [sports, categories] = await Promise.all([
    r.filters.includes("sport") || r.filters.includes("category") ? listSports(ctx, user) : [],
    r.filters.includes("category") ? listCategories(ctx, user) : [],
  ]);
  const qs = new URLSearchParams(Object.entries(sp).filter(([k, v]) => v && k !== "format"));
  const exportHref = (format: string) => `/api/reports/${key}?${new URLSearchParams([...qs, ["format", format]])}`;

  return (
    <>
      <p className="no-print"><Link href="/reports">← Reports</Link></p>
      <h1>{r.title}</h1>
      <p className="muted">{r.description} Generated {formatDateTimeIST(ctx.now())} IST.</p>

      <form className="panel row" method="get">
        {r.filters.includes("dates") && (
          <>
            <label className="row" style={{ margin: 0, fontWeight: 400 }}>From <input type="date" name="from" defaultValue={r.applied.from} style={{ maxWidth: 160 }} /></label>
            <label className="row" style={{ margin: 0, fontWeight: 400 }}>To <input type="date" name="to" defaultValue={r.applied.to} style={{ maxWidth: 160 }} /></label>
          </>
        )}
        {r.filters.includes("sport") && (
          <select name="sportId" defaultValue={sp.sportId ?? ""} aria-label="Sport" style={{ maxWidth: 170 }}>
            <option value="">All sports</option>
            {sports.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        )}
        {r.filters.includes("category") && (
          <select name="categoryId" defaultValue={sp.categoryId ?? ""} aria-label="Category" style={{ maxWidth: 200 }}>
            <option value="">All categories</option>
            {categories.map((c) => <option key={c.id} value={c.id}>{sports.find((s) => s.id === c.sport_id)?.name} › {c.name}</option>)}
          </select>
        )}
        {r.filters.filter((f) => OPTIONS[f]).map((f) => {
          const o = OPTIONS[f]!;
          return (
            <select key={f} name={o.name} defaultValue={sp[o.name] ?? o.options[0]![0]} aria-label={o.label} style={{ maxWidth: 170 }}>
              {o.options.map(([v, l]) => <option key={v} value={v}>{o.label}: {l}</option>)}
            </select>
          );
        })}
        {r.filters.includes("q") && <input name="q" defaultValue={sp.q ?? ""} placeholder="Search" aria-label="Search" style={{ maxWidth: 200 }} />}
        <button type="submit">Apply</button>
      </form>

      <div className="row no-print" style={{ marginBottom: "0.75rem" }}>
        <a className="button secondary" href={exportHref("xlsx")}>Download Excel</a>
        <a className="button secondary" href={exportHref("pdf")}>Download PDF</a>
        <PrintButton />
        <span className="muted">{r.totalRows} row(s){r.truncated && ` — showing the first ${r.rows.length}; downloads include all`}</span>
      </div>

      <div style={{ overflowX: "auto" }}>
        <table>
          <thead>
            <tr>{r.columns.map((c) => <th key={c.key} style={{ textAlign: c.align ?? "left" }}>{c.label}</th>)}</tr>
          </thead>
          <tbody>
            {r.rows.map((row, i) => (
              <tr key={i}>
                {row.map((cell, j) => (
                  <td key={j} data-label={r.columns[j]!.label} style={{ textAlign: r.columns[j]!.align ?? "left" }}>{cell ?? ""}</td>
                ))}
              </tr>
            ))}
            {r.rows.length === 0 && <tr><td colSpan={r.columns.length} className="muted">No records match these filters.</td></tr>}
            {r.totals && r.rows.length > 0 && (
              <tr style={{ fontWeight: 600 }}>
                {r.totals.map((t, i) => (
                  <td key={i} data-label={r.columns[i]!.label} style={{ textAlign: r.columns[i]!.align ?? "left" }}>{i === 0 ? "Total" : t ?? ""}</td>
                ))}
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
