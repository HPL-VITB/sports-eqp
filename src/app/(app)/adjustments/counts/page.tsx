import Link from "next/link";
import { AdjustmentTabs } from "@/components/AdjustmentTabs";
import { listCounts } from "@/server/adjustments/verification";
import { can } from "@/server/auth/permissions";
import { listCategories, listLocations, listSports } from "@/server/inventory/masterdata";
import { requirePermissionPage } from "@/server/next-session";
import { getAppContext } from "@/server/runtime";
import { formatDateTimeIST } from "@/server/time";
import { StartCount } from "./StartCount";

export const dynamic = "force-dynamic";

export default async function CountsPage() {
  const user = await requirePermissionPage("incident.report");
  const ctx = getAppContext();
  const [counts, sports, categories, locations] = await Promise.all([listCounts(ctx, user), listSports(ctx, user), listCategories(ctx, user), listLocations(ctx, user)]);
  const sportName = new Map(sports.map((s) => [s.id, s.name]));
  return (
    <>
      <h1>Adjustments & discards</h1>
      <AdjustmentTabs active="/adjustments/counts" />
      <p className="muted">
        Count what is physically on the shelf: usable and damaged units. Issued and missing equipment is shown for information and is
        never counted as a shortage. Differences become corrections for FR Sports to approve.
      </p>
      {can(user.role, "verification.count") && (
        <StartCount
          sports={sports.map((s) => ({ id: s.id, name: s.name }))}
          categories={categories.map((c) => ({ id: c.id, name: `${sportName.get(c.sport_id) ?? ""} › ${c.name}` }))}
          locations={locations.map((l) => ({ id: l.id, name: l.path }))}
        />
      )}
      <table>
        <thead><tr><th>Count</th><th>What</th><th>Started</th><th>Status</th><th style={{ textAlign: "right" }}>Items counted</th><th style={{ textAlign: "right" }}>Differences</th></tr></thead>
        <tbody>
          {counts.map((c) => (
            <tr key={c.id}>
              <td data-label="Count"><Link href={`/adjustments/counts/${c.id}`}>#{c.id}</Link></td>
              <td data-label="What">{c.scope_label}</td>
              <td data-label="Started">{formatDateTimeIST(c.started_at)}<div className="muted">{c.started_by}</div></td>
              <td data-label="Status">{c.status === "OPEN" ? "In progress" : c.status === "SUBMITTED" ? `Submitted ${formatDateTimeIST(c.submitted_at!)}` : "Abandoned"}</td>
              <td data-label="Counted" style={{ textAlign: "right" }}>{c.counted} / {c.lines}</td>
              <td data-label="Differences" style={{ textAlign: "right" }}>{c.status === "SUBMITTED" ? c.discrepancies : "—"}</td>
            </tr>
          ))}
          {counts.length === 0 && <tr><td colSpan={6} className="muted">No counts yet.</td></tr>}
        </tbody>
      </table>
    </>
  );
}
