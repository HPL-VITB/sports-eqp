import Link from "next/link";
import { requirePermissionPage } from "@/server/next-session";
import { reportsFor } from "@/server/reports/reports";

export const dynamic = "force-dynamic";

export default async function ReportsPage() {
  const user = await requirePermissionPage("reports.view");
  const reports = reportsFor(user);
  return (
    <>
      <h1>Reports</h1>
      <p className="muted">Each report can be filtered, printed, or downloaded as Excel or PDF.</p>
      <div className="cols2">
        {reports.map((r) => (
          <Link key={r.key} href={`/reports/${r.key}`} className="panel" style={{ textDecoration: "none", color: "inherit", margin: 0 }}>
            <strong>{r.title}</strong>
            <p className="muted" style={{ margin: "0.25rem 0 0" }}>{r.description}</p>
          </Link>
        ))}
      </div>
    </>
  );
}
